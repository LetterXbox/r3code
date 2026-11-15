//! Projection for Grok shell tasks which continue after the prompt response.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event},
    provider::codex_events::RootTurn,
};
use rusqlite::params;
use serde_json::json;

#[allow(clippy::too_many_arguments)]
pub(crate) fn command(
    bus: &EventBus,
    turn: &RootTurn,
    instance: &str,
    tool_id: &str,
    input: &str,
    output: Option<&str>,
    status: &str,
    ordinal: u64,
    started: &str,
    at: &str,
) -> Result<(), String> {
    let enc = crate::message_commands::encode_id_part;
    let scoped = format!(
        "provider-instance:{}:{}:tool:{}",
        enc(instance),
        turn.native_thread_id,
        tool_id
    );
    let node = format!("node:provider:grok:native-item:{}", enc(&scoped));
    let item = format!("turn-item:provider:grok:native-item:{}", enc(&scoped));
    let done = (status != "running").then_some(at);
    let native = json!({"driver":"grok","nativeId":tool_id,"strength":"strong"});
    let n = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"rootNodeId":turn.root_node_id,"kind":"tool_call","status":status,"countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":native,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":started,"completedAt":done});
    let mut v = json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":native,"parentItemId":null,"ordinal":ordinal,"status":status,"title":"Ran command","startedAt":started,"completedAt":done,"updatedAt":at,"type":"command_execution","input":input});
    if let Some(output) = output {
        v["output"] = json!(output);
    }
    bus.commit(|tx|{
        tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES(?1,?2,?3,?4,?4,'tool_call',?5,?6,?7,?8,?9,?10) ON CONFLICT(node_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,payload_json=excluded.payload_json",params![node,turn.thread_id,turn.run_id,turn.root_node_id,status,turn.provider_thread_id,turn.provider_turn_id,started,done,n.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'command_execution',?8,?9,?10) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,turn.thread_id,turn.run_id,node,turn.provider_thread_id,turn.provider_turn_id,ordinal,status,at,v.to_string()])?;
        let events=[("node.updated",n),("turn-item.updated",v)].into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:kind.into(),occurred_at:at.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload,metadata:json!({})}).collect::<Vec<_>>();
        Ok(((),event_store::append(tx,&events)?))
    }).map_err(|e|e.to_string())
}
