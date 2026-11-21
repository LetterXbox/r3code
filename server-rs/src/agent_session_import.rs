//! Import discovered native transcripts into V2 projections and runtime state.
use crate::{
    agent_session_scan,
    event_bus::EventBus,
    event_store::{self, Event},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

struct Transcript {
    source: String,
    instance: String,
    native: String,
    path: PathBuf,
    cwd: String,
    title: String,
    model: String,
    created: String,
    updated: String,
    messages: Vec<(String, String, String)>,
    identity: Value,
    omitted: usize,
    worktree: Option<String>,
    branch: Option<String>,
}
fn text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_owned();
    }
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    if matches!(
                        v["type"].as_str(),
                        Some("text" | "input_text" | "output_text")
                    ) {
                        v["text"].as_str()
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
fn parse(source: &str, instance: &str, path: &Path, project: &str) -> Option<Transcript> {
    let metadata = fs::metadata(path).ok()?;
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        (json!(metadata.dev()), json!(metadata.ino().to_string()))
    };
    #[cfg(not(unix))]
    let (device, inode) = (Value::Null, Value::Null);
    let millis = |v: std::io::Result<std::time::SystemTime>| {
        v.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
    };
    let mut identity = json!({"provider":source,"providerInstanceId":instance,"providerSessionId":null,"filePath":path,"size":metadata.len(),"mtimeMs":millis(metadata.modified()),"device":device,"inode":inode,"birthtimeMs":millis(metadata.created())});
    let file = fs::File::open(path).ok()?;
    let reader: Box<dyn Read> = if path.extension().is_some_and(|v| v == "zst") {
        Box::new(zstd::stream::read::Decoder::new(file).ok()?)
    } else {
        Box::new(file)
    };
    let mut lines = BufReader::new(reader.take(32 * 1024 * 1024 + 1)).lines();
    let mut records = Vec::new();
    let mut bytes = 0usize;
    for _ in 0..100_001 {
        let Some(line) = lines.next() else { break };
        let line = line.ok()?;
        bytes = bytes.saturating_add(line.len() + 1);
        if bytes > 32 * 1024 * 1024 {
            return None;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            records.push(v)
        }
    }
    if records.len() > 100_000 {
        return None;
    }
    let after = fs::metadata(path).ok()?;
    if metadata.len() != after.len() || metadata.modified().ok() != after.modified().ok() {
        return None;
    }
    let cwd = records.iter().find_map(|v| {
        v.get("cwd")
            .or_else(|| v["payload"].get("cwd"))
            .and_then(Value::as_str)
    })?;
    let cwd_path = fs::canonicalize(cwd).ok()?;
    let (root, _) = agent_session_scan::project_directory(cwd_path.clone());
    if agent_session_scan::normalize_project_path(&root.to_string_lossy())
        != agent_session_scan::normalize_project_path(project)
    {
        return None;
    }
    let worktree = (cwd_path != root).then(|| cwd_path.to_string_lossy().into_owned());
    let branch = worktree
        .as_ref()
        .and_then(|path| {
            std::process::Command::new("git")
                .args(["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"])
                .output()
                .ok()
        })
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if source == "codex"
        && records.iter().any(|v| {
            v["type"] == "session_meta"
                && (v["payload"]["source"].get("subagent").is_some()
                    || v["payload"]["source"].get("subAgent").is_some())
        })
    {
        return None;
    }
    let fallback = path.file_stem()?.to_string_lossy().to_string();
    let native = if source == "codex" {
        records
            .iter()
            .find(|v| v["type"] == "session_meta")
            .and_then(|v| {
                v["payload"]["id"]
                    .as_str()
                    .or_else(|| v["payload"]["session_id"].as_str())
            })
            .unwrap_or("")
            .to_owned()
    } else if source == "pi" {
        records
            .iter()
            .find(|v| v["type"] == "session")
            .and_then(|v| v["id"].as_str())
            .unwrap_or(&fallback)
            .to_owned()
    } else {
        records
            .iter()
            .find_map(|v| v["sessionId"].as_str())
            .unwrap_or(&fallback)
            .to_owned()
    };
    identity["providerSessionId"] = json!(native);
    if native.is_empty() || (source == "claudeAgent" && uuid::Uuid::parse_str(&native).is_err()) {
        return None;
    }
    let updated = chrono::DateTime::<chrono::Utc>::from(metadata.modified().ok()?)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut messages: Vec<(String, String, String)> = Vec::new();
    let mut model = None;
    let mut title = None;
    let mut has_claude_synthetic_reply = false;
    let mut has_claude_model_reply = false;
    let mut sequence: Vec<&Value> = records.iter().collect();
    if source == "pi" {
        let entries: Vec<&Value> = records.iter().filter(|v| v["type"] != "session").collect();
        if entries.last().and_then(|v| v["id"].as_str()).is_some() {
            let by_id: std::collections::HashMap<&str, &Value> = entries
                .iter()
                .filter_map(|v| v["id"].as_str().map(|id| (id, *v)))
                .collect();
            let mut branch = Vec::new();
            let mut current = entries.last().copied();
            while let Some(v) = current {
                if branch.len() >= entries.len() {
                    break;
                }
                branch.push(v);
                current = v["parentId"].as_str().and_then(|id| by_id.get(id).copied());
            }
            branch.reverse();
            sequence = branch;
        }
        title = records
            .iter()
            .rev()
            .find(|v| v["type"] == "session_info")
            .and_then(|v| v["name"].as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned);
    }
    for v in sequence {
        if v["type"] == "turn_context" {
            model = v["payload"]["model"].as_str().map(str::to_owned)
        }
        if source == "claudeAgent" && v["type"] == "custom-title" {
            title = v["customTitle"].as_str().map(str::to_owned)
        }
        let (role, body) = if source == "codex"
            && v["type"] == "event_msg"
            && v["payload"]["type"] == "user_message"
        {
            (
                "user",
                v["payload"]["message"].as_str().unwrap_or("").to_owned(),
            )
        } else if source == "codex"
            && v["type"] == "response_item"
            && v["payload"]["type"] == "message"
        {
            (
                v["payload"]["role"].as_str().unwrap_or(""),
                text(&v["payload"]["content"]),
            )
        } else if source == "claudeAgent"
            && matches!(v["type"].as_str(), Some("user" | "assistant"))
            && v["isSidechain"] != true
            && v["isMeta"] != true
        {
            (
                v["type"].as_str().unwrap_or(""),
                text(&v["message"]["content"]),
            )
        } else if source == "pi" && v["type"] == "message" {
            (
                v["message"]["role"].as_str().unwrap_or(""),
                text(&v["message"]["content"]),
            )
        } else {
            continue;
        };
        if !matches!(role, "user" | "assistant") || body.trim().is_empty() {
            continue;
        }
        if source == "claudeAgent" && role == "assistant" {
            if v["message"]["model"].as_str().map(str::trim) == Some("<synthetic>") {
                has_claude_synthetic_reply = true;
            } else {
                has_claude_model_reply = true;
            }
        }
        if source == "codex"
            && role == "user"
            && messages
                .last()
                .is_some_and(|m| m.0 == "user" && m.1.trim() == body.trim())
        {
            continue;
        }
        let at = v["timestamp"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|v| {
                v.to_utc()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .unwrap_or_else(|| updated.clone());
        messages.push((role.into(), body, at));
    }
    let first = messages.iter().find(|m| m.0 == "user")?.clone();
    let omitted = messages.len().saturating_sub(200);
    if source == "claudeAgent"
        && omitted == 0
        && has_claude_synthetic_reply
        && !has_claude_model_reply
    {
        return None;
    }
    if messages.len() > 200 {
        let mut tail = messages.split_off(messages.len() - 199);
        tail.insert(0, first.clone());
        messages = tail;
    }
    let title = title.unwrap_or_else(|| {
        first
            .1
            .lines()
            .next()
            .unwrap_or("Imported thread")
            .chars()
            .take(100)
            .collect()
    });
    let created = messages[0].2.clone();
    let model = model.unwrap_or_else(|| {
        match source {
            "codex" => "gpt-6-astra",
            "claudeAgent" => "claude-opus-5-5",
            _ => "default",
        }
        .into()
    });
    Some(Transcript {
        source: source.into(),
        instance: instance.into(),
        native,
        path: path.to_owned(),
        cwd: cwd.into(),
        title,
        model,
        created,
        updated,
        messages,
        identity,
        omitted,
        worktree,
        branch,
    })
}
fn event(id: String, thread: &str, kind: &str, at: &str, payload: Value) -> Event {
    Event {
        id,
        aggregate_kind: "thread".into(),
        stream_id: thread.into(),
        event_type: kind.into(),
        occurred_at: at.into(),
        command_id: None,
        causation_event_id: None,
        correlation_id: None,
        actor_kind: "system".into(),
        payload,
        metadata: json!({}),
    }
}
fn import_mode(settings: &Value, project: &str) -> Result<String, String> {
    let Some((_, ceiling)) = crate::managed_policy::runtime_ceiling()? else {
        return Ok("full-access".into());
    };
    let modes = [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
    ];
    let ceiling = modes
        .iter()
        .position(|m| *m == ceiling)
        .ok_or("Invalid managed policy runtime ceiling")?;
    let configured = settings["projectSettingsOverrides"][project]["defaultRuntimeMode"]
        .as_str()
        .or_else(|| settings["defaultRuntimeMode"].as_str())
        .unwrap_or("approval-required");
    let configured = modes.iter().position(|m| *m == configured).unwrap_or(0);
    Ok(modes[configured.min(ceiling)].into())
}
fn persist(
    bus: &EventBus,
    project: &str,
    root: &str,
    mode: &str,
    t: &Transcript,
) -> Result<bool, String> {
    let thread = format!("import:{}:{}", t.instance, t.native);
    let native = if t.source == "pi" {
        t.path.to_string_lossy().into_owned()
    } else {
        t.native.clone()
    };
    let pt = format!(
        "provider-thread:provider:{}:provider-instance:{}:native-thread:{}",
        crate::message_commands::encode_id_part(&t.source),
        crate::message_commands::encode_id_part(&t.instance),
        crate::message_commands::encode_id_part(&native)
    );
    bus.commit(|tx|{
        let current:Option<String>=tx.query_row("SELECT workspace_root FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL",[project],|r|r.get(0)).optional()?;
        if current.as_deref().is_none_or(|value|agent_session_scan::normalize_project_path(value)!=agent_session_scan::normalize_project_path(root)){return Ok((false,vec![]));}
        let existing:Option<(String,String)>=tx.query_row("SELECT project_id,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[&thread],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((existing_project,payload))=existing {let payload:Value=serde_json::from_str(&payload).unwrap_or(Value::Null); let runtime:Option<String>=tx.query_row("SELECT runtime_payload_json FROM provider_session_runtime WHERE thread_id=?1",[&thread],|r|r.get(0)).optional()?.flatten(); let runtime:Value=runtime.and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null); let matched=runtime["importedTranscripts"].as_array().is_some_and(|v|v.contains(&t.identity));return Ok((existing_project==project && payload["historyOrigin"]=="v1_import" && matched,vec![]));}
        let owned:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1)",[&pt],|r|r.get(0))?;if owned{return Ok((false,vec![]));}
        let app=json!({"createdBy":"system","creationSource":"server","id":thread,"projectId":project,"title":t.title,"providerInstanceId":t.instance,"modelSelection":{"instanceId":t.instance,"model":t.model},"runtimeMode":mode,"interactionMode":"default","branch":t.branch,"worktreePath":t.worktree,"linkedPullRequest":null,"branchPullRequest":null,"activeProviderThreadId":pt,"historyOrigin":"v1_import","lineage":{"parentThreadId":null,"relationshipToParent":null,"rootThreadId":thread},"forkedFrom":null,"createdAt":t.created,"updatedAt":t.updated,"archivedAt":null,"settledOverride":"settled","settledAt":t.updated,"unsettledAt":null,"snoozedUntil":null,"snoozedAt":null,"pinnedAt":null,"pinOrderKey":null,"activeOrderKey":null,"lastVisitedAt":null,"deletedAt":null});
        let provider=json!({"id":pt,"driver":t.source,"providerInstanceId":t.instance,"providerSessionId":null,"appThreadId":thread,"ownerNodeId":null,"nativeThreadRef":{"driver":t.source,"nativeId":native,"strength":"strong"},"nativeConversationHeadRef":null,"status":"idle","firstRunOrdinal":null,"lastRunOrdinal":null,"handoffIds":[],"forkedFrom":null,"pendingBackgroundTasks":[],"createdAt":t.created,"updatedAt":t.updated});
        tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json) VALUES(?1,?2,?3,?4,?4,?5,'default',?6,?7,?8,NULL,NULL,?9)",params![thread,project,t.title,t.instance,mode,pt,t.created,t.updated,app.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,owner_node_id,provider,provider_instance_id,provider_session_id,status,first_run_ordinal,last_run_ordinal,updated_at,payload_json) VALUES(?1,?2,NULL,?3,?4,NULL,'idle',NULL,NULL,?5,?6)",params![pt,thread,t.source,t.instance,t.updated,provider.to_string()])?;
        let mut events=vec![event(format!("agent-session-import:v2:thread:{thread}:created"),&thread,"thread.created",&t.created,app)];
        if t.omitted>0 {
          let id=format!("agent-session-import:v2:history-truncated:{thread}");
          let notice=json!({"id":id,"threadId":thread,"runId":null,"nodeId":null,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":0,"status":"completed","title":null,"startedAt":t.created,"completedAt":t.created,"updatedAt":t.created,"type":"system_notice","message":format!("{} earlier {} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.",t.omitted,if t.omitted==1 {"message was"} else {"messages were"})});
          tx.execute("INSERT INTO orchestration_v2_turn_item_positions(thread_id,turn_item_id,ordinal) VALUES(?1,?2,0)",params![thread,id])?;
          tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,NULL,NULL,NULL,NULL,NULL,0,'system_notice','completed',?3,?4)",params![id,thread,t.created,notice.to_string()])?;
          events.push(event(id,&thread,"turn-item.updated",&t.created,notice));
        }
        for (index,(role,body,at)) in t.messages.iter().enumerate(){let suffix=format!("{index:06}");let mid=format!("{thread}:{suffix}");let iid=format!("agent-session-import:v2:turn-item:{thread}:{suffix}");let mut item=json!({"id":iid,"threadId":thread,"runId":null,"nodeId":null,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":index+1,"status":"completed","title":null,"startedAt":at,"completedAt":at,"updatedAt":at,"type":if role=="user"{"user_message"}else{"assistant_message"},"messageId":mid,"text":body});
          if role=="user"{item["createdBy"]=json!("user");item["creationSource"]=json!("server");item["inputIntent"]=json!("turn_start");item["attachments"]=json!([])}else{item["streaming"]=json!(false)}
          let msg=json!({"createdBy":if role=="user"{"user"}else{"agent"},"creationSource":"server","id":mid,"threadId":thread,"runId":null,"nodeId":null,"role":role,"text":body,"attachments":[],"streaming":false,"createdAt":at,"updatedAt":at});
          tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES(?1,?2,NULL,NULL,?3,0,?4,?4,?5)",params![mid,thread,role,at,msg.to_string()])?;
          tx.execute("INSERT INTO orchestration_v2_turn_item_positions(thread_id,turn_item_id,ordinal) VALUES(?1,?2,?3)",params![thread,iid,index as i64+1])?;
          tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,NULL,NULL,NULL,NULL,NULL,?3,?4,'completed',?5,?6)",params![iid,thread,index as i64+1,item["type"].as_str(),at,item.to_string()])?;
          events.push(event(format!("agent-session-import:v2:message:{mid}"),&thread,"message.updated",at,msg));events.push(event(iid,&thread,"turn-item.updated",at,item));
        }
        events.push(event(format!("agent-session-import:v2:provider-thread:{pt}"),&thread,"provider-thread.updated",&t.updated,provider));
        let cursor=if t.source=="claudeAgent"{json!({"threadId":thread,"resume":native})}else{json!({"threadId":native})};
        let payload=json!({"cwd":t.cwd,"importedTranscripts":[t.identity]});
        tx.execute("INSERT INTO provider_session_runtime(thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json) VALUES(?1,?2,?3,?2,?4,'stopped',?5,?6,?7)",params![thread,t.source,t.instance,mode,t.updated,cursor.to_string(),payload.to_string()])?;
        let stored=event_store::append(tx,&events)?;Ok((true,stored))
    }).map_err(|e|e.to_string())
}
pub(crate) fn import(
    bus: &EventBus,
    settings: &Value,
    project: &str,
    root: &str,
) -> Result<Value, String> {
    let mode = import_mode(settings, project)?;
    let mut seen = std::collections::HashSet::new();
    let mut imported = 0;
    let mut skipped = 0;
    let mut budget = 20_000usize;
    for (source, instance, home) in agent_session_scan::source_homes(settings) {
        let mut stack = vec![(home, 0)];
        while let Some((dir, depth)) = stack.pop() {
            if budget == 0 {
                return Err("Session discovery limit exceeded".into());
            }
            budget -= 1;
            let Ok(entries) = fs::read_dir(dir) else {
                continue;
            };
            for e in entries.flatten() {
                if budget == 0 {
                    return Err("Session discovery limit exceeded".into());
                }
                budget -= 1;
                let Ok(kind) = e.file_type() else { continue };
                let max = if source == "codex" { 3 } else { 1 };
                if kind.is_dir() && depth < max {
                    stack.push((e.path(), depth + 1));
                    continue;
                }
                let name = e.file_name().to_string_lossy().into_owned();
                if !kind.is_file()
                    || (source == "codex" && (depth != 3 || !name.starts_with("rollout-")))
                    || (source == "claudeAgent" && depth != 1)
                    || !(name.ends_with(".jsonl")
                        || (source == "codex" && name.ends_with(".jsonl.zst")))
                {
                    continue;
                }
                if let Some(t) = parse(source, &instance, &e.path(), root) {
                    if seen.insert((t.instance.clone(), t.native.clone())) {
                        if persist(bus, project, root, &mode, &t)? {
                            imported += 1
                        } else {
                            skipped += 1
                        }
                    }
                }
            }
        }
    }
    Ok(json!({"importedCount":imported,"skippedCount":skipped}))
}
