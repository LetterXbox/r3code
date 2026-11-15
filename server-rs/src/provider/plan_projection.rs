//! Projection of a provider's completed proposed plan.
use crate::{
    event_bus::EventBus,
    event_store::{self, Event},
    provider::codex_events::RootTurn,
};
use rusqlite::params;
use serde_json::json;
pub(crate) fn todo(
    bus: &EventBus,
    turn: &RootTurn,
    native: &str,
    todos: &[serde_json::Value],
    ordinal: u64,
    at: &str,
    v2: bool,
) -> Result<(), String> {
    let encoded = crate::message_commands::encode_id_part(native);
    let node = format!("node:provider:{}:native-item:{encoded}", turn.driver);
    let item = format!("turn-item:provider:{}:native-item:{encoded}", turn.driver);
    let plan = format!("plan:provider:{}:native-item:{encoded}", turn.driver);
    let reference = json!({"driver":turn.driver,"nativeId":native,"strength":"weak"});
    let steps:Vec<_>=todos.iter().enumerate().filter(|(_,todo)|todo["status"]!="cancelled").map(|(index,todo)| {
        let text=todo["content"].as_str().unwrap_or("").trim();
        json!({"id":format!("{native}:{}",index+1),"text":if text.is_empty(){format!("Todo {}",index+1)}else{text.to_owned()},"status":match todo["status"].as_str(){Some("completed")=>"completed",Some("in_progress")=>"running",_=>"pending"}})
    }).collect();
    let done = steps.iter().all(|step| step["status"] == "completed") && (v2 || !todos.is_empty());
    let node_status = if v2 || done { "completed" } else { "running" };
    let plan_status = if done { "completed" } else { "active" };
    let n = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"rootNodeId":turn.root_node_id,"kind":"todo_list","status":node_status,"countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":turn.started_at,"completedAt":if node_status=="completed"{Some(at)}else{None}});
    let p = json!({"id":plan,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"kind":"todo_list","status":plan_status,"steps":steps});
    let i = json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"parentItemId":null,"ordinal":ordinal,"status":node_status,"title":"Todo list","startedAt":turn.started_at,"completedAt":if node_status=="completed"{Some(at)}else{None},"updatedAt":at,"type":"todo_list","planId":plan,"steps":steps});
    bus.commit(|tx|{
        tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES(?1,?2,?3,?4,?4,'todo_list',?5,?6,?7,?8,?9,?10) ON CONFLICT(node_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,payload_json=excluded.payload_json",params![node,turn.thread_id,turn.run_id,turn.root_node_id,node_status,turn.provider_thread_id,turn.provider_turn_id,turn.started_at,if node_status=="completed"{Some(at)}else{None},n.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_plans(plan_id,thread_id,run_id,node_id,kind,status,payload_json) VALUES(?1,?2,?3,?4,'todo_list',?5,?6) ON CONFLICT(plan_id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json",params![plan,turn.thread_id,turn.run_id,node,plan_status,p.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'todo_list',?8,?9,?10) ON CONFLICT(turn_item_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,turn.thread_id,turn.run_id,node,turn.provider_thread_id,turn.provider_turn_id,ordinal,node_status,at,i.to_string()])?;
        let events=[("node.updated",n),("plan.updated",p),("turn-item.updated",i)].into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:kind.into(),occurred_at:at.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload,metadata:json!({})}).collect::<Vec<_>>();Ok(((),event_store::append(tx,&events)?))
    }).map_err(|e|e.to_string())
}
pub(crate) fn proposed(
    bus: &EventBus,
    turn: &RootTurn,
    native: &str,
    markdown: &str,
    ordinal: u64,
    at: &str,
) -> Result<(), String> {
    let encoded = crate::message_commands::encode_id_part(&format!("proposed_plan:{native}"));
    let node = format!("node:provider:{}:native-item:{encoded}", turn.driver);
    let item = format!("turn-item:provider:{}:native-item:{encoded}", turn.driver);
    let plan = format!("plan:provider:{}:native-item:{encoded}", turn.driver);
    let reference = json!({"driver":turn.driver,"nativeId":native,"strength":"strong"});
    let n = json!({"id":node,"threadId":turn.thread_id,"runId":turn.run_id,"parentNodeId":turn.root_node_id,"rootNodeId":turn.root_node_id,"kind":"plan","status":"completed","countsForRun":false,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":at,"completedAt":at});
    let p = json!({"id":plan,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"kind":"proposed_plan","status":"active","markdown":markdown});
    let i = json!({"id":item,"threadId":turn.thread_id,"runId":turn.run_id,"nodeId":node,"providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,"nativeItemRef":reference,"parentItemId":null,"ordinal":ordinal,"status":"completed","title":null,"startedAt":at,"completedAt":at,"updatedAt":at,"type":"proposed_plan","planId":plan,"markdown":markdown,"streaming":false});
    bus.commit(|tx|{
  tx.execute("INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES(?1,?2,?3,?4,?4,'plan','completed',?5,?6,?7,?7,?8) ON CONFLICT(node_id) DO UPDATE SET status='completed',completed_at=excluded.completed_at,payload_json=excluded.payload_json",params![node,turn.thread_id,turn.run_id,turn.root_node_id,turn.provider_thread_id,turn.provider_turn_id,at,n.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_plans(plan_id,thread_id,run_id,node_id,kind,status,payload_json) VALUES(?1,?2,?3,?4,'proposed_plan','active',?5) ON CONFLICT(plan_id) DO UPDATE SET status='active',payload_json=excluded.payload_json",params![plan,turn.thread_id,turn.run_id,node,p.to_string()])?;
  tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'proposed_plan','completed',?8,?9) ON CONFLICT(turn_item_id) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![item,turn.thread_id,turn.run_id,node,turn.provider_thread_id,turn.provider_turn_id,ordinal,at,i.to_string()])?;
  let events=[("node.updated",n),("plan.updated",p),("turn-item.updated",i)].into_iter().map(|(kind,payload)|Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:turn.thread_id.clone(),event_type:kind.into(),occurred_at:at.into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload,metadata:json!({})}).collect::<Vec<_>>();Ok(((),event_store::append(tx,&events)?))
 }).map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn todo_list_updates_a_single_plan_with_normalized_steps() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 8);
        let turn = RootTurn {
            driver: "opencode".into(),
            native_thread_id: "ses".into(),
            native_turn_id: "turn".into(),
            provider_thread_id: "pt".into(),
            provider_turn_id: "turn-id".into(),
            thread_id: "thread".into(),
            run_id: Some("run".into()),
            run_attempt_id: "attempt".into(),
            root_node_id: "root".into(),
            provider_turn_ordinal: 1,
            run_ordinal: 1,
            started_at: "2026-01-01T00:00:00Z".into(),
        };
        let first = json!([{"content":" first ","status":"pending"},{"content":"skip","status":"cancelled"}]);
        todo(
            &bus,
            &turn,
            "ses:todo:turn-id",
            first.as_array().unwrap(),
            3,
            "2026-01-01T00:00:01Z",
            false,
        )
        .unwrap();
        let second = json!([{"content":"first","status":"completed"}]);
        todo(
            &bus,
            &turn,
            "ses:todo:turn-id",
            second.as_array().unwrap(),
            3,
            "2026-01-01T00:00:02Z",
            false,
        )
        .unwrap();
        bus.commit(|tx| {
            let (count, raw): (i64, String) = tx.query_row(
                "SELECT COUNT(*),MAX(payload_json) FROM orchestration_v2_projection_plans",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let plan: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(count, 1);
            assert_eq!(plan["status"], "completed");
            assert_eq!(plan["steps"][0]["text"], "first");
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
