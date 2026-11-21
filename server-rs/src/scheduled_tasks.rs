//! Durable scheduled-task records and schedule calculations.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{
    DateTime, Datelike, Duration, Local, LocalResult, NaiveDateTime, SecondsFormat, TimeZone, Utc,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn parse_time(s: &str) -> Result<(u32, u32), String> {
    let (h, m) = s.split_once(':').ok_or("Invalid time of day.")?;
    if h.is_empty()
        || h.len() > 2
        || m.len() != 2
        || !h.bytes().chain(m.bytes()).all(|c| c.is_ascii_digit())
    {
        return Err("Invalid time of day.".into());
    }
    let h: u32 = h.parse().map_err(|_| "Invalid time of day.")?;
    let m: u32 = m.parse().map_err(|_| "Invalid time of day.")?;
    if h > 23 || m > 59 {
        return Err("Invalid time of day.".into());
    }
    Ok((h, m))
}
fn instant(s: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|_| "Invalid run time.".into())
}
/// Validate and normalize the persisted schedule. Webhook secrets must be stored separately.
pub fn normalize_schedule(value: &Value, creating: bool) -> Result<Value, String> {
    let mut s = value.clone();
    let o = s.as_object_mut().ok_or("Invalid schedule.")?;
    match o.get("type").and_then(Value::as_str) {
        Some("interval") => {
            let n = o
                .get("everyMs")
                .and_then(Value::as_i64)
                .ok_or("Invalid interval.")?;
            if n <= 0 || (creating && n < 60000) {
                return Err("Invalid interval.".into());
            }
        }
        Some("fixed_time") => {
            parse_time(
                o.get("timeOfDay")
                    .and_then(Value::as_str)
                    .ok_or("Invalid time of day.")?,
            )?;
            if let Some(days) = o.get("weekdays") {
                if !days
                    .as_array()
                    .is_some_and(|a| a.iter().all(|v| v.as_u64().is_some_and(|n| n <= 6)))
                {
                    return Err("Invalid weekdays.".into());
                }
            }
        }
        Some("once") => {
            let t = instant(
                o.get("runAt")
                    .and_then(Value::as_str)
                    .ok_or("Invalid run time.")?,
            )?;
            o.insert("runAt".into(), json!(iso(t)));
        }
        Some("webhook") => {
            crate::webhook_admission::validate_schedule(value)?;
            if let Some(sig) = o.get_mut("signature").and_then(Value::as_object_mut) {
                sig.remove("secret");
                sig.remove("secretRef");
                if let Some(h) = sig.get("header").and_then(Value::as_str) {
                    sig.insert("header".into(), json!(h.to_lowercase()));
                }
            }
        }
        _ => return Err("Invalid schedule.".into()),
    }
    Ok(s)
}
fn weekdays(s: &Value) -> Vec<u64> {
    let mut v = s
        .get("weekdays")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
        .unwrap_or_default();
    v.sort_unstable();
    v.dedup();
    if v.len() == 7 {
        v.clear()
    }
    v
}
/// Schedules compare semantically so edits do not shift the next occurrence.
pub fn same_schedule(a: &Value, b: &Value) -> bool {
    let kind = a.get("type").and_then(Value::as_str);
    if kind != b.get("type").and_then(Value::as_str) {
        return false;
    }
    match kind {
        Some("interval") => a.get("everyMs") == b.get("everyMs"),
        Some("webhook") => true,
        Some("once") => {
            a.get("runAt")
                .and_then(Value::as_str)
                .and_then(|v| instant(v).ok())
                == b.get("runAt")
                    .and_then(Value::as_str)
                    .and_then(|v| instant(v).ok())
        }
        Some("fixed_time") => {
            a.get("timeOfDay")
                .and_then(Value::as_str)
                .and_then(|v| parse_time(v).ok())
                == b.get("timeOfDay")
                    .and_then(Value::as_str)
                    .and_then(|v| parse_time(v).ok())
                && weekdays(a) == weekdays(b)
        }
        _ => false,
    }
}
fn local_compatible(n: NaiveDateTime) -> Option<DateTime<Local>> {
    match Local.from_local_datetime(&n) {
        LocalResult::Single(t) => Some(t),
        LocalResult::Ambiguous(a, b) => Some(a.min(b)),
        LocalResult::None => {
            // Resolve gaps with the offset in effect immediately before the transition.
            let before = (1..=180).find_map(|minutes| {
                match Local.from_local_datetime(&(n - Duration::minutes(minutes))) {
                    LocalResult::Single(t) => Some(t),
                    LocalResult::Ambiguous(a, b) => Some(a.min(b)),
                    _ => None,
                }
            })?;
            let utc = n
                .and_utc()
                .checked_sub_signed(Duration::seconds(before.offset().local_minus_utc() as i64))?;
            Some(utc.with_timezone(&Local))
        }
    }
}
/// Calculate the next occurrence strictly after `from` in the process local zone.
pub fn next_run(schedule: &Value, enabled: bool, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if !enabled {
        return None;
    }
    match schedule.get("type")?.as_str()? {
        "webhook" => None,
        "once" => {
            let t = instant(schedule.get("runAt")?.as_str()?).ok()?;
            (t > from).then_some(t)
        }
        "interval" => from.checked_add_signed(Duration::try_milliseconds(
            schedule.get("everyMs")?.as_i64()?.max(60000),
        )?),
        "fixed_time" => {
            let (h, m) = parse_time(schedule.get("timeOfDay")?.as_str()?).ok()?;
            let days = weekdays(schedule);
            let date = from.with_timezone(&Local).date_naive();
            for offset in 0..=7 {
                let day = date.checked_add_signed(Duration::days(offset))?;
                let candidate = local_compatible(day.and_hms_opt(h, m, 0)?)?;
                let t = candidate.with_timezone(&Utc);
                if t > from
                    && (days.is_empty()
                        || days.contains(&(candidate.weekday().num_days_from_sunday() as u64)))
                {
                    return Some(t);
                }
            }
            None
        }
        _ => None,
    }
}
fn row_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let schedule: String = row.get(4)?;
    let ws: String = row.get(8)?;
    let model: String = row.get(9)?;
    let mut task = json!({"id":row.get::<_,String>(0)?,"title":row.get::<_,String>(1)?,"prompt":row.get::<_,String>(2)?,"enabled":row.get::<_,bool>(3)?,"schedule":serde_json::from_str::<Value>(&schedule).unwrap_or(Value::Null),"projectId":row.get::<_,String>(5)?,"threadId":row.get::<_,Option<String>>(6)?,"threadMode":row.get::<_,String>(7)?,"workspaceStrategy":serde_json::from_str::<Value>(&ws).unwrap_or(Value::Null),"modelSelection":serde_json::from_str::<Value>(&model).unwrap_or(Value::Null),"runtimeMode":row.get::<_,String>(10)?,"interactionMode":row.get::<_,String>(11)?,"createdBy":row.get::<_,String>(12)?,"creationSource":row.get::<_,String>(13)?,"createdAt":row.get::<_,String>(14)?,"updatedAt":row.get::<_,String>(15)?,"nextRunAt":row.get::<_,Option<String>>(16)?,"lastRunAt":row.get::<_,Option<String>>(17)?,"lastRunStatus":row.get::<_,String>(18)?,"lastRunError":row.get::<_,Option<String>>(19)?,"runCount":row.get::<_,i64>(20)?});
    if task["schedule"]["type"] == "webhook" {
        if let Some(token) = row.get::<_, Option<String>>(21)? {
            let id = row.get::<_, String>(0)?;
            let encoded: String = id
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect();
            task["webhook"] = json!({"path":format!("/api/hooks/{encoded}/{token}"),"url":null,"hasSecret":row.get::<_,Option<String>>(22)?.is_some()});
        }
    }
    Ok(task)
}
const SELECT:&str="SELECT task_id,title,prompt,enabled,schedule_json,project_id,thread_id,thread_mode,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_at,last_run_status,last_run_error,run_count,webhook_token,webhook_secret FROM scheduled_tasks";
pub fn get(db: &Connection, id: &str) -> Result<Option<Value>, String> {
    db.query_row(&format!("{SELECT} WHERE task_id=?1"), [id], row_value)
        .optional()
        .map_err(|e| e.to_string())
}
pub fn list(db: &Connection) -> Result<Vec<Value>, String> {
    let mut q = db
        .prepare(&format!("{SELECT} ORDER BY created_at DESC,task_id ASC"))
        .map_err(|e| e.to_string())?;
    let rows = q.query_map([], row_value).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}
/// Upsert the public fields of a task. Caller supplies the current time for deterministic execution.
/// Save a task and claim its secret reference in the same SQLite transaction.
/// Claims remain durable after a crash, so stale secret files cannot be reused.
pub fn upsert_with_secret_dir(
    db: &Connection,
    input: &Value,
    now: DateTime<Utc>,
    dir: &std::path::Path,
) -> Result<Value, String> {
    let reference = match input.pointer("/schedule/signature/secretRef") {
        None => return upsert(db, input, now),
        Some(v) => v.as_str().ok_or("That secretRef is not valid.")?,
    };
    if input["schedule"]["type"] != "webhook" {
        return Err("Invalid webhook signature.".into());
    }
    let project = input["projectId"].as_str().ok_or("Invalid projectId.")?;
    let task = input["id"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            input["commandId"]
                .as_str()
                .map(|id| format!("scheduled-task:{id}"))
        })
        .ok_or("A secretRef save requires an id or commandId.")?;
    db.execute_batch("SAVEPOINT secret_ref_save")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        db.execute_batch("CREATE TABLE IF NOT EXISTS t3_private_secret_ref_claims (ref TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, command_id TEXT)").map_err(|e|e.to_string())?;
        let claim: Option<(String,String,Option<String>)> = db.query_row("SELECT task_id,project_id,command_id FROM t3_private_secret_ref_claims WHERE ref=?1", [reference], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
        let command = input["commandId"].as_str();
        let mut rewritten = input.clone();
        let sig = rewritten
            .pointer_mut("/schedule/signature")
            .and_then(Value::as_object_mut)
            .ok_or("Invalid webhook signature.")?;
        sig.remove("secretRef");
        sig.remove("secret");
        if let Some((claimed_task, claimed_project, claimed_command)) = claim {
            if claimed_task != task
                || claimed_project != project
                || command.is_none()
                || claimed_command.as_deref() != command
            {
                return Err("That secretRef was already used or does not exist. Ask the user again with request_secret.".into());
            }
        } else {
            let secret = crate::secret_requests::read_for_claim(
                dir,
                reference,
                project,
                now.timestamp_millis(),
            )?;
            db.execute("INSERT INTO t3_private_secret_ref_claims(ref,task_id,project_id,command_id) VALUES (?1,?2,?3,?4)", params![reference,task,project,command]).map_err(|e|e.to_string())?;
            sig.insert("secret".into(), json!(secret));
        }
        upsert(db, &rewritten, now)
    })();
    match result {
        Ok(value) => {
            db.execute_batch("RELEASE secret_ref_save")
                .map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK TO secret_ref_save; RELEASE secret_ref_save");
            Err(error)
        }
    }
}
pub fn upsert(db: &Connection, input: &Value, now: DateTime<Utc>) -> Result<Value, String> {
    let strfield = |k: &str| {
        input
            .get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("Missing {k}."))
    };
    let title = strfield("title")?.trim();
    let prompt = strfield("prompt")?.trim();
    if title.is_empty() || prompt.is_empty() {
        return Err("Title and prompt must not be empty.".into());
    }
    for key in [
        "enabled",
        "workspaceStrategy",
        "modelSelection",
        "runtimeMode",
        "interactionMode",
    ] {
        if input.get(key).is_none() {
            return Err(format!("Missing {key}."));
        }
    }
    let project = strfield("projectId")?.trim();
    if project.is_empty() {
        return Err("Invalid projectId.".into());
    }
    for key in ["id", "commandId", "threadId"] {
        if let Some(v) = input.get(key) {
            if !(v.as_str().is_some_and(|s| !s.trim().is_empty())
                || key == "threadId" && v.is_null())
            {
                return Err(format!("Invalid {key}."));
            }
        }
    }
    if input
        .get("requireExisting")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err("Invalid requireExisting.".into());
    }
    let enum_field = |key: &str, allowed: &[&str]| -> Result<(), String> {
        if !input
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|v| allowed.contains(&v))
        {
            return Err(format!("Invalid {key}."));
        }
        Ok(())
    };
    enum_field(
        "runtimeMode",
        &[
            "approval-required",
            "auto-accept-edits",
            "auto",
            "full-access",
        ],
    )?;
    enum_field("interactionMode", &["default", "plan"])?;
    if input.get("createdBy").is_some() {
        enum_field("createdBy", &["user", "agent", "system"])?;
    }
    if input.get("creationSource").is_some() {
        enum_field(
            "creationSource",
            &["web", "mobile", "mcp", "provider", "server"],
        )?;
    }
    let ws = input
        .get("workspaceStrategy")
        .and_then(Value::as_object)
        .ok_or("Invalid workspaceStrategy.")?;
    let nonblank = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
    };
    match ws.get("type").and_then(Value::as_str) {
        Some("root") => {}
        Some("existing_worktree") if nonblank(ws.get("worktreePath")) => {}
        Some("worktree")
            if nonblank(ws.get("baseRef"))
                && ws.get("startFromOrigin").is_none_or(Value::is_boolean) => {}
        _ => return Err("Invalid workspaceStrategy.".into()),
    }
    if ws.get("branch").is_some_and(|v| !nonblank(Some(v))) {
        return Err("Invalid workspaceStrategy.".into());
    }
    let mut model = input
        .get("modelSelection")
        .and_then(Value::as_object)
        .cloned()
        .ok_or("Invalid modelSelection.")?;
    if !model.contains_key("instanceId") {
        if let Some(provider) = model.get("provider").cloned() {
            model.insert("instanceId".into(), provider);
        }
    }
    if !nonblank(model.get("instanceId")) || !nonblank(model.get("model")) {
        return Err("Invalid modelSelection.".into());
    }
    if let Some(options) = model.get("options") {
        if !options.is_object()
            && !options.as_array().is_some_and(|a| {
                a.iter().all(|v| {
                    nonblank(v.get("id"))
                        && v.get("value")
                            .is_some_and(|x| x.is_boolean() || nonblank(Some(x)))
                })
            })
        {
            return Err("Invalid modelSelection.".into());
        }
    }
    model.remove("provider");
    let id = input
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "scheduled-task:{}",
                input
                    .get("commandId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| Uuid::new_v4().to_string())
            )
        });
    let old = get(db, &id)?;
    if input.get("requireExisting").and_then(Value::as_bool) == Some(true) && old.is_none() {
        return Err("Schedule task not found.".into());
    }
    let schedule = normalize_schedule(input.get("schedule").ok_or("Missing schedule.")?, true)?;
    let is_webhook = schedule["type"] == "webhook";
    let old_credentials: Option<(Option<String>, Option<String>)> = db
        .query_row(
            "SELECT webhook_token,webhook_secret FROM scheduled_tasks WHERE task_id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (token, secret, secret_changed) = if is_webhook {
        let signature = input["schedule"].get("signature").filter(|v| !v.is_null());
        let existing_secret = old_credentials.as_ref().and_then(|(_, s)| s.clone());
        let secret = if let Some(sig) = signature {
            if !sig.is_object()
                || sig["header"].as_str().is_none_or(|s| s.trim().is_empty())
                || !matches!(sig["encoding"].as_str(), Some("hex" | "base64"))
                || !sig["prefix"].is_string()
            {
                return Err("Invalid webhook signature.".into());
            }
            if sig.get("secretRef").is_some() {
                return Err("Webhook secret references are not supported yet.".into());
            }
            if sig
                .get("secret")
                .is_some_and(|v| v.as_str().is_none_or(|s| s.is_empty()))
            {
                return Err("Invalid webhook secret.".into());
            }
            Some(
                sig.get("secret")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or(existing_secret)
                    .ok_or("A webhook signature check needs a signing secret.")?,
            )
        } else {
            None
        };
        let changed = signature.is_none()
            || signature.is_some_and(|s| s.get("secret").is_some())
            || old_credentials.is_none();
        let token = match old_credentials.as_ref().and_then(|(t, _)| t.clone()) {
            Some(t) => t,
            None => new_webhook_token()?,
        };
        (Some(token), secret, changed)
    } else {
        (None, None, true)
    };
    let enabled = input
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or("Invalid enabled flag.")?;
    let unchanged = old
        .as_ref()
        .is_some_and(|o| o["enabled"] == enabled && same_schedule(&o["schedule"], &schedule));
    let next = if unchanged {
        old.as_ref()
            .and_then(|o| o["nextRunAt"].as_str().map(str::to_owned))
    } else {
        next_run(&schedule, enabled, now).map(iso)
    };
    if enabled && schedule["type"] == "once" && !unchanged && next.is_none() {
        return Err("The run time has passed. Pick a time in the future.".into());
    }
    let mut thread = input.get("threadId").and_then(Value::as_str);
    let unbind_thread = input.get("unbindThread").and_then(Value::as_bool) == Some(true);
    let unbound_thread_id = if thread.is_none() && unbind_thread {
        old.as_ref().and_then(|o| o["threadId"].as_str())
    } else {
        None
    };
    if old
        .as_ref()
        .is_some_and(|o| o["projectId"] != project && o["threadId"].as_str() == thread)
    {
        thread = None;
    }
    let oldmode = old.as_ref().and_then(|o| o["threadMode"].as_str());
    if input.get("threadMode").is_some_and(|v| !v.is_string()) {
        return Err("Invalid thread mode.".into());
    }
    let mode = input
        .get("threadMode")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            let stored = oldmode.unwrap_or("new_thread");
            if stored == "new_thread" && thread.is_some() {
                "continue"
            } else {
                stored
            }
        });
    if !["new_thread", "continue", "fresh_session"].contains(&mode) {
        return Err("Invalid thread mode.".into());
    }
    let ws = input
        .get("workspaceStrategy")
        .cloned()
        .unwrap_or(json!({"type":"root"}))
        .to_string();
    let model = Value::Object(model).to_string();
    let ts = iso(now);
    db.execute("INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,thread_id,thread_mode,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count,webhook_token,webhook_secret) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15,?16,'never',0,?18,?19) ON CONFLICT(task_id) DO UPDATE SET title=excluded.title,prompt=excluded.prompt,enabled=excluded.enabled,schedule_json=excluded.schedule_json,project_id=excluded.project_id,thread_id=CASE WHEN excluded.thread_mode='new_thread' THEN NULL WHEN scheduled_tasks.project_id != excluded.project_id THEN excluded.thread_id ELSE COALESCE(excluded.thread_id,NULLIF(scheduled_tasks.thread_id,?21)) END,thread_mode=excluded.thread_mode,workspace_strategy_json=excluded.workspace_strategy_json,model_selection_json=excluded.model_selection_json,runtime_mode=excluded.runtime_mode,interaction_mode=excluded.interaction_mode,creation_source=excluded.creation_source,updated_at=excluded.updated_at,next_run_at=CASE WHEN ?17 THEN scheduled_tasks.next_run_at ELSE excluded.next_run_at END,webhook_token=CASE WHEN excluded.webhook_token IS NULL THEN NULL ELSE COALESCE(scheduled_tasks.webhook_token,excluded.webhook_token) END,webhook_secret=CASE WHEN ?20 THEN excluded.webhook_secret ELSE scheduled_tasks.webhook_secret END",params![id,title,prompt,enabled,schedule.to_string(),project,if mode=="new_thread" {None}else{thread},mode,ws,model,input["runtimeMode"].as_str().unwrap_or("full-access"),input["interactionMode"].as_str().unwrap_or("default"),input["createdBy"].as_str().unwrap_or("user"),input["creationSource"].as_str().unwrap_or("web"),ts,next,unchanged,token,secret,secret_changed,unbound_thread_id]).map_err(|e|e.to_string())?;
    get(db, &id)?.ok_or_else(|| "Schedule task not found.".into())
}
fn new_webhook_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not generate webhook token.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
/// Rotate the URL credential for an existing webhook task.
pub fn rotate_webhook_token(
    db: &Connection,
    id: &str,
    now: DateTime<Utc>,
) -> Result<Value, String> {
    let task = get(db, id)?.ok_or("Schedule task not found.")?;
    if task["schedule"]["type"] != "webhook" {
        return Err("Only webhook tasks have a URL token.".into());
    }
    let token = new_webhook_token()?;
    let changed = db.execute("UPDATE scheduled_tasks SET webhook_token=?2,updated_at=?3 WHERE task_id=?1 AND created_at=?4", params![id, token, iso(now), task["createdAt"].as_str()]).map_err(|e|e.to_string())?;
    if changed == 0 {
        return Err("Schedule task was deleted or replaced.".into());
    }
    get(db, id)?.ok_or_else(|| "Schedule task not found.".into())
}
pub fn set_enabled(
    db: &Connection,
    id: &str,
    enabled: bool,
    now: DateTime<Utc>,
) -> Result<Value, String> {
    let task = get(db, id)?.ok_or("Schedule task not found.")?;
    if task["enabled"] == enabled {
        return Ok(task);
    }
    let next = next_run(&task["schedule"], enabled, now).map(iso);
    if enabled && task["schedule"]["type"] == "once" && next.is_none() {
        return Err("The run time has passed. Pick a time in the future.".into());
    }
    db.execute(
        "UPDATE scheduled_tasks SET enabled=?2,next_run_at=?3,updated_at=?4 WHERE task_id=?1",
        params![id, enabled, next, iso(now)],
    )
    .map_err(|e| e.to_string())?;
    get(db, id)?.ok_or_else(|| "Schedule task not found.".into())
}
pub fn delete(db: &mut Connection, id: &str) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM scheduled_task_webhook_deliveries WHERE task_id=?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM scheduled_tasks WHERE task_id=?1", [id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Return due tasks in deterministic order, rescheduling stale fixed-time occurrences.
/// Invalid timestamps are ignored rather than preventing other tasks from running.
pub fn due_tasks(db: &Connection, now: DateTime<Utc>) -> Result<Vec<Value>, String> {
    let mut stmt = db.prepare(&format!("{SELECT} WHERE enabled=1 AND next_run_at IS NOT NULL AND last_run_status <> 'running' ORDER BY next_run_at,task_id")).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_value).map_err(|e| e.to_string())?;
    let mut due = Vec::new();
    for row in rows {
        let task = row.map_err(|e| e.to_string())?;
        let Some(at) = task["nextRunAt"].as_str().and_then(|s| instant(s).ok()) else {
            continue;
        };
        if at > now {
            continue;
        }
        if task["schedule"]["type"] == "fixed_time"
            && now.signed_duration_since(at) > Duration::minutes(10)
        {
            let next = next_run(&task["schedule"], true, now).map(iso);
            db.execute("UPDATE scheduled_tasks SET next_run_at=?2,updated_at=?3,last_run_status='failed',last_run_error=?4 WHERE task_id=?1 AND next_run_at IS ?5 AND last_run_at IS ?6 AND enabled=1 AND last_run_status <> 'running'", params![task["id"].as_str(), next, iso(now), "Missed a scheduled run because the server was not running at that time.", task["nextRunAt"].as_str(), task["lastRunAt"].as_str()]).map_err(|e| e.to_string())?;
        } else {
            due.push(task);
        }
    }
    Ok(due)
}

/// Claim a run atomically. Scheduled claims recheck the due time; manual claims
/// can run disabled tasks. Returns None for a stale scheduled snapshot.
pub fn begin_run(
    db: &Connection,
    id: &str,
    scheduled: bool,
    started: DateTime<Utc>,
) -> Result<Option<Value>, String> {
    let Some(task) = get(db, id)? else {
        return if scheduled {
            Ok(None)
        } else {
            Err("Schedule task not found.".into())
        };
    };
    if !scheduled && task["schedule"]["type"] == "webhook" {
        return Err("Webhook tasks run when their URL receives a request.".into());
    }
    if task["lastRunStatus"] == "running" {
        return if scheduled {
            Ok(None)
        } else {
            Err("Schedule task is already running.".into())
        };
    }
    if scheduled
        && (!task["enabled"].as_bool().unwrap_or(false)
            || task["nextRunAt"]
                .as_str()
                .and_then(|s| instant(s).ok())
                .is_none_or(|t| t > started))
    {
        return Ok(None);
    }
    if scheduled && task["schedule"]["type"] != "once" {
        if let Some(thread) = task["threadId"].as_str() {
            let queued = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.status='queued' AND json_extract(m.payload_json,'$.scheduledTaskId')=?2)", params![thread,id], |r| r.get::<_,bool>(0)).unwrap_or(false);
            if queued {
                let next = next_run(&task["schedule"], true, started).map(iso);
                db.execute("UPDATE scheduled_tasks SET next_run_at=?2,updated_at=?3 WHERE task_id=?1 AND enabled=1 AND next_run_at IS ?4 AND last_run_at IS ?5 AND last_run_status <> 'running'", params![id,next,iso(started),task["nextRunAt"].as_str(),task["lastRunAt"].as_str()]).map_err(|e| e.to_string())?;
                return Ok(None);
            }
        }
    }
    let count = db.execute("UPDATE scheduled_tasks SET updated_at=?2,last_run_at=?2,last_run_status='running',last_run_error=NULL,last_run_webhook_delivery_id=NULL WHERE task_id=?1 AND created_at=?3 AND last_run_status <> 'running' AND (?4=0 OR (enabled=1 AND next_run_at IS ?5))", params![id,iso(started),task["createdAt"].as_str(),scheduled,task["nextRunAt"].as_str()]).map_err(|e| e.to_string())?;
    if count == 0 {
        return if scheduled {
            Ok(None)
        } else {
            Err("Schedule task is already running.".into())
        };
    }
    get(db, id)
}

/// Complete only the claimed incarnation and attempt, preserving concurrent edits.
pub fn complete_run(
    db: &Connection,
    claimed: &Value,
    completed: DateTime<Utc>,
    error: Option<&str>,
) -> Result<Option<Value>, String> {
    let id = claimed["id"].as_str().ok_or("Missing task id.")?;
    let started = claimed["lastRunAt"].as_str().ok_or("Missing run start.")?;
    let Some(current) = get(db, id)? else {
        return Ok(None);
    };
    let from = if current["schedule"]["type"] == "once" {
        instant(started)?
    } else {
        completed
    };
    let next = next_run(
        &current["schedule"],
        current["enabled"].as_bool().unwrap_or(false),
        from,
    )
    .map(iso);
    let count = db.execute("UPDATE scheduled_tasks SET updated_at=?2,next_run_at=?3,last_run_status=?4,last_run_error=?5,run_count=run_count+1 WHERE task_id=?1 AND created_at=?6 AND last_run_status='running' AND last_run_at=?7", params![id,iso(completed),next,if error.is_some(){"failed"}else{"succeeded"},error,claimed["createdAt"].as_str(),started]).map_err(|e| e.to_string())?;
    if count == 0 {
        Ok(None)
    } else {
        get(db, id)
    }
}

/// Bind a newly created thread only if the task still refers to the same project.
pub fn bind_thread(db: &Connection, claimed: &Value, thread_id: &str) -> Result<(), String> {
    db.execute("UPDATE scheduled_tasks SET thread_id=?2 WHERE task_id=?1 AND created_at=?3 AND project_id=?4 AND thread_id IS NULL AND thread_mode <> 'new_thread'", params![claimed["id"].as_str(),thread_id,claimed["createdAt"].as_str(),claimed["projectId"].as_str()]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Fail interrupted attempts before starting the scheduler.
pub fn recover_interrupted(db: &Connection, now: DateTime<Utc>) -> Result<usize, String> {
    let tasks = list(db)?;
    let mut count = 0;
    for task in tasks
        .into_iter()
        .filter(|t| t["lastRunStatus"] == "running")
    {
        // A webhook dispatch persists its attempt and command id in the pending
        // row, so the webhook worker can safely retry it after a restart.
        let has_dispatch: bool = task["schedule"]["type"] == "webhook" && db.query_row("SELECT EXISTS(SELECT 1 FROM scheduled_task_webhook_pending WHERE task_id=?1 AND state='dispatching' AND json_extract(task_json,'$.lastRunAt')=?2)", params![task["id"].as_str(), task["lastRunAt"].as_str()], |r|r.get(0)).map_err(|e|e.to_string())?;
        if has_dispatch {
            continue;
        }
        let from = if task["schedule"]["type"] == "once" {
            task["lastRunAt"]
                .as_str()
                .and_then(|s| instant(s).ok())
                .unwrap_or(now)
        } else {
            now
        };
        let next = next_run(
            &task["schedule"],
            task["enabled"].as_bool().unwrap_or(false),
            from,
        )
        .map(iso);
        count += db.execute("UPDATE scheduled_tasks SET updated_at=?2,next_run_at=?3,last_run_status='failed',last_run_error='Run was interrupted by a server restart.',run_count=run_count+1 WHERE task_id=?1 AND created_at=?4 AND last_run_status='running' AND last_run_at IS ?5",params![task["id"].as_str(),iso(now),next,task["createdAt"].as_str(),task["lastRunAt"].as_str()]).map_err(|e| e.to_string())?;
    }
    Ok(count)
}

fn fire_key(claimed: &Value, trigger: &str) -> Result<String, String> {
    let id = claimed["id"].as_str().ok_or("Missing task id.")?;
    if trigger == "webhook" {
        if let Some(delivery) = claimed["_webhookDeliveryId"].as_str() {
            return Ok(format!("{id}:webhook:{delivery}"));
        }
    }
    // Old persisted dispatches must retain their original identity on recovery.
    let started = claimed["lastRunAt"].as_str().ok_or("Missing run start.")?;
    Ok(format!(
        "{}:{}:{}",
        id,
        instant(started)?.timestamp_millis(),
        trigger
    ))
}

/// Dispatch a claimed task to its bound thread through the regular durable queue.
fn dispatch_bound_mode(
    bus: &crate::event_bus::EventBus,
    claimed: &Value,
    trigger: &str,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
    deferred: bool,
) -> Result<(), String> {
    use crate::message_commands::{self, DispatchError, DispatchMessage};
    let thread = claimed["threadId"]
        .as_str()
        .ok_or("Task has no bound thread.")?;
    let id = claimed["id"].as_str().ok_or("Missing task id.")?;
    let started = claimed["lastRunAt"].as_str().ok_or("Missing run start.")?;
    let fire = fire_key(claimed, trigger)?;
    let command = format!("scheduled-task:{fire}");
    let message = format!("scheduled-task-message:{fire}");
    let result = bus.commit_with(|tx| {
        if bus.shutdown_flag().load(std::sync::atomic::Ordering::SeqCst) {
            return Err(DispatchError::Database(rusqlite::Error::InvalidQuery));
        }
        let row: Option<(String, Option<String>, String)> = tx.query_row("SELECT t.project_id,COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root),t.payload_json FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1 AND t.deleted_at IS NULL AND t.archived_at IS NULL", [thread], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let (project, cwd, _) = row.ok_or(DispatchError::Database(rusqlite::Error::InvalidQuery))?;
        if claimed["projectId"].as_str() != Some(project.as_str()) { return Err(DispatchError::Database(rusqlite::Error::InvalidQuery)); }
        let cwd = cwd.unwrap_or_default();
        let cmd = DispatchMessage { context: None,command_id:&command,thread_id:thread,message_id:&message,text:claimed["prompt"].as_str().unwrap_or(""),attachments:&[],creation_source:claimed["creationSource"].as_str().unwrap_or("web"),cwd:&cwd,driver:"codex"};
        message_commands::dispatch_scheduled_message_tx(tx, cmd, started, id, claimed["threadMode"] == "fresh_session", if deferred { Some(&claimed["workspaceStrategy"]) } else { None }, sessions)
    }).map_err(|e: DispatchError| e.to_string())?;
    if result.receipt.status != "accepted" {
        return Err(result
            .receipt
            .error
            .unwrap_or_else(|| "The run failed to start.".into()));
    }
    Ok(())
}

pub fn dispatch_bound(
    bus: &crate::event_bus::EventBus,
    claimed: &Value,
    trigger: &str,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<(), String> {
    dispatch_bound_mode(bus, claimed, trigger, sessions, false)
}

/// Launch a thread in its selected existing workspace and dispatch its first message.
pub(crate) fn start_scheduled_preparation(
    bus: &crate::event_bus::EventBus,
    claimed: &Value,
    trigger: &str,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<String, String> {
    use crate::thread_commands::{create_thread_ordered, CreateThread};
    let started = claimed["lastRunAt"].as_str().ok_or("Missing run start.")?;
    let fire = fire_key(claimed, trigger)?;
    let thread = format!("thread:scheduled:{fire}");
    let create_id = format!("scheduled-task-create:{fire}");
    let event_id = format!("scheduled-task-thread-created:{fire}");
    let source = claimed["creationSource"].clone();
    let worktree = claimed["workspaceStrategy"]["type"] == "worktree";
    if worktree {
        let result = create_thread_ordered(
            bus,
            CreateThread {
                command_id: &create_id,
                thread_id: &thread,
                project_id: claimed["projectId"].as_str().ok_or("Missing project id.")?,
                title: claimed["title"].as_str().ok_or("Missing title.")?,
                model_selection: &claimed["modelSelection"],
                runtime_mode: claimed["runtimeMode"].as_str().unwrap_or("full-access"),
                interaction_mode: claimed["interactionMode"].as_str().unwrap_or("default"),
                branch: None,
                worktree_path: None,
                created_by: claimed["createdBy"].as_str().unwrap_or("user"),
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            &event_id,
            started,
        )
        .map_err(|e| e.to_string())?;
        if result.receipt.status != "accepted" {
            return Err(result
                .receipt
                .error
                .unwrap_or_else(|| "Unable to create scheduled thread.".into()));
        }
        let mut target = claimed.clone();
        target["threadId"] = json!(thread);
        dispatch_bound_mode(bus, &target, trigger, sessions, true)?;
    }
    Ok(thread)
}

fn dispatch_new_thread_inner(
    bus: &crate::event_bus::EventBus,
    claimed: &Value,
    trigger: &str,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<String, String> {
    use crate::thread_commands::{create_thread_ordered, CreateThread};
    if bus
        .shutdown_flag()
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("Server is shutting down.".into());
    }
    let id = claimed["id"].as_str().ok_or("Missing task id.")?;
    let started = claimed["lastRunAt"].as_str().ok_or("Missing run start.")?;
    let fire = fire_key(claimed, trigger)?;
    let thread = format!("thread:scheduled:{fire}");
    let create_id = format!("scheduled-task-create:{fire}");
    let event_id = format!("scheduled-task-thread-created:{fire}");
    let source = claimed["creationSource"].clone();
    let worktree = claimed["workspaceStrategy"]["type"] == "worktree";
    if worktree {
        start_scheduled_preparation(bus, claimed, trigger, sessions)?;
    }
    let preparation_lock = if claimed["workspaceStrategy"]["type"] == "worktree" {
        Some(bus.lock_worktree_preparation().map_err(|e| e.to_string())?)
    } else {
        None
    };
    let preparation = if claimed["workspaceStrategy"]["type"] == "worktree" {
        let project = claimed["projectId"].as_str().ok_or("Missing project id.")?;
        let existing = bus.with_autocommit(|db| -> Result<Option<(String, String)>, String> {
            db.query_row("SELECT json_extract(payload_json,'$.worktreePath'),json_extract(payload_json,'$.branch') FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND project_id=?2 AND json_extract(payload_json,'$.worktreePath') IS NOT NULL AND json_extract(payload_json,'$.branch') IS NOT NULL", params![thread, project], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e| e.to_string())
        }).map_err(|e| e.to_string())??;
        if let Some((path, branch)) = existing {
            Some((path, branch, None))
        } else {
            let trees = bus
                .worktrees_dir()
                .ok_or("Worktree directory is unavailable.")?;
            let root: String = bus
                .with_autocommit(|db| {
                    db.query_row(
                        "SELECT workspace_root FROM projection_projects WHERE project_id=?1",
                        [project],
                        |r| r.get(0),
                    )
                })
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            let base = claimed["workspaceStrategy"]["baseRef"]
                .as_str()
                .unwrap_or("HEAD");
            let fetched = if claimed["workspaceStrategy"]["startFromOrigin"] == true {
                crate::scheduled_worktree_journal::fetch_base(std::path::Path::new(&root), base)?
            } else {
                None
            };
            let (mut p, commit) = crate::scheduled_worktree_journal::checkout_plan(
                id,
                &thread,
                std::path::Path::new(&root),
                &trees,
                fetched.as_deref().unwrap_or(base),
                claimed["workspaceStrategy"]["branch"].as_str(),
                started,
            )?;
            bus.with_autocommit(|db| {
                crate::scheduled_worktree_journal::initialize(db)?;
                crate::scheduled_worktree_journal::plan(db, &p)
            })
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
            crate::scheduled_worktree_journal::create_planned_checkout(&p, &commit)?;
            let advanced = bus
                .with_autocommit(|db| {
                    crate::scheduled_worktree_journal::advance(db, &p.run_key, "planned", "created")
                })
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            if !advanced {
                return Err("Worktree preparation was concurrently recovered".into());
            }
            p.phase = "created".into();
            let settings = bus
                .setup_context()
                .map(|(_, settings)| settings)
                .unwrap_or_else(|| json!({}));
            let setting = settings["projectSettingsOverrides"][project]["worktreeSubmodules"]
                .as_str()
                .or_else(|| settings["worktreeSubmodules"].as_str());
            if let Err(error) = crate::scheduled_worktree_journal::initialize_submodules(
                std::path::Path::new(&p.worktree_path),
                setting,
            ) {
                eprintln!("Warning: scheduled worktree submodule initialization failed: {error}");
            }
            Some((p.worktree_path.clone(), p.branch.clone(), Some(p.run_key)))
        }
    } else {
        None
    };
    if bus
        .shutdown_flag()
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("Server is shutting down.".into());
    }
    let result = create_thread_ordered(
        bus,
        CreateThread {
            command_id: &create_id,
            thread_id: &thread,
            project_id: claimed["projectId"].as_str().ok_or("Missing project id.")?,
            title: claimed["title"].as_str().ok_or("Missing title.")?,
            model_selection: &claimed["modelSelection"],
            runtime_mode: claimed["runtimeMode"].as_str().unwrap_or("full-access"),
            interaction_mode: claimed["interactionMode"].as_str().unwrap_or("default"),
            branch: preparation
                .as_ref()
                .map(|p| p.1.as_str())
                .or_else(|| claimed["workspaceStrategy"]["branch"].as_str()),
            worktree_path: if let Some(p) = &preparation {
                Some(&p.0)
            } else if claimed["workspaceStrategy"]["type"] == "existing_worktree" {
                claimed["workspaceStrategy"]["worktreePath"].as_str()
            } else {
                None
            },
            created_by: claimed["createdBy"].as_str().unwrap_or("user"),
            creation_source: &source,
            link_origin: None,
            delegated_from: None,
        },
        &event_id,
        started,
    )
    .map_err(|e| e.to_string())?;
    if result.receipt.status != "accepted" {
        return Err(result
            .receipt
            .error
            .unwrap_or_else(|| "Unable to create scheduled thread.".into()));
    }
    if let Some((path, branch, _)) = &preparation {
        let result = crate::thread_metadata::dispatch(
            bus,
            &format!("scheduled-task-workspace:{fire}"),
            &thread,
            &json!({"branch":branch,"worktreePath":path}),
            started,
        )
        .map_err(|e| e.to_string())?;
        if result.receipt.status != "accepted" {
            return Err(result
                .receipt
                .error
                .unwrap_or_else(|| "Unable to attach scheduled worktree.".into()));
        }
    }
    if let Some((_, _, Some(key))) = &preparation {
        bus.with_autocommit(|db| {
            crate::scheduled_worktree_journal::advance(db, key, "created", "attached")
        })
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    }
    drop(preparation_lock);
    if let Some((path, _, _)) = &preparation {
        let setup_done = bus.with_autocommit(|db| -> rusqlite::Result<bool> {
            crate::scheduled_worktree_journal::initialize(db)?;
            db.query_row("SELECT EXISTS(SELECT 1 FROM scheduled_worktree_setup_completed WHERE thread_id=?1)", [&thread], |r| r.get(0))
        }).map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        if !setup_done {
            let project = claimed["projectId"].as_str().ok_or("Missing project id.")?;
            let (root, scripts): (String, String) = bus.with_autocommit(|db| db.query_row(
            "SELECT workspace_root,scripts_json FROM projection_projects WHERE project_id=?1", [project], |r| Ok((r.get(0)?, r.get(1)?))
        )).map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            let scripts: Value = serde_json::from_str(&scripts).map_err(|e| e.to_string())?;
            if let Some((terminals, settings)) = bus.setup_context() {
                crate::scheduled_setup::run(
                    &terminals,
                    &settings,
                    project,
                    &root,
                    &scripts,
                    &thread,
                    path,
                    &bus.shutdown_flag(),
                )?;
            } else if crate::project_setup::setup_script(&json!({}), project, &scripts).is_some() {
                return Err("Scheduled worktree setup is unavailable.".into());
            }
            bus.with_autocommit(|db| db.execute("INSERT OR IGNORE INTO scheduled_worktree_setup_completed(thread_id) VALUES (?1)", [&thread]))
            .map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        }
    }
    if bus
        .shutdown_flag()
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("Server is shutting down.".into());
    }
    let mut target = claimed.clone();
    target["threadId"] = json!(thread);
    if worktree {
        let run = crate::message_commands::run_id(&thread, 1);
        let command = json!({"type":"prepared-run.release","commandId":format!("scheduled-task-release:{fire}"),"threadId":thread,"runId":run});
        let path = preparation
            .as_ref()
            .map(|p| p.0.as_str())
            .ok_or("Missing worktree path.")?;
        let result = crate::message_commands::prepared_run_command(
            bus,
            &command,
            path,
            &chrono::Utc::now().to_rfc3339(),
        )
        .map_err(|e| e.to_string())?;
        if result.receipt.status != "accepted" {
            return Err(result
                .receipt
                .error
                .unwrap_or_else(|| "Unable to release scheduled run.".into()));
        }
    } else {
        dispatch_bound(bus, &target, trigger, sessions)?;
    }
    bus.commit(|tx| {
        bind_thread(tx, claimed, &thread).map_err(|_| rusqlite::Error::InvalidQuery)?;
        Ok(((), vec![]))
    })
    .map_err(|e| e.to_string())?;
    Ok(thread)
}

pub fn dispatch_new_thread(
    bus: &crate::event_bus::EventBus,
    claimed: &Value,
    trigger: &str,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<String, String> {
    let result = dispatch_new_thread_inner(bus, claimed, trigger, sessions);
    if let Err(error) = &result {
        if claimed["workspaceStrategy"]["type"] == "worktree" {
            if let Ok(fire) = fire_key(claimed, trigger) {
                let thread = format!("thread:scheduled:{fire}");
                let command = json!({"type":"prepared-run.fail","commandId":format!("scheduled-task-fail:{fire}"),"threadId":thread,"runId":crate::message_commands::run_id(&thread, 1),"failure":{"message":error}});
                let _ = crate::message_commands::prepared_run_command(
                    bus,
                    &command,
                    "",
                    &chrono::Utc::now().to_rfc3339(),
                );
            }
        }
    }
    result
}

/// Claim, dispatch, and settle a single run. Dispatch errors are recorded on the task.
pub fn run_task(
    bus: &crate::event_bus::EventBus,
    id: &str,
    scheduled: bool,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<Option<Value>, String> {
    run_task_checked(bus, id, scheduled, sessions, |_| Ok(()))
}

/// Check authorization in the same transaction that claims the run.
pub fn run_task_checked(
    bus: &crate::event_bus::EventBus,
    id: &str,
    scheduled: bool,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
    authorize: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
) -> Result<Option<Value>, String> {
    let claim = bus
        .commit(|tx| {
            let result = authorize(tx).and_then(|()| begin_run(tx, id, scheduled, Utc::now()));
            Ok((result, vec![]))
        })
        .map_err(|e| e.to_string())??;
    let Some(claim) = claim else { return Ok(None) };
    execute_claim(bus, claim, scheduled, sessions)
}

fn execute_claim(
    bus: &crate::event_bus::EventBus,
    claim: Value,
    scheduled: bool,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<Option<Value>, String> {
    let trigger = if scheduled { "scheduled" } else { "manual" };
    let result = if claim["threadId"].is_string() {
        dispatch_bound(bus, &claim, trigger, sessions)
    } else {
        dispatch_new_thread(bus, &claim, trigger, sessions).map(|_| ())
    };
    bus.commit(|tx| {
        Ok((
            complete_run(
                tx,
                &claim,
                Utc::now(),
                result.as_ref().err().map(String::as_str),
            ),
            vec![],
        ))
    })
    .map_err(|e| e.to_string())?
}

/// Publish the preparing run before returning and supervise its continuation.
fn run_background(
    bus: &crate::event_bus::EventBus,
    id: &str,
    scheduled: bool,
    sessions: std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    authorize: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
) -> Result<Option<Value>, String> {
    let claim = bus
        .commit(|tx| {
            Ok((
                authorize(tx).and_then(|()| begin_run(tx, id, scheduled, Utc::now())),
                vec![],
            ))
        })
        .map_err(|e| e.to_string())??;
    let Some(claim) = claim else { return Ok(None) };
    let trigger = if scheduled { "scheduled" } else { "manual" };
    if claim["threadId"].is_null() && claim["workspaceStrategy"]["type"] == "worktree" {
        let thread = match start_scheduled_preparation(bus, &claim, trigger, Some(&sessions)) {
            Ok(thread) => thread,
            Err(error) => {
                return bus
                    .commit(|tx| Ok((complete_run(tx, &claim, Utc::now(), Some(&error)), vec![])))
                    .map_err(|e| e.to_string())?
            }
        };
        let task = bus
            .commit(|tx| {
                bind_thread(tx, &claim, &thread).map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok((complete_run(tx, &claim, Utc::now(), None), vec![]))
            })
            .map_err(|e| e.to_string())??;
        let worker_bus = bus.clone();
        std::thread::spawn(move || {
            if let Err(error) = dispatch_new_thread(&worker_bus, &claim, trigger, Some(&sessions)) {
                eprintln!("Warning: scheduled task preparation failed: {error}");
            }
        });
        Ok(task)
    } else {
        execute_claim(bus, claim, scheduled, Some(&sessions))
    }
}

pub fn run_manual_background(
    bus: &crate::event_bus::EventBus,
    id: &str,
    sessions: std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
) -> Result<Option<Value>, String> {
    run_background(bus, id, false, sessions, |_| Ok(()))
}

pub fn run_manual_background_checked(
    bus: &crate::event_bus::EventBus,
    id: &str,
    sessions: std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    authorize: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
) -> Result<Option<Value>, String> {
    run_background(bus, id, false, sessions, authorize)
}

fn run_due_background(
    bus: &crate::event_bus::EventBus,
    sessions: std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
) -> Result<(), String> {
    bus.commit(|tx| {
        Ok((
            crate::scheduled_run_outcome::reconcile(tx, Utc::now()),
            vec![],
        ))
    })
    .map_err(|e| e.to_string())??;
    let due = bus
        .commit(|tx| Ok((due_tasks(tx, Utc::now()), vec![])))
        .map_err(|e| e.to_string())??;
    for task in due {
        if let Some(id) = task["id"].as_str() {
            if let Err(error) = run_background(bus, id, true, sessions.clone(), |_| Ok(())) {
                eprintln!("Warning: scheduled task {id} failed: {error}");
            }
        }
    }
    Ok(())
}

/// One sequential scheduler tick, isolating individual task failures.
pub fn run_due(
    bus: &crate::event_bus::EventBus,
    sessions: Option<&crate::provider::session_registry::SessionRegistry>,
) -> Result<(), String> {
    bus.commit(|tx| {
        Ok((
            crate::scheduled_run_outcome::reconcile(tx, Utc::now()),
            vec![],
        ))
    })
    .map_err(|e| e.to_string())??;
    let due = bus
        .commit(|tx| Ok((due_tasks(tx, Utc::now()), vec![])))
        .map_err(|e| e.to_string())??;
    for task in due {
        if let Some(id) = task["id"].as_str() {
            if let Err(error) = run_task(bus, id, true, sessions) {
                eprintln!("Warning: scheduled task {id} failed: {error}");
            }
        }
    }
    Ok(())
}

/// Recover interrupted runs before processing any due work, then poll every five seconds.
pub async fn run_scheduler(
    bus: crate::event_bus::EventBus,
    sessions: std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    webhook_allowed: bool,
) {
    let recovery_bus = bus.clone();
    let recovery = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let pending = recovery_bus
            .with_autocommit(|db| -> rusqlite::Result<_> {
                crate::scheduled_worktree_journal::initialize(db)?;
                crate::scheduled_worktree_journal::reconcile_attached(db)?;
                crate::scheduled_worktree_journal::pending(db)
            })
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        for p in pending {
            if crate::scheduled_worktree_journal::remove_orphan_checkout(&p)? {
                recovery_bus
                    .with_autocommit(|db| {
                        crate::scheduled_worktree_journal::forget(db, &p.run_key, &p.phase)
                    })
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?;
            }
        }
        // A process restart cannot resume the in-memory setup worker. Fail its
        // published preparing run before settling the interrupted task.
        let interrupted = recovery_bus.with_autocommit(|db| -> rusqlite::Result<Vec<(String, String)>> {
            let mut stmt = db.prepare("SELECT r.thread_id,r.run_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') JOIN scheduled_tasks s ON s.task_id=json_extract(m.payload_json,'$.scheduledTaskId') WHERE r.status='preparing'")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect(); rows
        }).map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        for (thread, run) in interrupted {
            let command = json!({"type":"prepared-run.fail","commandId":format!("scheduled-task-recovery:{}", uuid::Uuid::new_v4()),"threadId":thread,"runId":run,"failure":{"message":"Run was interrupted by a server restart."}});
            crate::message_commands::prepared_run_command(&recovery_bus, &command, "", &Utc::now().to_rfc3339()).map_err(|e| e.to_string())?;
        }
        recovery_bus
            .commit(|tx| {
                crate::scheduled_worktree_journal::initialize(tx)?;
                crate::scheduled_worktree_journal::reconcile_attached(tx)?;
                Ok((recover_interrupted(tx, Utc::now()), vec![]))
            })
            .map_err(|e| e.to_string())??;
        Ok(())
    })
    .await;
    match recovery {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            eprintln!("Warning: scheduled task recovery failed: {error}");
            return;
        }
        Err(error) => {
            eprintln!("Warning: scheduled task recovery worker failed: {error}");
            return;
        }
    }
    let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        timer.tick().await;
        let tick_bus = bus.clone();
        let tick_sessions = sessions.clone();
        match tokio::task::spawn_blocking(move || {
            run_due_background(&tick_bus, tick_sessions.clone())?;
            if webhook_allowed && cfg!(any(unix, windows)) {
                while crate::webhook_worker::run_one_background(&tick_bus, tick_sessions.clone())? {
                }
            }
            Ok::<_, String>(())
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("Warning: scheduled task scan failed: {error}"),
            Err(error) => {
                eprintln!("Warning: scheduled task worker failed: {error}");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_fire_identity_uses_delivery_not_clock_time() {
        let mut task =
            json!({"id":"task", "lastRunAt":"2026-01-01T00:00:00.000Z", "_webhookDeliveryId":"d1"});
        assert_eq!(fire_key(&task, "webhook").unwrap(), "task:webhook:d1");
        task["_webhookDeliveryId"] = json!("d2");
        assert_eq!(fire_key(&task, "webhook").unwrap(), "task:webhook:d2");
        task.as_object_mut().unwrap().remove("_webhookDeliveryId");
        assert_eq!(
            fire_key(&task, "webhook").unwrap(),
            "task:1767225600000:webhook"
        );
    }
    fn at(s: &str) -> DateTime<Utc> {
        instant(s).unwrap()
    }
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../migrations/055-scheduled-tasks.sql"))
            .unwrap();
        db.execute_batch(include_str!("../migrations/057.sql"))
            .unwrap();
        db.execute_batch(include_str!("../migrations/067.sql"))
            .unwrap();
        db.execute_batch(include_str!("../migrations/080.sql"))
            .unwrap();
        db
    }
    fn input() -> Value {
        json!({"commandId":"abc","title":"Title","prompt":"Prompt","enabled":true,"schedule":{"type":"interval","everyMs":60000},"projectId":"p","workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"})
    }
    #[test]
    fn schedule_equivalence_and_interval_math() {
        assert!(same_schedule(
            &json!({"type":"fixed_time","timeOfDay":"9:00","weekdays":[5,1,5]}),
            &json!({"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,5]})
        ));
        assert!(same_schedule(
            &json!({"type":"fixed_time","timeOfDay":"09:00"}),
            &json!({"type":"fixed_time","timeOfDay":"09:00","weekdays":[0,1,2,3,4,5,6]})
        ));
        assert!(same_schedule(
            &json!({"type":"once","runAt":"2026-11-01T03:00:00-05:00"}),
            &json!({"type":"once","runAt":"2026-11-01T08:00:00Z"})
        ));
        assert!(normalize_schedule(&json!({"type":"interval","everyMs":59999}), true).is_err());
        assert_eq!(
            next_run(
                &json!({"type":"interval","everyMs":30000}),
                true,
                at("2026-11-01T06:30:00Z")
            ),
            Some(at("2026-11-01T06:31:00Z"))
        );
    }
    #[test]
    fn edits_keep_schedule_and_run_state_and_enable_recalculates() {
        let db = db();
        let now = at("2026-01-01T00:00:00Z");
        let mut i = input();
        let first = upsert(&db, &i, now).unwrap();
        assert_eq!(first["id"], "scheduled-task:abc");
        assert_eq!(first["nextRunAt"], "2026-01-01T00:01:00.000Z");
        db.execute("UPDATE scheduled_tasks SET run_count=3,last_run_status='succeeded',next_run_at='2026-01-01T01:00:00.000Z'",[]).unwrap();
        i["title"] = json!("Changed");
        let changed = upsert(&db, &i, now + Duration::minutes(5)).unwrap();
        assert_eq!(changed["nextRunAt"], "2026-01-01T01:00:00.000Z");
        assert_eq!(changed["runCount"], 3);
        assert!(set_enabled(&db, "scheduled-task:abc", false, now).unwrap()["nextRunAt"].is_null());
        assert_eq!(
            set_enabled(&db, "scheduled-task:abc", true, now + Duration::minutes(5)).unwrap()
                ["nextRunAt"],
            "2026-01-01T00:06:00.000Z"
        );
    }
    #[test]
    fn once_and_webhooks_fail_safely() {
        let db = db();
        let mut i = input();
        i["schedule"] = json!({"type":"once","runAt":"2026-01-01T00:00:00Z"});
        assert!(upsert(&db, &i, at("2026-01-01T00:00:00Z")).is_err());
        assert!(list(&db).unwrap().is_empty());
    }
    #[test]
    fn webhook_credentials_persist_rotate_and_stay_private() {
        let db = db();
        let now = Utc::now();
        let mut i = input();
        i["enabled"] = json!(false);
        i["schedule"] = json!({"type":"webhook","signature":{"header":"X-Hub-Signature","encoding":"hex","prefix":"sha256=","secret":"private"}});
        let task = upsert(&db, &i, now).unwrap();
        assert!(task["webhook"]["path"]
            .as_str()
            .unwrap()
            .starts_with("/api/hooks/scheduled-task%3Aabc/"));
        assert_eq!(task["webhook"]["hasSecret"], true);
        assert!(!task.to_string().contains("private"));
        let credentials = || {
            db.query_row(
                "SELECT webhook_token,webhook_secret FROM scheduled_tasks",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .unwrap()
        };
        let first = credentials();
        assert_eq!(first.0.len(), 43);
        assert_eq!(first.1, "private");
        i["schedule"]["signature"]
            .as_object_mut()
            .unwrap()
            .remove("secret");
        upsert(&db, &i, now).unwrap();
        assert_eq!(credentials(), first);
        let rotated = rotate_webhook_token(&db, "scheduled-task:abc", now).unwrap();
        assert!(!rotated.to_string().contains("private"));
        let second = credentials();
        assert_ne!(second.0, first.0);
        assert_eq!(second.1, first.1);
        assert_eq!(
            set_enabled(&db, "scheduled-task:abc", true, now).unwrap()["enabled"],
            true
        );
        i["enabled"] = json!(true);
        assert_eq!(upsert(&db, &i, now).unwrap()["enabled"], true);
        i["enabled"] = json!(false);
        i["schedule"] = json!({"type":"interval","everyMs":60000});
        upsert(&db, &i, now).unwrap();
        let cleared: (Option<String>, Option<String>) = db
            .query_row(
                "SELECT webhook_token,webhook_secret FROM scheduled_tasks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(cleared, (None, None));
    }
    #[test]
    fn secret_ref_save_rolls_back_claim_and_replays_after_commit() {
        let db = db();
        let dir = std::env::temp_dir().join(format!("t3-ref-save-{}", Uuid::new_v4()));
        let now = Utc::now();
        let reference = crate::secret_requests::reference(&[4; 32], "thread", "item");
        crate::secret_requests::create(&dir, &reference, "p", "private", now.timestamp_millis())
            .unwrap();
        let mut i = input();
        i["enabled"] = json!(false);
        i["schedule"] = json!({"type":"webhook","signature":{"header":"x-sig","encoding":"hex","prefix":"","secretRef":reference}});
        db.execute_batch("BEGIN").unwrap();
        upsert_with_secret_dir(&db, &i, now, &dir).unwrap();
        db.execute_batch("ROLLBACK").unwrap();
        assert!(list(&db).unwrap().is_empty());
        crate::secret_requests::cleanup_claimed(&db, &dir).unwrap();
        let saved = upsert_with_secret_dir(&db, &i, now, &dir).unwrap();
        assert!(!saved.to_string().contains("private"));
        crate::secret_requests::cleanup_claimed(&db, &dir).unwrap();
        crate::secret_requests::cleanup_claimed(&db, &dir).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        i["schedule"]["signature"]["secret"] = json!("attacker");
        upsert_with_secret_dir(&db, &i, now, &dir).unwrap();
        let secret: String = db
            .query_row("SELECT webhook_secret FROM scheduled_tasks", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(secret, "private");
        i["commandId"] = json!("other");
        assert!(upsert_with_secret_dir(&db, &i, now, &dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_invalid_contract_fields_without_writing() {
        let db = db();
        let now = at("2026-01-01T00:00:00Z");
        for (key, value) in [
            ("id", json!(" ")),
            ("requireExisting", json!("yes")),
            ("runtimeMode", json!("unsafe")),
            ("interactionMode", json!(null)),
            ("createdBy", json!("unknown")),
            ("creationSource", json!("other")),
            ("workspaceStrategy", json!({"type":"worktree"})),
            ("modelSelection", json!({"instanceId":"i"})),
            ("threadMode", json!(null)),
            ("threadId", json!(42)),
        ] {
            let mut i = input();
            i[key] = value;
            assert!(upsert(&db, &i, now).is_err(), "accepted {key}");
        }
        assert!(list(&db).unwrap().is_empty());
    }
    #[test]
    fn legacy_model_and_stored_thread_mode_are_preserved() {
        let db = db();
        let now = at("2026-01-01T00:00:00Z");
        let mut i = input();
        i["modelSelection"] = json!({"provider":"codex","model":"m"});
        i["threadMode"] = json!("continue");
        let task = upsert(&db, &i, now).unwrap();
        assert_eq!(task["modelSelection"]["instanceId"], "codex");
        i.as_object_mut().unwrap().remove("threadMode");
        i["threadId"] = json!("thread-a");
        assert_eq!(upsert(&db, &i, now).unwrap()["threadMode"], "continue");
    }
    #[test]
    fn claims_completes_and_recovers_runs() {
        let db = db();
        let now = at("2026-01-01T00:00:00Z");
        upsert(&db, &input(), now).unwrap();
        assert!(begin_run(&db, "scheduled-task:abc", true, now)
            .unwrap()
            .is_none());
        let started = now + Duration::minutes(1);
        let claim = begin_run(&db, "scheduled-task:abc", true, started)
            .unwrap()
            .unwrap();
        assert!(begin_run(&db, "scheduled-task:abc", false, started).is_err());
        let done = complete_run(&db, &claim, started + Duration::seconds(10), None)
            .unwrap()
            .unwrap();
        assert_eq!(done["lastRunStatus"], "succeeded");
        assert_eq!(done["runCount"], 1);
        assert_eq!(done["nextRunAt"], "2026-01-01T00:02:10.000Z");
        assert!(complete_run(&db, &claim, started, None).unwrap().is_none());
        begin_run(
            &db,
            "scheduled-task:abc",
            false,
            started + Duration::seconds(20),
        )
        .unwrap();
        assert_eq!(
            recover_interrupted(&db, started + Duration::minutes(1)).unwrap(),
            1
        );
        let task = get(&db, "scheduled-task:abc").unwrap().unwrap();
        assert_eq!(task["lastRunStatus"], "failed");
        assert_eq!(
            task["lastRunError"],
            "Run was interrupted by a server restart."
        );
        assert_eq!(task["runCount"], 2);
        assert_eq!(
            recover_interrupted(&db, started + Duration::minutes(1)).unwrap(),
            0
        );
    }
    #[test]
    fn manual_once_before_due_does_not_consume_occurrence() {
        let db = db();
        let now = at("2026-01-01T00:00:00Z");
        let mut i = input();
        i["schedule"] = json!({"type":"once","runAt":"2026-01-01T01:00:00Z"});
        upsert(&db, &i, now).unwrap();
        let claim = begin_run(&db, "scheduled-task:abc", false, now)
            .unwrap()
            .unwrap();
        let done = complete_run(&db, &claim, now + Duration::hours(2), Some("failed"))
            .unwrap()
            .unwrap();
        assert_eq!(done["nextRunAt"], "2026-01-01T01:00:00.000Z");
        assert_eq!(done["lastRunStatus"], "failed");
    }
    #[test]
    fn scheduled_once_runs_only_once() {
        let db = db();
        let now = at("2026-01-01T00:00:00Z");
        let due = now + Duration::hours(1);
        let mut i = input();
        i["schedule"] = json!({"type":"once","runAt":"2026-01-01T01:00:00Z"});
        upsert(&db, &i, now).unwrap();
        assert!(due_tasks(&db, now).unwrap().is_empty());
        assert_eq!(due_tasks(&db, due).unwrap().len(), 1);
        let claim = begin_run(&db, "scheduled-task:abc", true, due)
            .unwrap()
            .unwrap();
        assert!(begin_run(&db, "scheduled-task:abc", true, due)
            .unwrap()
            .is_none());
        let done = complete_run(&db, &claim, due + Duration::minutes(1), None)
            .unwrap()
            .unwrap();
        assert_eq!(done["lastRunStatus"], "succeeded");
        assert_eq!(done["runCount"], 1);
        assert!(done["nextRunAt"].is_null());
        assert!(due_tasks(&db, due + Duration::days(1)).unwrap().is_empty());
    }
    #[test]
    fn missed_fixed_time_is_rescheduled_but_overdue_interval_runs() {
        let db = db();
        let now = at("2026-01-01T00:00:00Z");
        upsert(&db, &input(), now).unwrap();
        let mut i = input();
        i["commandId"] = json!("fixed");
        i["schedule"] = json!({"type":"fixed_time","timeOfDay":"00:00"});
        upsert(&db, &i, now).unwrap();
        db.execute(
            "UPDATE scheduled_tasks SET next_run_at='2026-01-01T00:01:00.000Z'",
            [],
        )
        .unwrap();
        let due = due_tasks(&db, now + Duration::hours(1)).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0]["id"], "scheduled-task:abc");
        let missed = get(&db, "scheduled-task:fixed").unwrap().unwrap();
        assert_eq!(missed["lastRunStatus"], "failed");
        assert_eq!(missed["runCount"], 0);
    }
    #[test]
    fn new_thread_dispatch_records_task_identity_and_binds() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let now = at("2026-01-01T00:00:00Z");
        let mut i = input();
        i["threadMode"] = json!("continue");
        i["workspaceStrategy"] =
            json!({"type":"existing_worktree","worktreePath":"/tmp/existing","branch":"feature"});
        upsert(&db, &i, now).unwrap();
        let claim = begin_run(&db, "scheduled-task:abc", false, now)
            .unwrap()
            .unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let thread = dispatch_new_thread(&bus, &claim, "manual", None).unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=?1",
                [&thread],
                |r| r.get(0),
            )?;
            let message: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(message["scheduledTaskId"], "scheduled-task:abc");
            let raw_thread: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", [&thread], |r| r.get(0))?;
            let thread_payload: Value = serde_json::from_str(&raw_thread).unwrap();
            assert_eq!(thread_payload["worktreePath"], "/tmp/existing");
            assert_eq!(thread_payload["branch"], "feature");
            let request: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id=?1", [&thread], |r| r.get(0))?;
            assert!(request.contains("/tmp/existing"));
            assert_eq!(
                get(tx, "scheduled-task:abc").unwrap().unwrap()["threadId"],
                thread
            );
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn authorization_failure_does_not_claim_scheduled_task() {
        let db = db();
        upsert(&db, &input(), Utc::now()).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let error = run_task_checked(&bus, "scheduled-task:abc", false, None, |tx| {
            assert!(get(tx, "scheduled-task:abc").unwrap().is_some());
            Err("not authorized".into())
        })
        .unwrap_err();
        assert_eq!(error, "not authorized");
        bus.with_autocommit(|db| {
            let task = get(db, "scheduled-task:abc").unwrap().unwrap();
            assert_eq!(task["runCount"], 0);
            assert_eq!(task["lastRunStatus"], "never");
        })
        .unwrap();
    }

    #[test]
    fn worker_dispatches_due_and_records_unsupported_workspace_failure() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let now = Utc::now() - Duration::minutes(5);
        upsert(&db, &input(), now).unwrap();
        let mut bad = input();
        bad["commandId"] = json!("bad");
        bad["workspaceStrategy"] =
            json!({"type":"worktree","baseRef":"main","startFromOrigin":true});
        upsert(&db, &bad, now).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        run_due(&bus, None).unwrap();
        bus.commit(|tx| {
            let good = get(tx, "scheduled-task:abc").unwrap().unwrap();
            assert_eq!(good["lastRunStatus"], "succeeded");
            assert_eq!(good["runCount"], 1);
            let bad = get(tx, "scheduled-task:bad").unwrap().unwrap();
            assert_eq!(bad["lastRunStatus"], "failed");
            assert_eq!(bad["runCount"], 1);
            assert!(bad["lastRunError"]
                .as_str()
                .unwrap()
                .contains("Worktree directory"));
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn scheduled_worktree_publishes_preparing_and_fails_on_checkout_error() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let mut task = input();
        task["workspaceStrategy"] = json!({"type":"worktree","baseRef":"main"});
        upsert(&db, &task, Utc::now()).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let claim = bus
            .commit(|tx| {
                Ok((
                    begin_run(tx, "scheduled-task:abc", false, Utc::now()),
                    vec![],
                ))
            })
            .unwrap()
            .unwrap()
            .unwrap();
        start_scheduled_preparation(&bus, &claim, "manual", None).unwrap();
        bus.with_autocommit(|db| {
            let (status, thread): (String, String) = db.query_row("SELECT r.status,t.payload_json FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_threads t ON t.thread_id=r.thread_id", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(status, "preparing");
            let thread: Value = serde_json::from_str(&thread).unwrap();
            assert!(thread["worktreePath"].is_null() && thread["branch"].is_null());
        }).unwrap();
        assert!(dispatch_new_thread(&bus, &claim, "manual", None).is_err());
        bus.with_autocommit(|db| {
            let status: String = db
                .query_row(
                    "SELECT status FROM orchestration_v2_projection_runs",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(status, "failed");
        })
        .unwrap();
    }

    #[test]
    fn background_run_authorization_and_claim_are_atomic() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let task = input();
        upsert(&db, &task, Utc::now()).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let err = run_manual_background_checked(
            &bus,
            "scheduled-task:abc",
            std::sync::Arc::new(Default::default()),
            |_| Err("denied".into()),
        )
        .unwrap_err();
        assert_eq!(err, "denied");
        bus.with_autocommit(|db| {
            let task = get(db, "scheduled-task:abc").unwrap().unwrap();
            assert_eq!(task["lastRunStatus"], "never");
            assert_eq!(task["runCount"], 0);
        })
        .unwrap();
    }

    #[test]
    fn manual_worktree_reports_scheduled_success_before_preparation_finishes() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let mut task = input();
        task["workspaceStrategy"] = json!({"type":"worktree","baseRef":"main"});
        upsert(&db, &task, Utc::now()).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let result = run_manual_background(
            &bus,
            "scheduled-task:abc",
            std::sync::Arc::new(Default::default()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["lastRunStatus"], "succeeded");
        assert_eq!(result["runCount"], 1);
    }

    #[test]
    fn timer_dispatch_publishes_worktree_run_and_settles_task() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let mut task = input();
        task["workspaceStrategy"] = json!({"type":"worktree","baseRef":"main"});
        upsert(&db, &task, Utc::now() - Duration::minutes(5)).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        run_due_background(&bus, std::sync::Arc::new(Default::default())).unwrap();
        bus.with_autocommit(|db| {
            let task = get(db, "scheduled-task:abc").unwrap().unwrap();
            assert_eq!(task["lastRunStatus"], "succeeded");
            assert_eq!(task["runCount"], 1);
            let count: i64 = db
                .query_row(
                    "SELECT count(*) FROM orchestration_v2_projection_messages",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
        })
        .unwrap();
    }

    #[test]
    fn scheduled_worktree_creates_thread_on_requested_base() {
        let temp = std::env::temp_dir().join(format!("scheduled-run-{}", uuid::Uuid::new_v4()));
        let root = temp.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success())
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(root.join("file"), "base").unwrap();
        git(&["add", "file"]);
        git(&["commit", "-qm", "base"]);
        git(&["branch", "base"]);
        std::fs::write(root.join("file"), "later").unwrap();
        git(&["commit", "-qam", "later"]);
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P',?1,'[]','now','now')", [root.to_str().unwrap()]).unwrap();
        let mut task = input();
        task["workspaceStrategy"] =
            json!({"type":"worktree","baseRef":"base", "branch":"feature/scheduled"});
        upsert(&db, &task, Utc::now()).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        bus.set_worktrees_dir(temp.join("trees"));
        let claim = bus
            .commit(|tx| {
                Ok((
                    begin_run(tx, "scheduled-task:abc", false, Utc::now()),
                    vec![],
                ))
            })
            .unwrap()
            .unwrap()
            .unwrap();
        let thread = dispatch_new_thread(&bus, &claim, "manual", None).unwrap();
        let path = bus.with_autocommit(|db| { let payload: String = db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", [&thread], |r| r.get(0)).unwrap(); let payload: Value = serde_json::from_str(&payload).unwrap(); assert_eq!(payload["branch"], "feature/scheduled"); assert!(crate::scheduled_worktree_journal::pending(db).unwrap().is_empty()); payload["worktreePath"].as_str().unwrap().to_owned() }).unwrap();
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&path).join("file")).unwrap(),
            "base"
        );
        assert_eq!(
            dispatch_new_thread(&bus, &claim, "manual", None).unwrap(),
            thread
        );
        drop(bus);
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn upsert_unbind_thread_clears_existing_binding() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let now = Utc::now();
        let mut task = input();
        task["threadId"] = json!("thread-1");
        let saved = upsert(&db, &task, now).unwrap();
        assert_eq!(saved["threadId"], "thread-1");

        // Omitting threadId and unbindThread preserves existing binding.
        let mut preserve = input();
        preserve.as_object_mut().unwrap().remove("threadId");
        let preserved = upsert(&db, &preserve, now).unwrap();
        assert_eq!(preserved["threadId"], "thread-1");

        // Passing unbindThread: true clears existing binding.
        let mut unbind = preserve;
        unbind["unbindThread"] = json!(true);
        let cleared = upsert(&db, &unbind, now).unwrap();
        assert!(cleared["threadId"].is_null());
    }
}
