//! Read persisted webhook delivery logs using the server's wire shape.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

const SELECT: &str = "SELECT d.delivery_id,d.task_id,d.received_at,d.method,d.query,d.headers_json,d.body,d.body_bytes,d.body_truncated,d.outcome,d.signature_verified,d.missing_fields_json,d.rendered_prompt,d.error,EXISTS(SELECT 1 FROM scheduled_task_webhook_pending p WHERE p.delivery_id=d.delivery_id AND p.state IN ('pending','ready','dispatching')) FROM scheduled_task_webhook_deliveries d";
fn legacy(outcome: &str) -> bool {
    matches!(
        outcome,
        "accepted"
            | "dispatch_failed"
            | "rejected_signature"
            | "disabled"
            | "rate_limited"
            | "expired"
    )
}
fn decode(row: &rusqlite::Row<'_>, detail: bool) -> rusqlite::Result<Value> {
    let raw: String = row.get(5)?;
    let headers: Value = serde_json::from_str::<Value>(&raw)
        .ok()
        .filter(|v| {
            v.as_object()
                .is_some_and(|o| o.values().all(Value::is_string))
        })
        .unwrap_or_else(|| json!({}));
    let raw: String = row.get(11)?;
    let missing: Value = serde_json::from_str::<Value>(&raw)
        .ok()
        .filter(|v| v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
        .unwrap_or_else(|| json!([]));
    let outcome: String = row.get(9)?;
    let mut value = json!({"id":row.get::<_,String>(0)?,"taskId":row.get::<_,String>(1)?,"receivedAt":row.get::<_,String>(2)?,"method":row.get::<_,String>(3)?,"contentType":headers.get("content-type").and_then(Value::as_str),"bodyBytes":row.get::<_,i64>(7)?,"outcome":outcome,"signatureVerified":row.get::<_,bool>(10)?,"pendingWindow":outcome=="accepted" && row.get::<_,bool>(14)?,"missingFields":missing,"error":row.get::<_,Option<String>>(13)?});
    if detail {
        value["query"] = json!(row.get::<_, String>(4)?);
        value["headers"] = headers;
        value["body"] = json!(row.get::<_, String>(6)?);
        value["bodyTruncated"] = json!(row.get::<_, bool>(8)?);
        value["renderedPrompt"] = json!(row.get::<_, Option<String>>(12)?);
    }
    Ok(value)
}
pub fn list(db: &Connection, task: &str, any: bool) -> rusqlite::Result<Value> {
    let mut stmt = db.prepare(&format!(
        "{SELECT} WHERE d.task_id=?1 ORDER BY d.received_at DESC,d.rowid DESC"
    ))?;
    let rows = stmt.query_map([task], |r| decode(r, false))?;
    let mut values = Vec::new();
    for row in rows {
        let value = row?;
        if any || legacy(value["outcome"].as_str().unwrap_or("")) {
            values.push(value);
        }
    }
    Ok(json!({"deliveries":values}))
}
pub fn get(db: &Connection, task: &str, id: &str, any: bool) -> rusqlite::Result<Option<Value>> {
    let value: Option<Value> = db
        .query_row(
            &format!("{SELECT} WHERE d.task_id=?1 AND d.delivery_id=?2"),
            params![task, id],
            |r| decode(r, true),
        )
        .optional()?;
    Ok(value
        .filter(|v| any || legacy(v["outcome"].as_str().unwrap_or("")))
        .map(|v| json!({"delivery":v})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_clients_do_not_receive_new_outcomes_and_details_are_scoped() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE scheduled_task_webhook_deliveries(delivery_id TEXT,task_id TEXT,received_at TEXT,method TEXT,query TEXT,headers_json TEXT,body TEXT,body_bytes INTEGER,body_truncated INTEGER,outcome TEXT,signature_verified INTEGER,missing_fields_json TEXT,rendered_prompt TEXT,error TEXT); CREATE TABLE scheduled_task_webhook_pending(delivery_id TEXT,state TEXT);").unwrap();
        db.execute("INSERT INTO scheduled_task_webhook_deliveries VALUES('a','t','2026','POST','q','{\"content-type\":\"application/json\"}','body',4,0,'accepted',1,'[]','prompt',NULL),('b','t','2027','POST','','{}','',0,0,'filtered',0,'broken',NULL,NULL)",[]).unwrap();
        db.execute(
            "INSERT INTO scheduled_task_webhook_pending VALUES('a','pending')",
            [],
        )
        .unwrap();
        assert_eq!(
            list(&db, "t", false).unwrap()["deliveries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list(&db, "t", true).unwrap()["deliveries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(get(&db, "other", "a", true).unwrap().is_none());
        assert!(get(&db, "t", "b", false).unwrap().is_none());
        let value = get(&db, "t", "a", false).unwrap().unwrap();
        assert_eq!(value["delivery"]["pendingWindow"], true);
        assert_eq!(value["delivery"]["contentType"], "application/json");
        assert_eq!(value["delivery"]["renderedPrompt"], "prompt");
        db.execute("UPDATE scheduled_task_webhook_deliveries SET headers_json='{\"x-bad\":1}' WHERE delivery_id='a'", []).unwrap();
        assert_eq!(
            get(&db, "t", "a", false).unwrap().unwrap()["delivery"]["headers"],
            json!({})
        );
    }
}
