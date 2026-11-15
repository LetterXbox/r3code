//! Projection of native descendant notifications received on a parent's stream.
use crate::event_bus::EventBus;
use crate::provider::{
    codex_events::{CodexRootTurnTranslator, NormalizedEvent, RootTurn, Translation},
    ingest,
    session_registry::{SessionHandle, TurnEvents},
};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::collections::HashMap;

pub(super) fn register(events: &[NormalizedEvent], stream: &mut TurnEvents) -> Result<(), String> {
    for event in events {
        if let NormalizedEvent::NativeSubagent { item, .. } = event {
            if item["type"] == "collabAgentToolCall" && item["tool"] == "spawnAgent" {
                for child in item["receiverThreadIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    stream.register_child(child).map_err(|e| e.to_string())?;
                }
            }
            if item["type"] == "subAgentActivity" && item["kind"] == "started" {
                if let Some(child) = item["agentThreadId"].as_str() {
                    stream.register_child(child).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

/// Recover known descendants when a parent resumes in a replacement session.
/// Routes owned by another live supervisor remain with that supervisor.
pub(super) fn restore(bus: &EventBus, parent: &str, stream: &mut TurnEvents) -> Result<(), String> {
    let descendants = bus.commit(|tx| {
        let mut stmt = tx.prepare("WITH RECURSIVE descendants(thread_id) AS (SELECT child_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='provider_native' UNION SELECT s.child_thread_id FROM orchestration_v2_projection_subagents s JOIN descendants d ON s.thread_id=d.thread_id WHERE s.origin='provider_native') SELECT json_extract(p.payload_json,'$.nativeThreadRef.nativeId') FROM descendants d JOIN orchestration_v2_projection_provider_threads p ON p.thread_id=d.thread_id WHERE p.provider='codex' AND json_extract(p.payload_json,'$.nativeThreadRef.nativeId') IS NOT NULL")?;
        let rows = stmt.query_map([parent], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((rows, vec![]))
    }).map_err(|e| e.to_string())?;
    for child in descendants {
        stream.restore_child(&child).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct Children {
    turns: HashMap<(String, String), CodexRootTurnTranslator>,
}
impl Children {
    pub fn notification(
        &mut self,
        bus: &EventBus,
        session: &SessionHandle,
        stream: &mut TurnEvents,
        method: &str,
        params: Value,
        at: &str,
    ) -> Result<(), String> {
        let Some(thread) = params["threadId"].as_str() else {
            return Err(format!("Child {method} is missing threadId"));
        };
        let Some(native_turn) = params["turnId"]
            .as_str()
            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str))
        else {
            return if matches!(
                method,
                "thread/started" | "thread/status/changed" | "thread/settings/updated"
            ) {
                Ok(())
            } else {
                Err(format!("Child {method} is missing turnId"))
            };
        };
        self.ensure_turn(bus, session, thread, native_turn, at)?;
        let key = (thread.to_owned(), native_turn.to_owned());
        let translator = self.turns.get_mut(&key).unwrap();
        match translator
            .notification(method, params, at, |ms| {
                chrono::DateTime::from_timestamp_millis(ms)
                    .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .unwrap_or_else(super::now)
            })
            .map_err(|e| format!("{e:?}"))?
        {
            Translation::Events(events) => {
                if !events.is_empty() {
                    ingest::ingest(bus, &events).map_err(|e| e.to_string())?;
                    register(&events, stream)?;
                    for event in &events {
                        if let NormalizedEvent::TurnTerminal { turn, status, .. } = event {
                            let status = match status {
                                super::super::codex_events::TurnStatus::Completed => "completed",
                                super::super::codex_events::TurnStatus::Interrupted => {
                                    "interrupted"
                                }
                                super::super::codex_events::TurnStatus::Failed => "failed",
                                super::super::codex_events::TurnStatus::Running => continue,
                            };
                            bus.commit(|tx| {
                                let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1", [&turn.root_node_id], |r| r.get(0))?;
                                let mut node: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
                                node["status"] = serde_json::json!(status); node["completedAt"] = serde_json::json!(at); node["providerTurnId"] = serde_json::json!(turn.provider_turn_id);
                                tx.execute("UPDATE orchestration_v2_projection_nodes SET status=?2,completed_at=?3,provider_turn_id=?4,payload_json=?5 WHERE node_id=?1", rusqlite::params![turn.root_node_id,status,at,turn.provider_turn_id,node.to_string()])?;
                                let event = crate::event_store::Event { id: uuid::Uuid::new_v4().to_string(), aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:"node.updated".into(),occurred_at:at.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload:node,metadata:serde_json::json!({}) };
                                Ok(((),crate::event_store::append(tx,&[event])?))
                            }).map_err(|e| e.to_string())?;
                        }
                    }
                }
                Ok(())
            }
            Translation::Unsupported
                if matches!(
                    method,
                    "turn/started"
                        | "thread/started"
                        | "thread/status/changed"
                        | "thread/settings/updated"
                ) =>
            {
                Ok(())
            }
            Translation::Unsupported => {
                Err(format!("Unsupported Codex child notification: {method}"))
            }
        }
    }
    fn ensure_turn(
        &mut self,
        bus: &EventBus,
        session: &SessionHandle,
        thread: &str,
        native_turn: &str,
        at: &str,
    ) -> Result<(), String> {
        let key = (thread.to_owned(), native_turn.to_owned());
        if !self.turns.contains_key(&key) {
            let found = bus.commit(|tx| {
                let provider = format!("provider-thread:provider:codex:native-thread:{}", crate::message_commands::encode_id_part(thread));
                let row: Option<(String,String,u64)> = tx.query_row("SELECT p.thread_id,n.node_id,COALESCE((SELECT MAX(ordinal) FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=p.provider_thread_id),0)+1 FROM orchestration_v2_projection_provider_threads p JOIN orchestration_v2_projection_nodes n ON n.thread_id=p.thread_id AND n.kind='root_turn' WHERE p.provider_thread_id=?1 ORDER BY n.rowid LIMIT 1", [&provider], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
                Ok((row.map(|(thread_id,root_node_id,ordinal)| (provider,thread_id,root_node_id,ordinal)),vec![]))
            }).map_err(|e| e.to_string())?;
            let Some((provider_thread_id, thread_id, root_node_id, ordinal)) = found else {
                return Err(format!("No projection for native child {thread}"));
            };
            let turn = RootTurn {
                driver: "codex".into(),
                native_thread_id: thread.into(),
                native_turn_id: native_turn.into(),
                provider_thread_id,
                provider_turn_id: format!(
                    "provider-turn:provider:codex:native-turn:{}",
                    crate::message_commands::encode_id_part(native_turn)
                ),
                thread_id,
                run_id: None,
                run_attempt_id: String::new(),
                root_node_id,
                provider_turn_ordinal: ordinal,
                run_ordinal: 0,
                started_at: at.into(),
            };
            // A native thread may execute several turns. Reopen its root node when
            // a new provider turn begins so it no longer appears terminal.
            bus.commit(|tx| {
                let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id=?1", [&turn.root_node_id], |r| r.get(0))?;
                let mut node: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
                node["status"] = serde_json::json!("running");
                node["completedAt"] = Value::Null;
                node["providerTurnId"] = serde_json::json!(turn.provider_turn_id);
                tx.execute("UPDATE orchestration_v2_projection_nodes SET status='running',completed_at=NULL,provider_turn_id=?2,payload_json=?3 WHERE node_id=?1", rusqlite::params![turn.root_node_id,turn.provider_turn_id,node.to_string()])?;
                let event = crate::event_store::Event { id: uuid::Uuid::new_v4().to_string(), aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:"node.updated".into(),occurred_at:at.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload:node,metadata:serde_json::json!({}) };
                Ok(((),crate::event_store::append(tx,&[event])?))
            }).map_err(|e| e.to_string())?;
            let (translator, started) =
                CodexRootTurnTranslator::start_with_usage(turn, session.turn_usage(thread));
            ingest::ingest(bus, &[started]).map_err(|e| e.to_string())?;
            self.turns.insert(key.clone(), translator);
        }
        Ok(())
    }

    pub fn request(
        &mut self,
        bus: &EventBus,
        session: &SessionHandle,
        session_id: &str,
        method: &str,
        mut params: Value,
        at: &str,
    ) -> Result<(super::codex_requests::RequestArtifacts, RootTurn), String> {
        let thread = params["threadId"]
            .as_str()
            .or_else(|| params["conversationId"].as_str())
            .ok_or("Child request missing thread ID")?
            .to_owned();
        let native_turn = params["turnId"]
            .as_str()
            .ok_or("Child request missing turn ID")?
            .to_owned();
        self.ensure_turn(bus, session, &thread, &native_turn, at)?;
        let translator = self.turns.get(&(thread, native_turn)).unwrap();
        if method == "item/fileChange/requestApproval" {
            if let Some(changes) = params["itemId"]
                .as_str()
                .and_then(|id| translator.file_changes(id))
            {
                params["fileChanges"] = changes.clone();
            }
        }
        let turn = translator.turn().clone();
        let ordinal = bus.commit(|tx| {
            let ordinal: u64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE provider_turn_id=?1", [&turn.provider_turn_id], |r| r.get(0))?;
            Ok((ordinal, vec![]))
        }).map_err(|e| e.to_string())?;
        let artifacts =
            super::codex_requests::translate(&turn, session_id, method, params, at, ordinal)?;
        Ok((artifacts, turn))
    }
    pub fn flush(&mut self, bus: &EventBus, at: &str) -> Result<(), String> {
        for translator in self.turns.values_mut() {
            let events = translator.flush(at);
            if !events.is_empty() {
                ingest::ingest(bus, &events).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}
