//! Planning primitives for a provider-instance restart. This module is not yet
//! connected to dispatch: persistence, interruption and session detachment must
//! all be implemented together before the transition can be enabled.
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

/// Prepare and persist a full portable handoff for a cross-instance restart.
///
/// Call within the same transaction that stages the interruption and replacement
/// projections, and publish the returned records as domain events. This does not
/// interrupt a provider or detach a session and is deliberately not dispatched
/// on its own. A fresh target is required because the restart planner uses a
/// full summary rather than the incremental context used for ordinary switches.
pub fn prepare_handoff(
    tx: &Transaction<'_>,
    thread: &str,
    run: &str,
    target: &str,
    target_instance: &str,
    now: &str,
) -> rusqlite::Result<(Value, Value)> {
    let raw: Option<String> = tx.query_row(
        "SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND run_id=?2 AND status='running' AND ordinal=(SELECT MAX(ordinal) FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status NOT IN ('queued','rolled_back'))",
        params![thread, run], |r| r.get(0),
    ).optional()?;
    let source: Value = serde_json::from_str(&raw.ok_or(rusqlite::Error::InvalidQuery)?)
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    let target_raw: Option<String> = tx.query_row(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND provider_thread_id=?2 AND owner_node_id IS NULL AND provider_session_id IS NULL",
        params![thread, target], |r| r.get(0),
    ).optional()?;
    let target_value: Value =
        serde_json::from_str(&target_raw.ok_or(rusqlite::Error::InvalidQuery)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
    let source_id = source["providerThreadId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let source_instance = source["providerInstanceId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND provider_thread_id=?2)", params![thread,target], |r| r.get(0))?;
    if target_instance.is_empty()
        || source_instance == target_instance
        || source_id == target
        || target_value["providerInstanceId"] != target_instance
        || used
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    // A savepoint also prevents partially written handoffs if a caller handles
    // an error and continues the outer transaction.
    tx.execute_batch("SAVEPOINT restart_handoff")?;
    let result = (|| {
        let (handoff, transfer) = crate::message_commands::prepare_switch_handoff(
            tx,
            thread,
            run,
            target,
            target_instance,
            now,
            false,
        )?
        .ok_or(rusqlite::Error::InvalidQuery)?;
        if handoff["strategy"] != "full_thread_summary"
            || handoff["status"] != "ready"
            || !handoff["fromProviderThreadIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == source_id))
            || transfer["sourceProviderInstanceId"] != source_instance
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        Ok((handoff, transfer))
    })();
    if result.is_err() {
        tx.execute_batch("ROLLBACK TO restart_handoff")?;
    }
    tx.execute_batch("RELEASE restart_handoff")?;
    result
}

/// Inputs already resolved by the caller, including a prepared portable handoff.
/// No database or provider operations are performed by this planner.
pub struct RestartTransitionInput<'a> {
    pub thread: &'a Value,
    pub run: &'a Value,
    pub source_provider_thread: &'a Value,
    pub target_provider_thread: &'a Value,
    pub selection: &'a Value,
    pub handoff: &'a Value,
    pub transfer_id: &'a str,
    pub source_point: &'a Value,
    pub next_attempt_id: &'a str,
    pub next_node_id: &'a str,
    pub checkpoint_scope: &'a Value,
    pub message_id: &'a str,
    pub attempt_ordinal: i64,
    pub created_by: &'a str,
    pub now: &'a str,
}

/// The caller must commit these projections and the interrupt effect atomically.
pub struct RestartTransitionPlan {
    pub thread: Value,
    pub provider_thread: Value,
    pub handoff: Value,
    pub transfer: Value,
    pub run: Value,
    pub attempt: Value,
    pub node: Value,
    pub checkpoint_scope: Value,
    pub session_transition: Value,
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, &'static str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("missing transition field")
}

/// Construct the replacement projections after a different instance has been
/// selected. IDs and the handoff are allocated/prepared outside this function.
pub fn plan(input: RestartTransitionInput<'_>) -> Result<RestartTransitionPlan, &'static str> {
    let thread_id = field(input.thread, "id")?;
    let run_id = field(input.run, "id")?;
    let source_id = field(input.source_provider_thread, "id")?;
    let target_id = field(input.target_provider_thread, "id")?;
    let source_instance = field(input.run, "providerInstanceId")?;
    let target_instance = field(input.selection, "instanceId")?;
    let handoff_id = field(input.handoff, "id")?;
    let scope_id = field(input.checkpoint_scope, "id")?;
    let ordinal = input.run["ordinal"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or("invalid run ordinal")?;
    if input.attempt_ordinal < 2
        || input.next_attempt_id.is_empty()
        || input.next_node_id.is_empty()
        || input.message_id.is_empty()
        || input.transfer_id.is_empty()
    {
        return Err("invalid restart identifiers");
    }
    if input.run["threadId"] != thread_id
        || input.run["providerThreadId"] != source_id
        || input.source_provider_thread["providerInstanceId"] != source_instance
        || input.target_provider_thread["providerInstanceId"] != target_instance
        || source_id == target_id
        || source_instance == target_instance
        || input.target_provider_thread["appThreadId"] != thread_id
        || !input.target_provider_thread["ownerNodeId"].is_null()
    {
        return Err("inconsistent provider transition");
    }
    if input.handoff["threadId"] != thread_id
        || input.handoff["targetRunId"] != run_id
        || input.handoff["toProviderThreadId"] != target_id
        || input.handoff["strategy"] != "full_thread_summary"
        || input.handoff["status"] != "ready"
        || !input.handoff["fromProviderThreadIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == source_id))
    {
        return Err("inconsistent handoff");
    }
    if input.run["status"] != "running"
        || input.checkpoint_scope["threadId"] != thread_id
        || input.checkpoint_scope["runId"] != run_id
    {
        return Err("invalid restart state");
    }
    let mut thread = input.thread.clone();
    thread["providerInstanceId"] = json!(target_instance);
    thread["modelSelection"] = input.selection.clone();
    thread["updatedAt"] = json!(input.now);
    let mut provider_thread = input.target_provider_thread.clone();
    provider_thread["lastRunOrdinal"] = json!(ordinal);
    provider_thread["updatedAt"] = json!(input.now);
    let ids = provider_thread["handoffIds"]
        .as_array_mut()
        .ok_or("invalid target handoff ids")?;
    if !ids.iter().any(|id| id == handoff_id) {
        ids.push(json!(handoff_id));
    }
    let transfer = json!({"id":input.transfer_id,"type":"provider_handoff","sourceThreadId":thread_id,"targetThreadId":thread_id,"sourcePoint":input.source_point,"basePoint":null,"sourceProviderInstanceId":source_instance,"targetProviderInstanceId":target_instance,"targetRunId":run_id,"status":"consumed","resolution":{"strategy":"portable_context","contextHandoffId":handoff_id},"createdBy":input.created_by,"error":null,"createdAt":input.now,"updatedAt":input.now,"consumedAt":input.now});
    let mut run = input.run.clone();
    run["providerInstanceId"] = json!(target_instance);
    run["modelSelection"] = input.selection.clone();
    run["providerThreadId"] = json!(target_id);
    run["rootNodeId"] = json!(input.next_node_id);
    run["activeAttemptId"] = json!(input.next_attempt_id);
    run["userMessageId"] = json!(input.message_id);
    run["status"] = json!("starting");
    run["contextHandoffId"] = json!(handoff_id);
    let attempt = json!({"id":input.next_attempt_id,"threadId":thread_id,"runId":run_id,"attemptOrdinal":input.attempt_ordinal,"rootNodeId":input.next_node_id,"providerInstanceId":target_instance,"providerThreadId":target_id,"providerTurnId":null,"reason":"steering_restart","status":"pending","startedAt":null,"completedAt":null});
    let node = json!({"id":input.next_node_id,"threadId":thread_id,"runId":run_id,"parentNodeId":null,"rootNodeId":input.next_node_id,"kind":"root_turn","status":"pending","countsForRun":true,"providerThreadId":target_id,"providerTurnId":null,"nativeItemRef":null,"runtimeRequestId":null,"checkpointScopeId":scope_id,"startedAt":null,"completedAt":null});
    let mut checkpoint_scope = input.checkpoint_scope.clone();
    checkpoint_scope["nodeId"] = json!(input.next_node_id);
    checkpoint_scope["providerThreadId"] = json!(target_id);
    checkpoint_scope["createdAt"] = json!(input.now);
    Ok(RestartTransitionPlan {
        thread,
        provider_thread,
        handoff: input.handoff.clone(),
        transfer,
        run,
        attempt,
        node,
        checkpoint_scope,
        session_transition: json!({"type":"detach"}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Value, Value, Value, Value, Value, Value, Value) {
        (
            json!({"id":"t","providerInstanceId":"a"}),
            json!({"id":"r","threadId":"t","ordinal":3,"providerInstanceId":"a","providerThreadId":"old","status":"running"}),
            json!({"id":"old","providerInstanceId":"a"}),
            json!({"id":"new","appThreadId":"t","ownerNodeId":null,"providerInstanceId":"b","handoffIds":["previous"]}),
            json!({"instanceId":"b","model":"m"}),
            json!({"id":"h","threadId":"t","targetRunId":"r","toProviderThreadId":"new","fromProviderThreadIds":["old"],"strategy":"full_thread_summary","status":"ready"}),
            json!({"id":"scope","threadId":"t","runId":"r"}),
        )
    }
    fn build<'a>(
        f: &'a (Value, Value, Value, Value, Value, Value, Value),
    ) -> RestartTransitionInput<'a> {
        RestartTransitionInput {
            thread: &f.0,
            run: &f.1,
            source_provider_thread: &f.2,
            target_provider_thread: &f.3,
            selection: &f.4,
            handoff: &f.5,
            transfer_id: "x",
            source_point: &Value::Null,
            next_attempt_id: "a2",
            next_node_id: "n2",
            checkpoint_scope: &f.6,
            message_id: "m2",
            attempt_ordinal: 2,
            created_by: "user",
            now: "now",
        }
    }
    #[test]
    fn plans_consistent_replacement_and_preserves_target_history() {
        let f = fixture();
        let p = plan(build(&f)).unwrap();
        assert_eq!(p.provider_thread["handoffIds"], json!(["previous", "h"]));
        assert_eq!(p.run["providerThreadId"], p.node["providerThreadId"]);
        assert_eq!(p.run["providerThreadId"], p.attempt["providerThreadId"]);
        assert_eq!(
            p.run["providerThreadId"],
            p.checkpoint_scope["providerThreadId"]
        );
        assert_eq!(
            p.transfer["resolution"]["contextHandoffId"],
            p.run["contextHandoffId"]
        );
        assert_eq!(p.session_transition, json!({"type":"detach"}));
        assert_eq!(f.1["status"], "running");
    }
    #[test]
    fn rejects_wrong_handoff_and_non_live_run() {
        let mut f = fixture();
        f.5["toProviderThreadId"] = json!("old");
        assert!(plan(build(&f)).is_err());
        let mut f = fixture();
        f.1["status"] = json!("completed");
        assert!(plan(build(&f)).is_err());
        let mut f = fixture();
        f.3["providerInstanceId"] = json!("a");
        assert!(plan(build(&f)).is_err());
    }

    #[test]
    fn handoff_is_durable_only_with_outer_commit_and_rejects_reused_target() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','now','now','{}')", []).unwrap();
        for (id, instance) in [("old", "a"), ("new", "b")] {
            db.execute("INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,status,updated_at,payload_json) VALUES(?1,'t','codex','ready','now',?2)", params![id,json!({"id":id,"appThreadId":"t","providerInstanceId":instance,"handoffIds":[]}).to_string()]).unwrap();
        }
        let run = json!({"id":"r","threadId":"t","ordinal":1,"status":"running","providerThreadId":"old","providerInstanceId":"a","activeAttemptId":"a1"});
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,payload_json) VALUES('r','t',1,'codex','old','running','now',?1)", [run.to_string()]).unwrap();
        {
            let tx = db.transaction().unwrap();
            let (handoff, transfer) = prepare_handoff(&tx, "t", "r", "new", "b", "now").unwrap();
            assert_eq!(handoff["strategy"], "full_thread_summary");
            assert_eq!(transfer["resolution"]["contextHandoffId"], handoff["id"]);
            assert_eq!(
                tx.query_row(
                    "SELECT count(*) FROM orchestration_v2_projection_context_handoffs",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
            tx.rollback().unwrap();
        }
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM orchestration_v2_projection_context_handoffs",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        {
            let tx = db.transaction().unwrap();
            prepare_handoff(&tx, "t", "r", "new", "b", "now").unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM orchestration_v2_projection_context_transfers",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,payload_json) VALUES('used','t',2,'codex','new','queued','now','{}')", []).unwrap();
        let tx = db.transaction().unwrap();
        assert!(prepare_handoff(&tx, "t", "r", "new", "b", "now").is_err());
        assert_eq!(
            tx.query_row(
                "SELECT count(*) FROM orchestration_v2_projection_context_handoffs",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
}
