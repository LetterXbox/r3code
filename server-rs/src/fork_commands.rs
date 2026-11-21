//! Atomic creation of a fork and its pending context transfer.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event, Receipt},
    thread_commands::{CommitResult, ThreadCommitError},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub struct ForkThread<'a> {
    pub command_id: &'a str,
    pub source_thread_id: &'a str,
    pub target_thread_id: &'a str,
    pub source_point: &'a Value,
    pub title: Option<&'a str>,
    pub side_chat: bool,
    pub created_by: &'a str,
    pub creation_source: &'a Value,
}

pub fn fork_thread_ordered(
    bus: &EventBus,
    cmd: ForkThread<'_>,
    event_ids: [&str; 2],
    transfer_id: &str,
    now: &str,
) -> Result<CommitResult, ThreadCommitError> {
    fork_thread_ordered_checked(bus, cmd, event_ids, transfer_id, now, |_| Ok(()))
}

pub fn fork_thread_ordered_checked<F>(
    bus: &EventBus,
    cmd: ForkThread<'_>,
    event_ids: [&str; 2],
    transfer_id: &str,
    now: &str,
    check: F,
) -> Result<CommitResult, ThreadCommitError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
{
    bus.commit_with(|tx| {
        check(tx)?;
        if let Some(receipt) = event_store::get_receipt(tx, cmd.command_id, "thread")? { return Ok((CommitResult { receipt, committed: false }, vec![])); }
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", [cmd.source_thread_id], |r| r.get(0)).optional()?;
        let source: Option<Value> = raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery)).transpose()?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?1)", [cmd.target_thread_id], |r| r.get(0))?;
        let mut runs = Vec::new();
        { let mut stmt = tx.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 ORDER BY ordinal")?;
          for row in stmt.query_map([cmd.source_thread_id], |r| r.get::<_,String>(0))? { runs.push(serde_json::from_str::<Value>(&row?).map_err(|_| rusqlite::Error::InvalidQuery)?); } }
        let point_type = cmd.source_point["type"].as_str().unwrap_or("");
        let run_id = match point_type {
            "run" => cmd.source_point["runId"].as_str().map(str::to_owned),
            "checkpoint" => match cmd.source_point["checkpointId"].as_str() { Some(id) => tx.query_row("SELECT run_id FROM orchestration_v2_projection_checkpoints WHERE checkpoint_id=?1 AND thread_id=?2", params![id,cmd.source_thread_id], |r| r.get::<_,Option<String>>(0)).optional()?.flatten(), None => None },
            "latest_stable" => runs.iter().rev().find(|r| r["status"] == "completed" && !r["checkpointId"].is_null()).and_then(|r| r["id"].as_str()).map(str::to_owned),
            _ => None,
        };
        let run = run_id.as_deref().and_then(|id| runs.iter().find(|r| r["id"] == id));
        let mut error = if source.is_none() { Some(format!("Thread {} was not found.", cmd.source_thread_id)) } else if cmd.side_chat && source.as_ref().is_some_and(|s| !s["deletedAt"].is_null()) { Some(format!("Thread {} was deleted.",cmd.source_thread_id)) } else { None };
        if error.is_none() && cmd.side_chat && source.as_ref().unwrap()["worktreePath"].is_null() {
            let latest = runs.iter().filter(|r| r["status"] != "queued" && !(r["status"] == "cancelled" && r["startedAt"].is_null())).max_by(|a,b| {
                let at = a["completedAt"].as_str().unwrap_or("\u{10ffff}"); let bt = b["completedAt"].as_str().unwrap_or("\u{10ffff}"); at.cmp(bt).then_with(|| a["ordinal"].as_i64().cmp(&b["ordinal"].as_i64()))
            });
            if latest.is_some_and(|r| matches!(r["status"].as_str(), Some("preparing"|"failed"|"interrupted")) && r["workspacePreparation"]["type"] == "worktree") { error=Some(format!("Thread {} has no worktree yet. Start the side chat once its worktree is set up.",cmd.source_thread_id)); }
        }
        if error.is_none() && exists { error=Some(format!("Thread {} already exists. Use a new thread id.",cmd.target_thread_id)); }
        if error.is_none() && run.is_none() && !(cmd.side_chat && point_type == "latest_stable") { error=Some(format!("No stable source run was found for fork source {point_type}.")); }
        if error.is_none() { if let Some(r) = run { let status=r["status"].as_str().unwrap_or(""); if !matches!(status,"completed"|"waiting"|"failed"|"interrupted"|"cancelled") { error=Some(format!("Fork source run {} is {status}; in-progress and rolled-back runs cannot be forked.",r["id"].as_str().unwrap_or(""))); } } }
        if error.is_none() && cmd.side_chat { let s=source.as_ref().unwrap(); if s["lineage"]["sideChat"] == true { error=Some("A side chat cannot start another side chat.".into()); } else if s["lineage"]["relationshipToParent"] == "subagent" || !s["delegatedFrom"].is_null() { error=Some("A subagent cannot start a side chat.".into()); } }
        let mut receipt=Receipt { command_id:cmd.command_id.into(),aggregate_kind:"thread".into(),aggregate_id:cmd.target_thread_id.into(),command_type:"thread.fork".into(),accepted_at:now.into(),result_sequence:event_store::latest_application_sequence(tx)?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error };
        if !event_store::insert_receipt_if_absent(tx,&receipt)? { return Err(ThreadCommitError::CommandIdUsedByProject); }
        if receipt.error.is_some() { return Ok((CommitResult{receipt,committed:false},vec![])); }
        let mut target=source.unwrap();
        let source_title=target["title"].as_str().unwrap_or("").to_string();
        let root=target["lineage"]["rootThreadId"].clone();
        if let Some(obj)=target.as_object_mut() { obj.remove("delegatedFrom"); }
        if let Some(prs)=target.get_mut("pullRequests").and_then(Value::as_array_mut) { for pr in prs { if let Some(o)=pr.as_object_mut() { o.remove("watch"); } } }
        for key in ["titleRegeneration","activeProviderThreadId","archivedAt","settledOverride","settledAt","snoozedUntil","snoozedAt","lastSnoozeWakeAt","pinnedAt","pinOrderKey","activeOrderKey","autoSettleDisabledAt","guestShare","lastVisitedAt","opens","deletedAt"] { target[key]=Value::Null; }
        target["id"]=json!(cmd.target_thread_id); target["title"]=json!(cmd.title.map(str::to_owned).unwrap_or_else(||format!("{source_title} fork"))); target["titleRenamed"]=json!(false); target["createdBy"]=json!(cmd.created_by); target["creationSource"]=cmd.creation_source.clone(); target["createdAt"]=json!(now); target["updatedAt"]=json!(now);
        target["lineage"]=json!({"parentThreadId":cmd.source_thread_id,"relationshipToParent":"fork","rootThreadId":root}); if cmd.side_chat { target["lineage"]["sideChat"]=json!(true); }
        target["forkedFrom"]=run.map(|r|json!({"type":"run","threadId":cmd.source_thread_id,"runId":r["id"]})).unwrap_or(Value::Null);
        let provider_thread: Option<Value> = if let Some(id)=run.and_then(|r|r["providerThreadId"].as_str()) { tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",[id],|r|r.get::<_,String>(0)).optional()?.map(|s|serde_json::from_str(&s).map_err(|_|rusqlite::Error::InvalidQuery)).transpose()? } else { None };
        let mut source_point=json!({"threadId":cmd.source_thread_id});
        if let Some(r)=run { source_point["runId"]=r["id"].clone(); if !r["checkpointId"].is_null() { source_point["checkpointId"]=r["checkpointId"].clone(); } }
        let turn: Option<Value> = if let Some(attempt)=run.and_then(|r|r["activeAttemptId"].as_str()) { tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id=?1 ORDER BY rowid DESC LIMIT 1",[attempt],|r|r.get::<_,String>(0)).optional()?.map(|s|serde_json::from_str(&s).map_err(|_|rusqlite::Error::InvalidQuery)).transpose()? } else { None };
        let source_ref = turn.as_ref().and_then(|t| t.get("nativeThreadRef")).filter(|reference| reference.is_object())
            .or_else(|| provider_thread.as_ref().and_then(|p| p.get("nativeThreadRef")).filter(|reference| reference.is_object()));
        if let Some(reference) = source_ref {
            source_point["providerThreadRef"] = reference.clone();
        }
        if let Some(t)=&turn { if !t["nativeTurnRef"].is_null() { source_point["providerTurnRef"]=t["nativeTurnRef"].clone(); } }
        let strong = source_ref.is_some_and(|reference| reference["strength"] == "strong");
        let source_provider=run.and_then(|r|r["providerInstanceId"].as_str()).or_else(||target["providerInstanceId"].as_str());
        let mut transfer=json!({"id":transfer_id,"type":"fork","sourceThreadId":cmd.source_thread_id,"targetThreadId":cmd.target_thread_id,"sourcePoint":source_point,"basePoint":null,"sourceProviderInstanceId":source_provider,"targetProviderInstanceId":null,"targetRunId":null,"status":"pending","resolution":null,"createdBy":cmd.created_by,"error":if strong {None} else {Some("Source provider thread does not expose a strong native thread ref.")},"createdAt":now,"updatedAt":now,"consumedAt":null});
        if strong && run.is_some_and(|r| matches!(r["status"].as_str(),Some("completed"|"waiting"))) { if let Some(t)=turn { if let Some(usage)=t.get("turnTokenUsage") { transfer["sourceTokenUsage"]=usage.clone(); } } }
        let events:Vec<Event>=[("thread.created",target.clone()),("context-transfer.created",transfer.clone())].into_iter().enumerate().map(|(i,(kind,payload))|Event{id:event_ids[i].into(),aggregate_kind:"thread".into(),stream_id:cmd.target_thread_id.into(),event_type:kind.into(),occurred_at:now.into(),command_id:Some(cmd.command_id.into()),causation_event_id:None,correlation_id:Some(cmd.command_id.into()),actor_kind:if cmd.command_id.starts_with("provider:"){"provider"}else if cmd.command_id.starts_with("server:"){"server"}else{"client"}.into(),payload,metadata:json!({})}).collect();
        let stored=event_store::append(tx,&events)?;
        tx.execute("INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json) VALUES (?1,?2,?3,?4,?4,?5,?6,NULL,?7,?7,NULL,NULL,?8)",params![cmd.target_thread_id,target["projectId"].as_str(),target["title"].as_str(),target["providerInstanceId"].as_str(),target["runtimeMode"].as_str(),target["interactionMode"].as_str(),now,target.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_context_transfers(context_transfer_id,source_thread_id,target_thread_id,target_run_id,type,status,source_provider,source_provider_instance_id,updated_at,payload_json) VALUES(?1,?2,?3,NULL,'fork','pending',?4,?4,?5,?6)",params![transfer_id,cmd.source_thread_id,cmd.target_thread_id,source_provider,now,transfer.to_string()])?;
        receipt.result_sequence=stored.last().unwrap().sequence; event_store::upsert_receipt(tx,&receipt)?;
        Ok((CommitResult{receipt,committed:true},stored))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        migrations,
        thread_commands::{create_thread_ordered, CreateThread},
    };
    #[test]
    fn fork_first_message_consumes_bounded_portable_history() {
        use crate::message_commands::{dispatch_first_message, DispatchMessage};
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let origin = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "parent",
                project_id: "p",
                title: "Parent",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &origin,
                link_origin: None,
                delegated_from: None,
            },
            "e0",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let send = |command_id, thread_id, message_id, text| DispatchMessage {
            context: None,
            command_id,
            thread_id,
            message_id,
            text,
            attachments: &[],
            creation_source: "web",
            cwd: "/tmp",
            driver: "codex",
        };
        dispatch_first_message(
            &bus,
            send("send-parent", "parent", "m1", "SOURCE_MARKER"),
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        let run=bus.commit(|tx| { let id:String=tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id='parent'",[],|r|r.get(0))?; tx.execute("UPDATE orchestration_v2_projection_runs SET status='interrupted', payload_json=json_set(payload_json,'$.status','interrupted') WHERE run_id=?1",[&id])?; Ok((id,vec![])) }).unwrap();
        let point = json!({"type":"run","runId":run});
        fork_thread_ordered(
            &bus,
            ForkThread {
                command_id: "fork",
                source_thread_id: "parent",
                target_thread_id: "child",
                source_point: &point,
                title: None,
                side_chat: false,
                created_by: "user",
                creation_source: &origin,
            },
            ["e1", "e2"],
            "transfer",
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        fork_thread_ordered(
            &bus,
            ForkThread {
                command_id: "fork2",
                source_thread_id: "parent",
                target_thread_id: "child2",
                source_point: &point,
                title: None,
                side_chat: false,
                created_by: "user",
                creation_source: &origin,
            },
            ["e3", "e4"],
            "transfer2",
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        // An eligible same-instance Codex source stays pending for the executor.
        bus.commit(|tx| {
            let original: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE context_transfer_id='transfer'", [], |r| r.get(0))?;
            let mut transfer: Value = serde_json::from_str(&original).unwrap();
            transfer["sourcePoint"]["providerThreadRef"] = json!({"driver":"codex","nativeId":"source","strength":"strong"});
            transfer["sourcePoint"]["providerTurnRef"] = json!({"driver":"codex","nativeId":"turn","strength":"strong"});
            tx.execute("UPDATE orchestration_v2_projection_context_transfers SET payload_json=?1 WHERE context_transfer_id='transfer'", [transfer.to_string()])?;
            // Interrupted source runs use portable history, even if a cursor is present.
            assert!(crate::message_commands::native_fork_candidate(tx,"child","codex")?.is_none());
            assert!(crate::message_commands::native_fork_candidate(tx,"child","other")?.is_none());
            tx.execute("UPDATE orchestration_v2_projection_context_transfers SET payload_json=?1 WHERE context_transfer_id='transfer'", [original])?;
            Ok(((),vec![]))
        }).unwrap();
        dispatch_first_message(
            &bus,
            send("send-child", "child", "m2", "continue"),
            "2026-01-01T00:00:03Z",
        )
        .unwrap();
        bus.commit(|tx| {
            tx.execute(
                "DELETE FROM orchestration_v2_projection_provider_threads WHERE thread_id='parent'",
                [],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
        let rejected = dispatch_first_message(
            &bus,
            send("send-child2", "child2", "m3", "continue"),
            "2026-01-01T00:00:03Z",
        )
        .unwrap();
        assert!(!rejected.committed);
        assert_eq!(
            rejected.receipt.error.as_deref(),
            Some("Pending fork transfer transfer2 has no resolvable source provider thread.")
        );
        bus.commit(|tx| { let (status,raw):(String,String)=tx.query_row("SELECT status,payload_json FROM orchestration_v2_projection_context_transfers WHERE context_transfer_id='transfer'",[],|r|Ok((r.get(0)?,r.get(1)?)))?; assert_eq!(status,"consumed"); assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["resolution"]["strategy"],"portable_context"); let h:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_handoffs WHERE thread_id='child'",[],|r|r.get(0))?; assert!(h.contains("SOURCE_MARKER")); Ok(((),vec![])) }).unwrap();
    }
    #[test]
    fn side_chat_creation_is_atomic_and_replayable() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        let origin = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "parent",
                project_id: "p",
                title: "Parent",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &origin,
                link_origin: None,
                delegated_from: None,
            },
            "e0",
            "2026-01-01",
        )
        .unwrap();
        // A nullable delegation marker does not make a normal thread a subagent.
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.delegatedFrom',json('null')) WHERE thread_id='parent'", [])?;
            Ok(((), vec![]))
        }).unwrap();
        let point = json!({"type":"latest_stable"});
        let cmd = || ForkThread {
            command_id: "fork",
            source_thread_id: "parent",
            target_thread_id: "child",
            source_point: &point,
            title: None,
            side_chat: true,
            created_by: "user",
            creation_source: &origin,
        };
        let first =
            fork_thread_ordered(&bus, cmd(), ["e1", "e2"], "transfer", "2026-01-02").unwrap();
        assert!(first.committed);
        let replay = fork_thread_ordered(&bus, cmd(), ["e3", "e4"], "other", "later").unwrap();
        assert!(!replay.committed);
        assert_eq!(first.receipt, replay.receipt);
        bus.commit(|tx| { let s:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='child'",[],|r|r.get(0))?; let child:Value=serde_json::from_str(&s).unwrap(); assert_eq!(child["lineage"]["sideChat"],true); assert_eq!(child["title"],"Parent fork"); assert!(child["forkedFrom"].is_null()); let t:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE context_transfer_id='transfer'",[],|r|r.get(0))?; let transfer:Value=serde_json::from_str(&t).unwrap(); assert_eq!(transfer["sourcePoint"],json!({"threadId":"parent"})); assert_eq!(transfer["status"],"pending"); assert_eq!(tx.query_row("SELECT COUNT(*) FROM orchestration_events",[],|r|r.get::<_,i64>(0))?,3); Ok(((),vec![])) }).unwrap();
        fork_thread_ordered(&bus, ForkThread {
            command_id: "unsupported-fork", source_thread_id: "parent", target_thread_id: "unsupported-child",
            source_point: &point, title: None, side_chat: true, created_by: "user", creation_source: &origin,
        }, ["unsupported-e1", "unsupported-e2"], "unsupported-transfer", "2026-01-02").unwrap();
        let rejected = crate::message_commands::dispatch_first_message(&bus, crate::message_commands::DispatchMessage {
            context: None, command_id: "unsupported-ask", thread_id: "unsupported-child", message_id: "unsupported-message",
            text: "question", attachments: &[], creation_source: "web", cwd: "/tmp", driver: "unsupported",
        }, "2026-01-02").unwrap();
        assert!(!rejected.committed);
        assert!(rejected.receipt.error.unwrap().contains("Side chat context delivery is not supported"));
        // Parent activity after a side chat opens must be delivered in the
        // separate manual digest, even when no stable source run existed.
        crate::message_commands::dispatch_first_message(
            &bus,
            crate::message_commands::DispatchMessage {
                context: None,
                command_id: "parent-message",
                thread_id: "parent",
                message_id: "parent-message",
                text: "Parent activity after fork",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-02T01:00:00Z",
        ).unwrap();
        crate::message_commands::dispatch_first_message(
            &bus,
            crate::message_commands::DispatchMessage {
                context: None,
                command_id: "ask",
                thread_id: "child",
                message_id: "question",
                text: "What is happening?",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-03",
        )
        .unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_handoffs WHERE thread_id='child'", [], |r| r.get(0))?;
            let handoff: Value = serde_json::from_str(&raw).unwrap();
            let text = handoff["summaryText"].as_str().unwrap();
            assert!(text.starts_with("You are in a side chat beside the main thread."));
            assert!(text.contains("t3_thread_read on thread parent"));
            assert!(text.contains("Parent activity after fork"));
            assert_eq!(handoff["strategy"], "manual_context");
            assert_eq!(handoff["coveredRunOrdinals"], json!({"from":1,"to":1}));
            let visible: i64 = tx.query_row("SELECT count(*) FROM orchestration_v2_projection_turn_items WHERE thread_id='child' AND type='handoff'", [], |r| r.get(0))?;
            assert_eq!(visible, 0);
            Ok(((), vec![]))
        }).unwrap();
    }
}
