//! Startup reconciliation of legacy V1 thread shells.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn valid_legacy_attachment(value: &serde_json::Value) -> bool {
    let text = |key: &str, limit: usize| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= limit)
    };
    let Some(kind) = text("type", 50) else {
        return false;
    };
    let Some(id) = text("id", 128) else {
        return false;
    };
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || text("name", 255).is_none()
    {
        return false;
    }
    let Some(mime) = text("mimeType", 100) else {
        return false;
    };
    let Some(size) = value.get("sizeBytes").and_then(serde_json::Value::as_u64) else {
        return false;
    };
    match kind {
        "image" => mime.to_ascii_lowercase().starts_with("image/") && size <= 10 * 1024 * 1024,
        "file" => {
            (1..=50 * 1024 * 1024).contains(&size)
                && value
                    .get("source")
                    .is_none_or(|source| source["_tag"] == "pasted-text")
        }
        _ => true,
    }
}

/// Hydrate a pending V1 transcript within the caller's write transaction.
/// The bus serializes writers, so the lookup, projection writes and events are atomic.
fn import_previews(
    tx: &rusqlite::Transaction<'_>,
    tid: &str,
    now: &str,
) -> rusqlite::Result<Vec<event_store::StoredEvent>> {
    use rusqlite::params;
    use serde_json::{json, Value};
    let mut stmt = tx.prepare("SELECT message_id,role,text,attachments_json,context_json,is_streaming,created_at,updated_at,ROW_NUMBER() OVER (ORDER BY created_at,message_id) FROM projection_thread_messages WHERE thread_id=?1 AND role IN ('user','assistant') ORDER BY created_at,message_id")?;
    let rows = stmt
        .query_map([tid], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let latest_user = rows.iter().rposition(|r| r.1 == "user");
    let latest = rows.len().checked_sub(1);
    let rows: Vec<_> = rows
        .into_iter()
        .enumerate()
        .filter_map(|(i, row)| (Some(i) == latest_user || Some(i) == latest).then_some(row))
        .collect();
    let mut events = Vec::new();
    for (id, role, text, attachments, context, streaming, created, updated, ordinal) in rows {
        let event_id = format!("migration:v1:message:{id}");
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM orchestration_events WHERE event_id=?1)",
            [&event_id],
            |r| r.get(0),
        )?;
        if exists {
            continue;
        }
        let valid_date = |s: &str| chrono::DateTime::parse_from_rfc3339(s).is_ok();
        let created = if valid_date(&created) {
            created
        } else if valid_date(&updated) {
            updated.clone()
        } else {
            now.to_owned()
        };
        let updated = if valid_date(&updated) {
            updated
        } else {
            created.clone()
        };
        let attachments: Value = attachments
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|v| {
                v.as_array()
                    .is_some_and(|items| items.iter().all(valid_legacy_attachment))
            })
            .unwrap_or_else(|| json!([]));
        let context: Option<Value> = context
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|v| v["version"] == 1 && v["records"].is_array());
        let item_id = format!("migration:v1:turn-item:{id}");
        let mut message = json!({"createdBy":if role=="user" {"user"} else {"agent"},"creationSource":"server","id":id,"threadId":tid,"runId":null,"nodeId":null,"role":role,"text":text,"attachments":attachments,"streaming":false,"createdAt":created,"updatedAt":updated});
        let mut item = json!({"id":item_id,"threadId":tid,"runId":null,"nodeId":null,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"status":if streaming==1 {"interrupted"} else {"completed"},"title":null,"startedAt":created,"completedAt":updated,"updatedAt":updated,"type":if role=="user" {"user_message"} else {"assistant_message"},"messageId":id,"text":text});
        if role == "user" {
            item["createdBy"] = json!("user");
            item["creationSource"] = json!("server");
            item["inputIntent"] = json!("turn_start");
            item["attachments"] = attachments;
        } else {
            item["streaming"] = json!(false);
        }
        if let Some(context) = context {
            message["context"] = context.clone();
            item["context"] = context;
        }
        tx.execute("INSERT INTO orchestration_v2_turn_item_positions(thread_id,turn_item_id,ordinal) VALUES(?1,?2,?3) ON CONFLICT(thread_id,turn_item_id) DO NOTHING",params![tid,item_id,ordinal])?;
        tx.execute("INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES(?1,?2,NULL,NULL,?3,0,?4,?5,?6)",params![id,tid,role,created,updated,message.to_string()])?;
        tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES(?1,?2,NULL,NULL,NULL,NULL,NULL,?3,?4,?5,?6,?7)",params![item_id,tid,ordinal,item["type"].as_str(),item["status"].as_str(),updated,item.to_string()])?;
        for (event_id, kind, payload) in [
            (event_id, "message.updated", message),
            (item_id, "turn-item.updated", item),
        ] {
            events.push(event_store::Event {
                id: event_id,
                aggregate_kind: "thread".into(),
                stream_id: tid.into(),
                event_type: kind.into(),
                occurred_at: updated.clone(),
                command_id: None,
                causation_event_id: None,
                correlation_id: None,
                actor_kind: "system".into(),
                payload,
                metadata: json!({}),
            });
        }
    }
    let stored = event_store::append(tx, &events)?;
    Ok(stored)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ImportCounts {
    pub imported_thread_count: usize,
    pub imported_message_count: usize,
}

/// Count threads requiring either shell creation or transcript hydration.
pub fn pending_thread_count(db: &Connection) -> rusqlite::Result<usize> {
    db.query_row("SELECT COUNT(*) FROM (SELECT thread_id FROM projection_threads t WHERE NOT EXISTS (SELECT 1 FROM orchestration_events e WHERE e.application_event_version=2 AND e.aggregate_kind='thread' AND e.stream_id=t.thread_id AND e.event_type='thread.created') UNION SELECT thread_id FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL)", [], |r| r.get(0))
}

fn event(id: String, tid: &str, kind: &str, at: &str, payload: Value) -> Event {
    Event {
        id,
        aggregate_kind: "thread".into(),
        stream_id: tid.into(),
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
fn parsed_date(s: Option<&str>, fallback: &str) -> String {
    s.filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .unwrap_or(fallback)
        .to_owned()
}
fn trim(v: &Value) -> Value {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, |s| json!(s))
}
fn parse_json(v: &Value) -> Value {
    v.as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}
fn imported(db: &Connection, id: &str, now: &str) -> rusqlite::Result<Value> {
    let raw: String = db.query_row("SELECT json_object('id',thread_id,'projectId',project_id,'title',title,'model',model_selection_json,'runtimeMode',runtime_mode,'interactionMode',interaction_mode,'branch',branch,'worktreePath',worktree_path,'createdAt',created_at,'updatedAt',updated_at,'deletedAt',deleted_at,'archivedAt',archived_at,'settledAt',settled_at,'settledOverride',settled_override,'unsettledAt',unsettled_at,'snoozedUntil',snoozed_until,'snoozedAt',snoozed_at,'pinnedAt',pinned_at,'pinOrderKey',pin_order_key,'autoSettleDisabledAt',auto_settle_disabled_at,'linkedPullRequest',linked_pull_request_json,'branchPullRequest',branch_pull_request_json,'activeOrderKey',active_order_key) FROM projection_threads WHERE thread_id=?1",[id],|r|r.get(0))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let updated_fallback = parsed_date(v["updatedAt"].as_str(), now);
    let created = parsed_date(v["createdAt"].as_str(), &updated_fallback);
    let updated = parsed_date(v["updatedAt"].as_str(), &created);
    let mut model = parse_json(&v["model"]);
    if model["instanceId"].as_str().is_none() || model["model"].as_str().is_none() {
        model = json!({"instanceId":"codex","model":"gpt-6-astra"});
    }
    let runtime = v["runtimeMode"]
        .as_str()
        .filter(|s| {
            matches!(
                *s,
                "approval-required" | "auto-accept-edits" | "auto" | "full-access"
            )
        })
        .unwrap_or("full-access");
    let title = v["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Untitled thread");
    let linked = parse_json(&v["linkedPullRequest"]);
    let mut prs = Vec::<Value>::new();
    let mut stmt = db.prepare("SELECT host,repository,number,url,source,linked_at,snapshot_json,stack_json FROM projection_thread_pull_requests WHERE thread_id=?1 ORDER BY linked_at,host,repository,number")?;
    let rows = stmt.query_map([id], |r| { let snapshot:Option<String>=r.get(6)?; let stack:Option<String>=r.get(7)?; Ok(json!({"host":r.get::<_,String>(0)?,"repository":r.get::<_,String>(1)?,"number":r.get::<_,i64>(2)?,"url":r.get::<_,String>(3)?,"source":r.get::<_,String>(4)?,"linkedAt":r.get::<_,String>(5)?,"snapshot":snapshot.and_then(|s|serde_json::from_str::<Value>(&s).ok()),"stack":stack.and_then(|s|serde_json::from_str::<Value>(&s).ok())})) })?;
    for row in rows {
        prs.push(row?);
    }
    if let Some((repository, number, url)) =
        crate::migration_050::parse_legacy_link(&linked.to_string())
    {
        let key = crate::migration_050::legacy_pull_request_key(&repository, number, &url);
        if !prs.iter().any(|p| {
            p["host"] == key.host && p["repository"] == key.repository && p["number"] == number
        }) {
            prs.push(json!({"host":key.host,"repository":key.repository,"number":number,"url":url,"source":"manual","linkedAt":"1970-01-01T00:00:00.000Z","snapshot":null,"stack":null}));
        }
    }
    let mut t = json!({"id":id,"projectId":v["projectId"],"title":title,"createdBy":"system","creationSource":"server","providerInstanceId":model["instanceId"],"modelSelection":model,"runtimeMode":runtime,"interactionMode":if v["interactionMode"]=="plan" {"plan"} else {"default"},"branch":trim(&v["branch"]),"worktreePath":trim(&v["worktreePath"]),"activeProviderThreadId":null,"historyOrigin":"v1_import","lineage":{"parentThreadId":null,"relationshipToParent":null,"rootThreadId":id},"forkedFrom":null,"lastVisitedAt":null,"createdAt":created,"updatedAt":updated,"settledOverride":v["settledOverride"].as_str().filter(|s| matches!(*s,"settled"|"active")),"pinOrderKey":trim(&v["pinOrderKey"]),"activeOrderKey":trim(&v["activeOrderKey"]),"linkedPullRequest":linked,"branchPullRequest":parse_json(&v["branchPullRequest"]),"pullRequests":prs});
    for key in [
        "archivedAt",
        "settledAt",
        "unsettledAt",
        "snoozedUntil",
        "snoozedAt",
        "pinnedAt",
        "autoSettleDisabledAt",
        "deletedAt",
    ] {
        t[key] = if v[key].is_null() {
            Value::Null
        } else {
            json!(parsed_date(v[key].as_str(), &updated))
        };
    }
    Ok(t)
}

/// Reconcile shells in the event bus write lane before provider recovery starts.
pub fn reconcile_shells(bus: &EventBus) -> Result<ImportCounts, BusError> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    bus.commit(|tx| {
        let mut counts=ImportCounts::default(); let mut published=Vec::new();
        let mut stmt=tx.prepare("SELECT i.thread_id,p.payload_json FROM orchestration_v2_legacy_imports i JOIN projection_threads t ON t.thread_id=i.thread_id JOIN orchestration_v2_projection_threads p ON p.thread_id=i.thread_id ORDER BY t.created_at,t.thread_id")?;
        let repairs=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?; drop(stmt);
        for (id,raw) in repairs { let Ok(mut stored)=serde_json::from_str::<Value>(&raw) else {continue}; let Some(obj)=stored.as_object_mut() else {continue};
            let keys=["pinnedAt","autoSettleDisabledAt","pinOrderKey","snoozedUntil","snoozedAt","unsettledAt","linkedPullRequest","pullRequests","branchPullRequest","activeOrderKey"];
            if !keys.iter().any(|k| !obj.contains_key(*k)) {continue} let legacy=imported(tx,&id,&now)?;
            for key in keys { if !obj.contains_key(key) { let value=if key=="pullRequests" && obj.get("linkedPullRequest")==Some(&Value::Null) {json!([])} else {legacy[key].clone()}; obj.insert(key.into(),value); } }
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?2 WHERE thread_id=?1",params![id,stored.to_string()])?;
            published.extend(event_store::append(tx,&[event(format!("migration:v1:thread:{id}:metadata-repair:{}",uuid::Uuid::new_v4()),&id,"thread.metadata-updated",&now,stored)])?); counts.imported_thread_count+=1;
        }
        let mut stmt=tx.prepare("SELECT t.thread_id,t.updated_at FROM projection_threads t WHERE NOT EXISTS (SELECT 1 FROM orchestration_events e WHERE e.application_event_version=2 AND e.aggregate_kind='thread' AND e.stream_id=t.thread_id AND e.event_type='thread.created') ORDER BY t.created_at,t.thread_id")?;
        let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?; drop(stmt);
        for (id,source_updated) in rows { let t=imported(tx,&id,&now)?; let created=t["createdAt"].as_str().unwrap(); let updated=t["updatedAt"].as_str().unwrap();
            tx.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,archived_at,deleted_at,payload_json) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?8,?9,?10,?11)",params![id,t["projectId"].as_str(),t["title"].as_str(),t["providerInstanceId"].as_str(),t["runtimeMode"].as_str(),t["interactionMode"].as_str(),created,updated,t["archivedAt"].as_str(),t["deletedAt"].as_str(),t.to_string()])?;
            published.extend(event_store::append(tx,&[event(format!("migration:v1:thread:{id}:created"),&id,"thread.created",created,t.clone())])?);
            let previews=import_previews(tx,&id,&now)?; let n=previews.len()/2; published.extend(previews);
            published.extend(event_store::append(tx,&[event(format!("migration:v1:thread:{id}:shell"),&id,"thread.metadata-updated",updated,t.clone())])?);
            tx.execute("INSERT INTO orchestration_v2_legacy_imports(thread_id,source_updated_at,shell_imported_at,imported_message_count) VALUES(?1,?2,?3,?4) ON CONFLICT(thread_id) DO NOTHING",params![id,source_updated,now,n as i64])?;
            counts.imported_thread_count+=1; counts.imported_message_count+=n;
        } Ok((counts,published))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_previews_then_hydrates_and_repairs_without_overwriting_nulls() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at,pinned_at,pin_order_key,archived_at) VALUES('t','p','Legacy','2026-01-01T00:00:00Z','bad','2026-01-02T00:00:00Z',' a ','bad')",[]).unwrap();
        for (id, role) in [
            ("m1", "user"),
            ("m2", "assistant"),
            ("m3", "user"),
            ("m4", "assistant"),
        ] {
            db.execute("INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES(?1,'t',?2,?1,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",params![id,role]).unwrap();
        }
        assert_eq!(pending_thread_count(&db).unwrap(), 1);
        let bus = EventBus::new(db, 32);
        assert_eq!(
            reconcile_shells(&bus).unwrap(),
            ImportCounts {
                imported_thread_count: 1,
                imported_message_count: 2
            }
        );
        assert_eq!(reconcile_shells(&bus).unwrap(), ImportCounts::default());
        bus.commit(|tx| { assert_eq!(pending_thread_count(tx)?,1); let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|r.get(0))?; let mut v:Value=serde_json::from_str(&raw).unwrap(); assert_eq!(v["historyOrigin"],"v1_import"); assert_eq!(v["pinOrderKey"],"a"); assert!(!v["archivedAt"].is_null()); v["pinnedAt"]=Value::Null; v.as_object_mut().unwrap().remove("activeOrderKey"); tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?1 WHERE thread_id='t'",[v.to_string()])?; Ok(((),vec![])) }).unwrap();
        assert_eq!(
            reconcile_shells(&bus).unwrap(),
            ImportCounts {
                imported_thread_count: 1,
                imported_message_count: 0
            }
        );
        assert_eq!(reconcile_shells(&bus).unwrap(), ImportCounts::default());
        crate::legacy_transcript::ensure_transcript(&bus, "t").unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let v: Value = serde_json::from_str(&raw).unwrap();
            assert!(v["pinnedAt"].is_null());
            assert!(v.get("activeOrderKey").is_some());
            assert_eq!(pending_thread_count(tx)?, 0);
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM orchestration_v2_projection_messages WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 4);
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[test]
    fn failure_rolls_back_shell_and_events() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES('t','p','T','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[]).unwrap();
        db.execute_batch("CREATE TRIGGER fail_shell BEFORE INSERT ON orchestration_v2_legacy_imports BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
        let bus = EventBus::new(db, 8);
        assert!(reconcile_shells(&bus).is_err());
        bus.commit(|tx| {
            let n: i64 = tx.query_row("SELECT COUNT(*) FROM orchestration_events", [], |r| {
                r.get(0)
            })?;
            assert_eq!(n, 0);
            let n: i64 = tx.query_row(
                "SELECT COUNT(*) FROM orchestration_v2_projection_threads",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(n, 0);
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
