//! Secret request cards and private delivery. Values never enter events or projections.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event},
    mcp_credentials::Scope,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
type Failure = (&'static str, String);
fn fail(reason: &'static str, message: &str) -> Failure {
    (reason, message.into())
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn salt(dir: &Path) -> Result<[u8; 32], Failure> {
    crate::signing_key::load_or_create_key(dir, "secret-request-salt.bin")
        .map_err(|_| fail("orchestration_error", "Could not access secret storage."))
}
fn private_dir(bus: &EventBus) -> Result<std::path::PathBuf, Failure> {
    bus.secrets_dir()
        .ok_or_else(|| fail("orchestration_error", "Secret storage is unavailable."))
}
fn item_event(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    item: &Value,
    time: &str,
) -> rusqlite::Result<Vec<event_store::StoredEvent>> {
    event_store::append(
        tx,
        &[Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: thread.into(),
            event_type: "turn-item.updated".into(),
            occurred_at: time.into(),
            command_id: None,
            causation_event_id: None,
            correlation_id: None,
            actor_kind: "client".into(),
            payload: item.clone(),
            metadata: json!({}),
        }],
    )
}
fn update(
    tx: &rusqlite::Transaction<'_>,
    thread: &str,
    mut item: Value,
    status: &str,
    time: &str,
) -> rusqlite::Result<Vec<event_store::StoredEvent>> {
    item["secretStatus"] = json!(status);
    item["status"] = json!(if status == "saved" {
        "completed"
    } else {
        "cancelled"
    });
    item["completedAt"] = json!(time);
    item["updatedAt"] = json!(time);
    tx.execute("UPDATE orchestration_v2_projection_turn_items SET status=?1,updated_at=?2,payload_json=?3 WHERE thread_id=?4 AND turn_item_id=?5",params![item["status"].as_str(),time,item.to_string(),thread,item["id"].as_str()])?;
    item_event(tx, thread, &item, time)
}
fn cancel(bus: &EventBus, thread: &str, id: &str) {
    let _ = bus.commit(|tx| { let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND turn_item_id=?2 AND type='secret_request'",params![thread,id],|r|r.get(0)).optional()?;
      let item=raw.and_then(|r|serde_json::from_str::<Value>(&r).ok()); if let Some(item)=item { if item["secretStatus"]=="pending" { let events=update(tx,thread,item,"cancelled",&now())?; return Ok(((),events)); }} Ok(((),vec![])) });
}
/// Calls cannot survive a server restart, so no pending card may survive it either.
pub fn cancel_orphaned(bus: &EventBus) -> Result<(), crate::event_bus::BusError> {
    bus.commit(|tx| {
        let mut statement = tx.prepare("SELECT thread_id,payload_json FROM orchestration_v2_projection_turn_items WHERE type='secret_request' AND json_extract(payload_json,'$.secretStatus')='pending'")?;
        let rows: Vec<(String,String)> = statement.query_map([], |r| Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<_,_>>()?;
        drop(statement);
        let mut events=Vec::new();
        for (thread, raw) in rows {
            let item: Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
            events.extend(update(tx,&thread,item,"cancelled",&now())?);
        }
        Ok(((),events))
    })
}
struct CloseCard {
    bus: EventBus,
    thread: String,
    id: String,
    armed: bool,
}
impl Drop for CloseCard {
    fn drop(&mut self) {
        if self.armed {
            cancel(&self.bus, &self.thread, &self.id);
        }
    }
}
pub fn definition() -> Value {
    json!({"name":"request_secret","description":"Ask for one secret per single-line card; never combine values. Open it, don't offer it. Returns a one-use secretRef, or a private file with delivery: file. Use value only for a secret pasted in this thread.","inputSchema":{"type":"object","properties":{"label":{"type":"string","minLength":1},"reason":{"type":"string","minLength":1},"url":{"type":"string"},"placeholder":{"type":"string"},"delivery":{"enum":["secretRef","file"]},"value":{"type":"string","minLength":1},"timeoutMs":{"type":"integer","minimum":1000,"maximum":3600000},"clientRequestId":{"type":"string","minLength":1,"maxLength":256}},"required":["label","reason"],"additionalProperties":false},"annotations":{"title":"Request a secret from the user","destructiveHint":false},"_meta":{"anthropic/alwaysLoad":true}})
}
pub async fn request(bus: &EventBus, scope: &Scope, args: &Value) -> Result<Value, Failure> {
    let invalid = || fail("invalid_request", "Invalid secret request arguments.");
    let obj = args.as_object().ok_or_else(invalid)?;
    if obj.keys().any(|k| {
        ![
            "label",
            "reason",
            "url",
            "placeholder",
            "delivery",
            "value",
            "timeoutMs",
            "clientRequestId",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid());
    }
    for key in ["label", "reason"] {
        if args[key].as_str().is_none_or(|s| s.trim().is_empty()) {
            return Err(invalid());
        }
    }
    for key in ["placeholder", "clientRequestId"] {
        if let Some(v) = obj.get(key) {
            if !v
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 256)
            {
                return Err(invalid());
            }
        }
    }
    if let Some(v) = obj.get("url") {
        if !v
            .as_str()
            .and_then(|s| url::Url::parse(s).ok())
            .is_some_and(|u| matches!(u.scheme(), "http" | "https"))
        {
            return Err(invalid());
        }
    }
    let delivery = match obj.get("delivery") {
        None => "secretRef",
        Some(Value::String(s)) if s == "file" || s == "secretRef" => s.as_str(),
        _ => return Err(invalid()),
    };
    let timeout = match obj.get("timeoutMs") {
        None => 600000,
        Some(v) => v
            .as_u64()
            .filter(|n| (1000..=3600000).contains(n))
            .ok_or_else(invalid)?,
    };
    let value = match obj.get("value") {
        None => None,
        Some(Value::String(s)) if !s.is_empty() => Some(s.as_str()),
        _ => return Err(invalid()),
    };
    if value.is_some() && delivery == "secretRef" && obj.contains_key("delivery") {
        return Err(fail(
            "invalid_request",
            "A pasted `value` is saved as a file. Leave out `delivery: \"secretRef\"`.",
        ));
    }
    let dir = private_dir(bus)?;
    let salt = salt(&dir)?;
    let key = args["clientRequestId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let enc = |s: &str| {
        percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
    };
    let id = format!(
        "turn-item:secret-request:{}:{}",
        enc(&scope.thread_id),
        enc(&key)
    );
    let started = now();
    let active=bus.commit(|tx| {let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1",[&scope.thread_id],|r|r.get(0)).optional()?; let run:Value=raw.and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
      let project:Option<String>=tx.query_row("SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[&scope.thread_id],|r|r.get(0)).optional()?;
      if run["providerInstanceId"]!=scope.provider_instance_id || run["rootNodeId"].as_str().is_none() || project.is_none() {return Ok((None,vec![]));}
      if value.is_some() {return Ok((Some(()),vec![]));}
      let existing:Option<(String,Option<String>)>=tx.query_row("SELECT type,run_id FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?; if let Some((kind, old_run))=existing {return Ok((if kind=="secret_request" && old_run.as_deref()==run["id"].as_str() {Some(())} else {None},vec![]));}
      let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1",[&scope.thread_id],|r|r.get(0))?;
      let mut item=json!({"id":id,"threadId":scope.thread_id,"runId":run["id"],"nodeId":run["rootNodeId"],"providerThreadId":run["providerThreadId"],"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":"waiting","title":args["label"].as_str().unwrap().trim(),"startedAt":started,"completedAt":null,"updatedAt":started,"type":"secret_request","label":args["label"].as_str().unwrap().trim(),"reason":args["reason"].as_str().unwrap().trim(),"secretStatus":"pending"});
      for k in ["url","placeholder"] {if let Some(v)=obj.get(k) {item[k]=v.clone();}} if delivery=="file" {item["delivery"]=json!("file");}
      tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,'secret_request','waiting',?7,?8)",params![id,scope.thread_id,run["id"].as_str(),run["rootNodeId"].as_str(),run["providerThreadId"].as_str(),ordinal,started,item.to_string()])?;
      Ok((Some(()),item_event(tx,&scope.thread_id,&item,&started)?)) }).map_err(|_|fail("orchestration_error","Could not record the secret request."))?;
    if active.is_none() {
        return Err(fail(
            "parent_not_active",
            "Asking for a secret requires an active run owned by this MCP provider session.",
        ));
    }
    if let Some(value) = value {
        let reference = crate::secret_requests::reference(
            &salt,
            &scope.thread_id,
            &format!("pasted\0{}\0{}", scope.provider_session_id, key),
        );
        let file = crate::secret_requests::write_delivery_file(&dir, &reference, value)
            .map_err(|_| fail("orchestration_error", "Could not store the secret."))?;
        return Ok(json!({"status":"saved","file":file}));
    }
    let mut guard = CloseCard {
        bus: bus.clone(),
        thread: scope.thread_id.clone(),
        id: id.clone(),
        armed: true,
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout);
    loop {
        let state=bus.commit(|tx| {let row:Option<(String,Option<String>)>=tx.query_row("SELECT i.payload_json,r.status FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id WHERE i.thread_id=?1 AND i.turn_item_id=?2",params![scope.thread_id,id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?; Ok((row,vec![]))}).map_err(|_|fail("orchestration_error","Unable to read the secret request."))?;
        let Some((raw, run_status)) = state else {
            return Err(fail(
                "orchestration_error",
                "Unable to read the secret request.",
            ));
        };
        let item: Value = serde_json::from_str(&raw)
            .map_err(|_| fail("orchestration_error", "Unable to read the secret request."))?;
        let status = item["secretStatus"].as_str().unwrap_or("cancelled");
        if status != "pending" {
            guard.armed = false;
            if status == "saved" {
                let recorded_delivery = if item["delivery"] == "file" {
                    "file"
                } else {
                    "secretRef"
                };
                if delivery != recorded_delivery {
                    return Err(fail(
                        "invalid_request",
                        "Use the original delivery when retrying a secret request.",
                    ));
                }
                let reference = crate::secret_requests::reference(&salt, &scope.thread_id, &id);
                if delivery == "file" {
                    let project=bus.commit(|tx| {let p:String=tx.query_row("SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=?1",[&scope.thread_id],|r|r.get(0))?;Ok((p,vec![]))}).map_err(|_|fail("orchestration_error","Could not read the secret."))?;
                    let existing = crate::secret_requests::delivery_path(&dir, &reference)
                        .map_err(|_| fail("orchestration_error", "Could not read the secret."))?;
                    if existing.exists() {
                        crate::secret_requests::remove(&dir, &reference).map_err(|_| {
                            fail("orchestration_error", "Could not use the secret.")
                        })?;
                        return Ok(json!({"status":"saved","file":existing}));
                    }
                    let value = crate::secret_requests::read_for_claim(
                        &dir,
                        &reference,
                        &project,
                        chrono::Utc::now().timestamp_millis(),
                    )
                    .map_err(|_| fail("orchestration_error", "Could not read the secret."))?;
                    let file =
                        crate::secret_requests::write_delivery_file(&dir, &reference, &value)
                            .map_err(|_| {
                                fail("orchestration_error", "Could not store the secret.")
                            })?;
                    crate::secret_requests::remove(&dir, &reference)
                        .map_err(|_| fail("orchestration_error", "Could not use the secret."))?;
                    return Ok(json!({"status":"saved","file":file}));
                }
                let project=bus.commit(|tx| {let p:String=tx.query_row("SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=?1",[&scope.thread_id],|r|r.get(0))?;Ok((p,vec![]))}).map_err(|_|fail("orchestration_error","Could not read the secret."))?;
                crate::secret_requests::read_for_claim(&dir,&reference,&project,chrono::Utc::now().timestamp_millis()).map_err(|_|fail("orchestration_error","The user saved the secret, but it could not be read. Ask again with a new clientRequestId."))?;
                return Ok(json!({"status":"saved","secretRef":reference}));
            }
            return Ok(unsaved(status));
        }
        if run_status
            .as_deref()
            .is_none_or(|s| !matches!(s, "preparing" | "starting" | "running" | "waiting"))
        {
            cancel(bus, &scope.thread_id, &id);
            let answered = bus.commit(|tx| { let status: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.secretStatus') FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND turn_item_id=?2", params![scope.thread_id,id], |r| r.get(0)).optional()?; Ok((status, vec![])) }).map_err(|_|fail("orchestration_error","Unable to read the secret request."))?;
            if matches!(answered.as_deref(), Some("saved" | "declined")) {
                continue;
            }
            guard.armed = false;
            return Ok(unsaved("cancelled"));
        }
        if tokio::time::Instant::now() >= deadline {
            cancel(bus, &scope.thread_id, &id);
            let answered = bus.commit(|tx| { let status: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.secretStatus') FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND turn_item_id=?2", params![scope.thread_id,id], |r| r.get(0)).optional()?; Ok((status, vec![])) }).map_err(|_|fail("orchestration_error","Unable to read the secret request."))?;
            if matches!(answered.as_deref(), Some("saved" | "declined")) {
                continue;
            }
            guard.armed = false;
            return Ok(unsaved("timed_out"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}
fn unsaved(status: &str) -> Value {
    let note=match status {"declined"=>"The user declined. Don't ask for it in chat or another way; say what's blocked and go on without it.","timed_out"=>"No answer in time. Don't ask in chat; ask again with a new clientRequestId only if it is still needed.",_=>"The card closed with the run. Ask again with a new clientRequestId only if the secret is still needed."};
    json!({"status":status,"note":note})
}

/// Resolve one configured 1Password reference without exposing its value in logs or events.
pub async fn resolve_reference(settings: &Value, reference: &Value) -> Option<String> {
    let provider = reference.get("provider")?.as_str()?;
    let path = reference.get("reference")?.as_str()?;
    let config = settings.get("secretProviders")?.get(provider)?;
    if config.get("kind")?.as_str()? != "one_password" {
        return None;
    }
    let account = config.get("config")?.get("account")?.as_str()?;
    let valid_account = regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*$").ok()?;
    let valid_path = regex::Regex::new(r"^op://[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?(?:/[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?){2,3}(?:\?[a-z-]+=[A-Za-z0-9_-]+)?$").ok()?;
    if account.len() > 253
        || path.len() > 1024
        || !valid_account.is_match(account)
        || !valid_path.is_match(path)
    {
        return None;
    }
    let mut command = tokio::process::Command::new("op");
    command
        .args([
            "--cache=false",
            "read",
            &format!("--account={account}"),
            "--no-newline",
            path,
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(45), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Check the card before consulting an external provider. The final write repeats this
/// check under the transaction lock because the card can change while the provider runs.
pub fn check_answerable(bus: &EventBus, input: &Value) -> Result<(), &'static str> {
    let thread = input["threadId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("not_found")?;
    let id = input["turnItemId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("not_found")?;
    bus.commit(|tx| {
        let row: Option<(String, Option<String>)> = tx.query_row("SELECT i.payload_json,r.status FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id WHERE i.thread_id=?1 AND i.turn_item_id=?2 AND i.type='secret_request'", params![thread,id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((raw, run)) = row else { return Ok((Err("not_found"), vec![])); };
        let item: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let status = if item["runId"].as_str().is_none() || item["nodeId"].as_str().is_none() { Err("not_found") }
            else if item["secretStatus"] != "pending" { Err("already_answered") }
            else if run.as_deref().is_none_or(|s| !matches!(s,"preparing"|"starting"|"running"|"waiting")) { Err("agent_stopped") }
            else { Ok(()) };
        Ok((status, vec![]))
    }).map_err(|_| "load_failed")?
}

pub async fn answer_with_resolver<F, Fut>(
    bus: &EventBus,
    input: &Value,
    resolve: F,
) -> Result<(), &'static str>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    if input["answer"]["type"] == "reference" {
        check_answerable(bus, input)?;
        let value = resolve().await.ok_or("reference_unreadable")?;
        answer_resolved(bus, input, Some(&value))
    } else {
        answer_resolved(bus, input, None)
    }
}

/// Answer under the event-bus transaction lock so cancellation and concurrent answers serialize.
pub fn answer(bus: &EventBus, input: &Value) -> Result<(), &'static str> {
    answer_resolved(bus, input, None)
}

pub fn answer_resolved(
    bus: &EventBus,
    input: &Value,
    resolved: Option<&str>,
) -> Result<(), &'static str> {
    let thread = input["threadId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("not_found")?;
    let id = input["turnItemId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("not_found")?;
    let answer = &input["answer"];
    let kind = answer["type"].as_str().ok_or("not_found")?;
    let secret = match kind {
        "reference" => Some(resolved.ok_or("reference_unreadable")?),
        "save" => Some(
            answer["secret"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("store_failed")?,
        ),
        "decline" => None,
        _ => return Err("not_found"),
    };
    let dir = private_dir(bus).map_err(|_| "store_failed")?;
    let salt = salt(&dir).map_err(|_| "store_failed")?;
    let reference = crate::secret_requests::reference(&salt, thread, id);
    let time = now();
    let result=bus.commit(|tx| {
      let row:Option<(String,Option<String>,Option<String>)>=tx.query_row("SELECT i.payload_json,r.status,t.project_id FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=i.run_id LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id=i.thread_id WHERE i.thread_id=?1 AND i.turn_item_id=?2 AND i.type='secret_request'",params![thread,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
      let Some((raw,run,project))=row else{return Ok((Err("not_found"),vec![]));}; let item:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
      if item["runId"].as_str().is_none()||item["nodeId"].as_str().is_none(){return Ok((Err("not_found"),vec![]));}
      if item["secretStatus"]!="pending" {return Ok((Err("already_answered"),vec![]));}
      if run.as_deref().is_none_or(|s| !matches!(s,"preparing"|"starting"|"running"|"waiting")){return Ok((Err("agent_stopped"),vec![]));}
      if let Some(secret)=secret {let Some(project)=project else{return Ok((Err("not_found"),vec![]));}; if crate::secret_requests::create(&dir,&reference,&project,secret,chrono::Utc::now().timestamp_millis()).is_err() && crate::secret_requests::read_for_claim(&dir,&reference,&project,chrono::Utc::now().timestamp_millis()).is_err() {return Ok((Err("store_failed"),vec![]));}}
      let events=update(tx,thread,item,if secret.is_some(){"saved"}else{"declined"},&time)?;
      Ok((Ok(()),events))
    });
    match result {
        Ok(r) => r,
        // Keep the stored value on a failed recording: it may predate this attempt,
        // and a retry can finish recording an earlier successful store.
        Err(_) => Err("record_failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (EventBus, Scope, std::path::PathBuf) {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"codex","model":"gpt"});
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "T",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &json!("web"),
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        crate::message_commands::dispatch_first_message(
            &bus,
            crate::message_commands::DispatchMessage {
                context: None,
                command_id: "start",
                thread_id: "t",
                message_id: "m",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "codex",
            },
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let dir = std::env::temp_dir().join(format!("secret-flow-{}", uuid::Uuid::new_v4()));
        bus.set_secrets_dir(dir.clone());
        let scope = Scope {
            thread_id: "t".into(),
            provider_session_id: "session".into(),
            provider_instance_id: "codex".into(),
            capabilities: ["orchestration".to_string()].into_iter().collect(),
            subagent: false, client: None,
        };
        (bus, scope, dir)
    }
    #[tokio::test]
    async fn failed_recording_preserves_existing_secret_for_retry() {
        let (bus, scope, dir) = setup();
        let b = bus.clone();
        let task = tokio::spawn(async move {
            request(
                &b,
                &scope,
                &json!({"label":"Token","reason":"Use it","clientRequestId":"retry"}),
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        bus.commit(|tx| { tx.execute_batch("CREATE TRIGGER fail_secret_record BEFORE UPDATE ON orchestration_v2_projection_turn_items BEGIN SELECT RAISE(FAIL, 'test failure'); END;")?; Ok(((), vec![])) }).unwrap();
        let input = json!({"threadId":"t","turnItemId":"turn-item:secret-request:t:retry","answer":{"type":"save","secret":"original"}});
        assert_eq!(answer(&bus, &input), Err("record_failed"));
        let mut retry = input.clone();
        retry["answer"]["secret"] = json!("replacement");
        assert_eq!(answer(&bus, &retry), Err("record_failed"));
        bus.commit(|tx| {
            tx.execute_batch("DROP TRIGGER fail_secret_record")?;
            Ok(((), vec![]))
        })
        .unwrap();
        answer(&bus, &retry).unwrap();
        let result = task.await.unwrap().unwrap();
        assert_eq!(
            crate::secret_requests::read_for_claim(
                &dir,
                result["secretRef"].as_str().unwrap(),
                "p",
                chrono::Utc::now().timestamp_millis()
            )
            .unwrap(),
            "original"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stale_and_missing_cards_do_not_invoke_provider() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (bus, scope, dir) = setup();
        let b = bus.clone();
        let task = tokio::spawn(async move {
            request(
                &b,
                &scope,
                &json!({"label":"Token","reason":"Use it","clientRequestId":"stale"}),
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let input = json!({"threadId":"t","turnItemId":"turn-item:secret-request:t:stale", "answer":{"type":"reference","reference":{"provider":"personal","reference":"op://vault/item/field"}}});
        answer(&bus, &json!({"threadId":"t","turnItemId":"turn-item:secret-request:t:stale","answer":{"type":"decline"}})).unwrap();
        let calls = AtomicUsize::new(0);
        assert_eq!(
            answer_with_resolver(&bus, &input, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Some("secret".into())
            })
            .await,
            Err("already_answered")
        );
        let mut missing = input.clone();
        missing["turnItemId"] = json!("missing");
        assert_eq!(
            answer_with_resolver(&bus, &missing, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Some("secret".into())
            })
            .await,
            Err("not_found")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        task.await.unwrap().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn reference_answer_stores_resolved_value_without_recording_it() {
        let (bus, scope, dir) = setup();
        let b = bus.clone();
        let task = tokio::spawn(async move {
            request(
                &b,
                &scope,
                &json!({"label":"Token","reason":"Use it","clientRequestId":"ref"}),
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let input = json!({"threadId":"t","turnItemId":"turn-item:secret-request:t:ref", "answer":{"type":"reference","reference":{"provider":"personal","reference":"op://vault/item/field"}}});
        assert_eq!(
            answer_resolved(&bus, &input, None),
            Err("reference_unreadable")
        );
        answer_resolved(&bus, &input, Some("  private value  ")).unwrap();
        let result = task.await.unwrap().unwrap();
        assert_eq!(
            crate::secret_requests::read_for_claim(
                &dir,
                result["secretRef"].as_str().unwrap(),
                "p",
                chrono::Utc::now().timestamp_millis()
            )
            .unwrap(),
            "  private value  "
        );
        let records = bus.commit(|tx| { let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1", ["turn-item:secret-request:t:ref"], |r| r.get(0))?; Ok((raw, vec![])) }).unwrap();
        assert!(!records.contains("private value"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn rejects_invalid_provider_references_without_running_cli() {
        let settings = json!({"secretProviders":{"personal":{"kind":"one_password","config":{"account":"my"}}}});
        for reference in [
            json!({"provider":"missing","reference":"op://vault/item/field"}),
            json!({"provider":"personal","reference":"--help"}),
            json!({"provider":"personal","reference":"op://vault/item/field\n"}),
        ] {
            assert!(resolve_reference(&settings, &reference).await.is_none());
        }
    }

    #[tokio::test]
    async fn card_answer_stays_private_and_returns_ref() {
        let (bus, scope, dir) = setup();
        let b = bus.clone();
        let s = scope.clone();
        let task = tokio::spawn(async move {
            request(
                &b,
                &s,
                &json!({"label":"Token","reason":"Use it","clientRequestId":"key"}),
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let id = "turn-item:secret-request:t:key";
        answer(&bus,&json!({"threadId":"t","turnItemId":id,"answer":{"type":"save","secret":"sensitive-value"}})).unwrap();
        assert_eq!(
            answer(
                &bus,
                &json!({"threadId":"t","turnItemId":id,"answer":{"type":"decline"}})
            ),
            Err("already_answered")
        );
        let result = task.await.unwrap().unwrap();
        let reference = result["secretRef"].as_str().unwrap();
        assert_eq!(
            crate::secret_requests::read_for_claim(
                &dir,
                reference,
                "p",
                chrono::Utc::now().timestamp_millis()
            )
            .unwrap(),
            "sensitive-value"
        );
        bus.commit(|tx|{let events:String=tx.query_row("SELECT group_concat(payload_json) FROM orchestration_events",[],|r|r.get(0))?;assert!(!events.contains("sensitive-value"));let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?1",[id],|r|r.get(0))?;assert!(!raw.contains("sensitive-value"));Ok(((),vec![]))}).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn file_delivery_is_private_and_retryable() {
        let (bus, scope, dir) = setup();
        let b = bus.clone();
        let s = scope.clone();
        let args =
            json!({"label":"PIN","reason":"Use it","delivery":"file","clientRequestId":"file"});
        let call_args = args.clone();
        let task = tokio::spawn(async move { request(&b, &s, &call_args).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        answer(&bus,&json!({"threadId":"t","turnItemId":"turn-item:secret-request:t:file","answer":{"type":"save","secret":"1234"}})).unwrap();
        let result = task.await.unwrap().unwrap();
        let path = result["file"].as_str().unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "1234");
        assert_eq!(request(&bus, &scope, &args).await.unwrap()["file"], path);
        assert!(request(
            &bus,
            &scope,
            &json!({"label":"PIN","reason":"Use it","clientRequestId":"file"})
        )
        .await
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn aborted_call_closes_card() {
        let (bus, scope, dir) = setup();
        let b = bus.clone();
        let s = scope.clone();
        let task = tokio::spawn(async move {
            request(
                &b,
                &s,
                &json!({"label":"Token","reason":"Use it","clientRequestId":"key"}),
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        task.abort();
        let _ = task.await;
        assert_eq!(
            answer(
                &bus,
                &json!({"threadId":"t","turnItemId":"turn-item:secret-request:t:key","answer":{"type":"save","secret":"private"}})
            ),
            Err("already_answered")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
