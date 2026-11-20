//! Resolve a bounded native OpenCode fork from a pending context transfer.
use crate::event_bus::EventBus;
use rusqlite::params;
use serde_json::Value;
use std::path::Path;

pub(crate) async fn fork(
    bus: &EventBus,
    settings: &Path,
    target: &str,
    instance: &str,
    transfer: &Value,
    cwd: &str,
) -> Result<(String, String, String), String> {
    let source = transfer["sourceThreadId"]
        .as_str()
        .ok_or("Missing fork source")?;
    let run = transfer["sourcePoint"]["runId"]
        .as_str()
        .ok_or("Missing fork boundary")?;
    let native = transfer["sourcePoint"]["providerThreadRef"]["nativeId"]
        .as_str()
        .ok_or("Missing native fork source")?;
    let (provider_thread,provider_turn,later)=bus.commit(|tx| {
        let (provider_thread,provider_turn,ordinal):(String,String,i64)=tx.query_row("SELECT p.provider_thread_id,p.provider_turn_id,p.ordinal FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_turns p ON p.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') WHERE r.run_id=?1 AND r.thread_id=?2 AND r.status='completed' ORDER BY p.ordinal DESC LIMIT 1",params![run,source],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
        let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2",params![provider_thread,source],|row|row.get(0))?;
        let actual:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
        if actual["driver"]!="opencode" || actual["providerInstanceId"]!=instance || actual["nativeThreadRef"]["nativeId"]!=native || actual["nativeThreadRef"]["strength"]!="strong" {return Err(rusqlite::Error::InvalidQuery);}
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting'))",[source],|row|row.get(0))?;
        if active {return Err(rusqlite::Error::InvalidQuery);}
        let mut stmt=tx.prepare("SELECT json_extract(payload_json,'$.nativeTurnRef.nativeId') FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1 AND ordinal>?2 AND status IN ('completed','failed','cancelled','interrupted') ORDER BY ordinal")?;
        let later=stmt.query_map(params![provider_thread,ordinal],|row|row.get::<_,Option<String>>(0))?.collect::<Result<Vec<_>,_>>()?.into_iter().map(Option::unwrap_or_default).collect::<Vec<_>>();
        Ok(((provider_thread,provider_turn,later),vec![]))
    }).map_err(|_|"Invalid or busy OpenCode fork source")?;
    let prepared =
        super::opencode_rollback::prepare(settings, instance, source, cwd, native, &later).await?;
    let forked = prepared.fork(cwd).await?;
    let _ = target;
    Ok((forked, provider_thread, provider_turn))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn rejects_stale_native_source_before_connecting() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES('run','source',1,'opencode','completed','now',?1)",[json!({"activeAttemptId":"attempt"}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES('pt','source','opencode','idle','now',?1)",[json!({"driver":"opencode","providerInstanceId":"opencode","nativeThreadRef":{"driver":"opencode","nativeId":"actual","strength":"strong"}}).to_string()])?;
            tx.execute("INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES('turn','source','pt','node','attempt',1,'completed','{}')",[])?;
            Ok(((),vec![]))
        }).unwrap();
        let transfer = json!({"sourceThreadId":"source","sourcePoint":{"runId":"run","providerThreadRef":{"nativeId":"stale"}}});
        let result = fork(
            &bus,
            Path::new("/missing-settings"),
            "target",
            "opencode",
            &transfer,
            "/tmp",
        )
        .await;
        assert!(result.is_err());
    }
}
