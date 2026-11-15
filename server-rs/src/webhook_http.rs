//! Transactional webhook request handling.
use crate::{
    event_bus::EventBus,
    http_server::{WebhookHttpRequest, WebhookHttpResponse},
    webhook_admission::{authenticated, validate, Validation},
    webhook_queue::{admit, Admission},
    webhook_template::WebhookRequest,
};
use chrono::{SecondsFormat, Utc};
use rusqlite::params;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};

pub fn handle(bus: &EventBus, request: WebhookHttpRequest) -> WebhookHttpResponse {
    handle_with_relay(bus, request, None)
}

/// Relay trust settings are read on each request so cloud linking and rotation take effect immediately.
pub struct RelayConfig<'a> {
    pub environment_id: &'a str,
    pub secrets_dir: &'a std::path::Path,
}

pub fn handle_with_relay(
    bus: &EventBus,
    request: WebhookHttpRequest,
    relay: Option<RelayConfig<'_>>,
) -> WebhookHttpResponse {
    let now = Utc::now();
    let delivery = format!("delivery:{}", uuid::Uuid::new_v4());
    let headers: BTreeMap<String, String> = request
        .headers
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|v| (k.as_str().to_owned(), v.to_owned()))
        })
        .collect();
    let verify_headers: HashMap<String, String> = headers.clone().into_iter().collect();
    let proof = relay.and_then(|config| {
        let read = |name: &str| {
            std::fs::read_to_string(config.secrets_dir.join(format!("{name}.bin"))).ok()
        };
        let public_key = read("cloud-mint-ed25519-public-key");
        let issuer = read("cloud-relay-issuer");
        let url = read("cloud-relay-url");
        crate::webhook_relay_proof::verify(
            &verify_headers,
            &request.hook_id,
            config.environment_id,
            public_key.as_deref(),
            issuer.as_deref(),
            url.as_deref(),
            now.timestamp(),
        )
    });
    let delivery = proof
        .as_ref()
        .map(|p| format!("delivery:relay:{}", p.delivery_id))
        .unwrap_or(delivery);
    let received_at = proof
        .as_ref()
        .and_then(|p| chrono::DateTime::parse_from_rfc3339(&p.received_at).ok())
        .map(|v| v.with_timezone(&Utc).min(now))
        .unwrap_or(now);
    let req = WebhookRequest {
        method: request.method.clone(),
        path: request.path.clone(),
        query: request.query.clone(),
        headers,
        body_text: String::from_utf8_lossy(&request.body).into_owned(),
    };
    let response = bus.commit(|tx| {
        if !authenticated(tx, &request.hook_id, &request.token)? {
            return Ok(((404,"not_found",json!({"error":"hook_not_found"})),vec![]));
        }
        if let Some(proof) = &proof {
            let changed = tx.execute("INSERT OR IGNORE INTO scheduled_task_webhook_relay_deliveries(relay_delivery_id,task_id,seen_at) VALUES(?1,?2,?3)", params![proof.delivery_id,request.hook_id,now.to_rfc3339_opts(SecondsFormat::Millis,true)])?;
            if changed == 0 { return Ok(((202,"duplicate",json!({"deliveryId":delivery})),vec![])); }
            tx.execute("DELETE FROM scheduled_task_webhook_relay_deliveries WHERE seen_at < ?1", [(now - chrono::Duration::hours(48)).to_rfc3339_opts(SecondsFormat::Millis,true)])?;
        }
        tx.execute_batch("CREATE TABLE IF NOT EXISTS scheduled_task_webhook_rejection_slots (task_id TEXT NOT NULL, delivery_id TEXT PRIMARY KEY, admitted_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_webhook_rejection_slots ON scheduled_task_webhook_rejection_slots(task_id, admitted_at); CREATE TABLE IF NOT EXISTS scheduled_task_webhook_rejection_limits (task_id TEXT PRIMARY KEY, logged INTEGER NOT NULL)")?;
        tx.execute("DELETE FROM scheduled_task_webhook_rejection_slots WHERE admitted_at<=?1", [now.timestamp_millis().saturating_sub(60_000)])?;
        let count: i64 = tx.query_row("SELECT count(*) FROM scheduled_task_webhook_rejection_slots WHERE task_id=?1", [&request.hook_id], |r| r.get(0))?;
        if count >= 60 {
            let changed = tx.execute("INSERT INTO scheduled_task_webhook_rejection_limits(task_id,logged) VALUES(?1,1) ON CONFLICT(task_id) DO UPDATE SET logged=1 WHERE logged=0", [&request.hook_id])?;
            if changed > 0 { log_delivery(tx, &request, &req, &delivery, received_at, "rate_limited", false, None)?; }
            if let Some(proof) = &proof { tx.execute("DELETE FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id=?1", [&proof.delivery_id])?; }
            return Ok(((429,"rate_limited",json!({"error":"rate_limited"})),vec![]));
        }
        tx.execute("INSERT INTO scheduled_task_webhook_rejection_slots(task_id,delivery_id,admitted_at) VALUES(?1,?2,?3)", params![request.hook_id,delivery,now.timestamp_millis()])?;
        tx.execute("INSERT INTO scheduled_task_webhook_rejection_limits(task_id,logged) VALUES(?1,0) ON CONFLICT(task_id) DO UPDATE SET logged=0", [&request.hook_id])?;
        let validation = validate(tx,&request.hook_id,&request.token,&verify_headers,&request.body).map_err(|_|rusqlite::Error::InvalidQuery)?;
        let (task,verified) = match validation {
            Validation::NotFound => return Ok(((404,"not_found",json!({"error":"hook_not_found"})),vec![])),
            Validation::Disabled => { log_delivery(tx,&request,&req,&delivery,received_at,"disabled",false,None)?; return Ok(((409,"disabled",json!({"error":"hook_disabled"})),vec![])); },
            Validation::InvalidSignature => { log_delivery(tx,&request,&req,&delivery,received_at,"rejected_signature",false,None)?; return Ok(((401,"rejected_signature",json!({"error":"invalid_signature"})),vec![])); },
            Validation::Verified {task,signature_verified} => (task,signature_verified),
        };
        if task["schedule"]["maxDeliveryAgeMinutes"].as_i64().is_some_and(|m| now.signed_duration_since(received_at).num_milliseconds() > m * 60_000) {
            log_delivery(tx,&request,&req,&delivery,received_at,"expired",verified,None)?;
            return Ok(((410,"expired",json!({"error":"delivery_too_old"})),vec![]));
        }
        let result = admit(tx,&task,&req,&delivery,now.timestamp_millis()).map_err(|_|rusqlite::Error::InvalidQuery)?;
        if matches!(result, Admission::Filtered(_) | Admission::RateLimited | Admission::QueueFull | Admission::Duplicate) {
            if let Some(proof) = &proof { tx.execute("DELETE FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id=?1", [&proof.delivery_id])?; }
        }
        let (status,outcome,error) = match &result {
            Admission::Queued => (202,"accepted",None), Admission::Coalesced => (202,"coalesced",None), Admission::Duplicate => (202,"duplicate",None),
            Admission::Filtered(reason) => (202,"filtered",Some(reason.as_str())), Admission::RateLimited => (429,"rate_limited",None), Admission::QueueFull => (429,"queue_full",None),
        };
        if !matches!(result, Admission::Coalesced) {
            tx.execute("DELETE FROM scheduled_task_webhook_rejection_slots WHERE delivery_id=?1", [&delivery])?;
        }
        let log = match result {
            Admission::Filtered(_) => log_slot(tx, &request.hook_id, "filtered", now.timestamp_millis())?,
            Admission::Duplicate | Admission::Coalesced => log_slot(tx, &request.hook_id, "dedupe", now.timestamp_millis())?,
            Admission::RateLimited => log_slot(tx, &request.hook_id, "rate_limited", now.timestamp_millis())?,
            Admission::QueueFull => false,
            Admission::Queued => true,
        };
        if log { log_delivery(tx, &request, &req, &delivery, received_at, outcome, verified, error)?; }
        if matches!(result, Admission::Coalesced) {
            tx.execute("UPDATE scheduled_task_webhook_deliveries SET method=?2,body=?3,body_bytes=?4,body_truncated=?5 WHERE delivery_id=(SELECT delivery_id FROM scheduled_task_webhook_pending WHERE EXISTS (SELECT 1 FROM json_each(delivery_ids_json) WHERE value=?1))", params![delivery, req.method, bounded_body(&request.body),request.body.len() as i64,request.body.len()>10_000])?;
        }
        let body = if status == 202 { json!({"deliveryId":delivery}) } else { json!({"error":outcome}) };
        Ok(((status,outcome,body),vec![]))
    });
    let (status, outcome, body) =
        response.unwrap_or((500, "error", json!({"error":"internal_error"})));
    WebhookHttpResponse {
        status,
        outcome: outcome.into(),
        body,
    }
}

fn log_slot(
    db: &rusqlite::Connection,
    task_id: &str,
    bucket: &str,
    now: i64,
) -> rusqlite::Result<bool> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS scheduled_task_webhook_log_slots(task_id TEXT NOT NULL,bucket TEXT NOT NULL,at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_webhook_log_slots ON scheduled_task_webhook_log_slots(task_id,bucket,at)")?;
    db.execute(
        "DELETE FROM scheduled_task_webhook_log_slots WHERE at<=?1",
        [now.saturating_sub(60_000)],
    )?;
    let count: i64 = db.query_row(
        "SELECT count(*) FROM scheduled_task_webhook_log_slots WHERE task_id=?1 AND bucket=?2",
        params![task_id, bucket],
        |r| r.get(0),
    )?;
    if count >= if bucket == "rate_limited" { 1 } else { 10 } {
        return Ok(false);
    }
    db.execute(
        "INSERT INTO scheduled_task_webhook_log_slots(task_id,bucket,at) VALUES(?1,?2,?3)",
        params![task_id, bucket, now],
    )?;
    Ok(true)
}

fn bounded_body(body: &[u8]) -> String {
    let end = body.len().min(10_000);
    let prefix = &body[..end];
    if end < body.len() {
        match std::str::from_utf8(prefix) {
            Ok(s) => s.to_owned(),
            Err(e) if e.error_len().is_none() => {
                String::from_utf8_lossy(&prefix[..e.valid_up_to()]).into_owned()
            }
            Err(_) => String::from_utf8_lossy(prefix).into_owned(),
        }
    } else {
        String::from_utf8_lossy(prefix).into_owned()
    }
}

#[allow(clippy::too_many_arguments)]
fn log_delivery(
    tx: &rusqlite::Connection,
    request: &WebhookHttpRequest,
    req: &WebhookRequest,
    delivery: &str,
    now: chrono::DateTime<Utc>,
    outcome: &str,
    verified: bool,
    error: Option<&str>,
) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO scheduled_task_webhook_deliveries(delivery_id,task_id,received_at,method,query,headers_json,body,body_bytes,body_truncated,outcome,signature_verified,missing_fields_json,error) VALUES(?1,?2,?3,?4,'','{}',?5,?6,?7,?8,?9,'[]',?10)",params![delivery,request.hook_id,now.to_rfc3339_opts(SecondsFormat::Millis,true),req.method,bounded_body(&request.body),request.body.len() as i64,request.body.len()>10_000,outcome,verified,error])?;
    // Keep suppression traffic from evicting ordinary run history.
    let bucket = if outcome == "filtered" {
        "filtered"
    } else if matches!(outcome, "duplicate" | "coalesced" | "rate_limited") {
        "dedupe"
    } else {
        "main"
    };
    tx.execute("DELETE FROM scheduled_task_webhook_deliveries WHERE task_id=?1 AND (CASE WHEN outcome='filtered' THEN 'filtered' WHEN outcome IN ('duplicate','coalesced','rate_limited') OR error='The filled-in prompt is too long.' THEN 'dedupe' ELSE 'main' END)=?2 AND delivery_id NOT IN (SELECT delivery_id FROM scheduled_task_webhook_deliveries WHERE task_id=?1 AND (CASE WHEN outcome='filtered' THEN 'filtered' WHEN outcome IN ('duplicate','coalesced','rate_limited') OR error='The filled-in prompt is too long.' THEN 'dedupe' ELSE 'main' END)=?2 ORDER BY received_at DESC,rowid DESC LIMIT ?3) AND delivery_id NOT IN (SELECT delivery_id FROM scheduled_task_webhook_pending)", params![request.hook_id,bucket,if bucket == "main" { 50 } else { 20 }])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};
    #[test]
    fn signed_relay_delivery_is_deduplicated_and_untrusted_headers_are_direct() {
        use base64::{
            engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
            Engine,
        };
        use ring::signature::{Ed25519KeyPair, KeyPair};
        let dir = std::env::temp_dir().join(format!("t3-relay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(
            ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
                .unwrap()
                .as_ref(),
        )
        .unwrap();
        let mut der = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        der.extend_from_slice(key.public_key().as_ref());
        std::fs::write(
            dir.join("cloud-mint-ed25519-public-key.bin"),
            format!(
                "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----",
                STANDARD.encode(der)
            ),
        )
        .unwrap();
        std::fs::write(dir.join("cloud-relay-url.bin"), "https://relay.example/").unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let input = json!({"commandId":"hook","title":"t","prompt":"p","enabled":false,"schedule":{"type":"webhook"},"projectId":"p","workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"});
        crate::scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
        let token: String = db
            .query_row("SELECT webhook_token FROM scheduled_tasks", [], |r| {
                r.get(0)
            })
            .unwrap();
        db.execute("UPDATE scheduled_tasks SET enabled=1", [])
            .unwrap();
        let bus = EventBus::new(db, 16);
        let now = Utc::now();
        let received = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        let h = URL_SAFE_NO_PAD
            .encode(json!({"alg":"EdDSA","typ":"t3-relay-hook-delivery+jwt"}).to_string());
        let p = URL_SAFE_NO_PAD.encode(json!({"iss":"https://relay.example","aud":"t3-env:env","sub":"relay","jti":"nonce","iat":now.timestamp(),"exp":now.timestamp()+300,"environmentId":"env","deliveryId":"id","receivedAt":received,"hookId":"scheduled-task:hook"}).to_string());
        let message = format!("{h}.{p}");
        let jwt = format!(
            "{message}.{}",
            URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).as_ref())
        );
        let mut headers = HeaderMap::new();
        headers.insert("x-t3-relay-delivery", HeaderValue::from_str(&jwt).unwrap());
        headers.insert("x-t3-relay-delivery-id", HeaderValue::from_static("id"));
        headers.insert(
            "x-t3-relay-received-at",
            HeaderValue::from_str(&received).unwrap(),
        );
        let request = |headers: HeaderMap| WebhookHttpRequest {
            hook_id: "scheduled-task:hook".into(),
            token: token.clone(),
            method: "POST".into(),
            path: "/".into(),
            query: String::new(),
            headers,
            body: vec![],
        };
        let run = |headers| {
            handle_with_relay(
                &bus,
                request(headers),
                Some(RelayConfig {
                    environment_id: "env",
                    secrets_dir: &dir,
                }),
            )
        };
        assert_eq!(run(headers.clone()).outcome, "accepted");
        assert_eq!(run(headers.clone()).outcome, "duplicate");
        // Without relay trust, even a valid old proof is treated as a direct
        // delivery rather than as the previously claimed relay delivery.
        assert_eq!(
            handle_with_relay(&bus, request(headers.clone()), None).outcome,
            "accepted"
        );
        headers.insert("x-t3-relay-delivery-id", HeaderValue::from_static("forged"));
        assert_eq!(run(headers).outcome, "accepted");
        bus.commit(|tx| {
            let n: i64 = tx.query_row(
                "SELECT count(*) FROM scheduled_task_webhook_relay_deliveries",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(n, 1);
            Ok(((), vec![]))
        })
        .unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn coalesced_relay_delivery_keeps_claim_until_dispatch() {
        use base64::{
            engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
            Engine,
        };
        use ring::signature::{Ed25519KeyPair, KeyPair};
        let dir = std::env::temp_dir().join(format!("t3-relay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(
            ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
                .unwrap()
                .as_ref(),
        )
        .unwrap();
        let mut der = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        der.extend_from_slice(key.public_key().as_ref());
        std::fs::write(
            dir.join("cloud-mint-ed25519-public-key.bin"),
            format!(
                "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----",
                STANDARD.encode(der)
            ),
        )
        .unwrap();
        std::fs::write(dir.join("cloud-relay-url.bin"), "https://relay.example/").unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let input = json!({"commandId":"hook","title":"t","prompt":"p","enabled":false,"schedule":{"type":"webhook","dedupe":{"coalesceKey":"{{body.group}}","coalesceWindowSeconds":10}},"projectId":"p","workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"});
        crate::scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
        let token: String = db
            .query_row("SELECT webhook_token FROM scheduled_tasks", [], |r| {
                r.get(0)
            })
            .unwrap();
        db.execute("UPDATE scheduled_tasks SET enabled=1", [])
            .unwrap();
        let bus = EventBus::new(db, 16);
        let now = Utc::now();
        let received = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        let h = URL_SAFE_NO_PAD
            .encode(json!({"alg":"EdDSA","typ":"t3-relay-hook-delivery+jwt"}).to_string());
        let p = URL_SAFE_NO_PAD.encode(json!({"iss":"https://relay.example","aud":"t3-env:env","sub":"relay","jti":"nonce","iat":now.timestamp(),"exp":now.timestamp()+300,"environmentId":"env","deliveryId":"id","receivedAt":received,"hookId":"scheduled-task:hook"}).to_string());
        let message = format!("{h}.{p}");
        let jwt = format!(
            "{message}.{}",
            URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).as_ref())
        );
        let mut headers = HeaderMap::new();
        headers.insert("x-t3-relay-delivery", HeaderValue::from_str(&jwt).unwrap());
        headers.insert("x-t3-relay-delivery-id", HeaderValue::from_static("id"));
        headers.insert(
            "x-t3-relay-received-at",
            HeaderValue::from_str(&received).unwrap(),
        );
        let request = |headers: HeaderMap| WebhookHttpRequest {
            hook_id: "scheduled-task:hook".into(),
            token: token.clone(),
            method: "POST".into(),
            path: "/".into(),
            query: String::new(),
            headers,
            body: br#"{"group":"same"}"#.to_vec(),
        };
        let run = |headers| {
            handle_with_relay(
                &bus,
                request(headers),
                Some(RelayConfig {
                    environment_id: "env",
                    secrets_dir: &dir,
                }),
            )
        };
        assert_eq!(handle(&bus, request(HeaderMap::new())).outcome, "accepted");
        assert_eq!(run(headers.clone()).outcome, "coalesced");
        assert_eq!(run(headers).outcome, "duplicate");
        bus.commit(|tx| {
            let claims: i64 = tx.query_row("SELECT count(*) FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id='id'", [], |r| r.get(0))?;
            let ids: String = tx.query_row("SELECT delivery_ids_json FROM scheduled_task_webhook_pending", [], |r| r.get(0))?;
            assert_eq!(claims, 1);
            assert_eq!(serde_json::from_str::<serde_json::Value>(&ids).unwrap().as_array().unwrap().len(), 2);
            Ok(((), vec![]))
        }).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_are_logged_and_throttled_without_affecting_unknown_tokens() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let input = json!({"commandId":"hook","title":"t","prompt":"p","enabled":false,"schedule":{"type":"webhook"},"projectId":"p","workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"});
        crate::scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
        let token: String = db
            .query_row("SELECT webhook_token FROM scheduled_tasks", [], |r| {
                r.get(0)
            })
            .unwrap();
        let bus = EventBus::new(db, 16);
        let request = |token: &str| WebhookHttpRequest {
            hook_id: "scheduled-task:hook".into(),
            token: token.into(),
            method: "POST".into(),
            path: "/".into(),
            query: "token=secret".into(),
            headers: HeaderMap::new(),
            body: vec![],
        };
        for _ in 0..65 {
            assert_eq!(handle(&bus, request("wrong")).status, 404);
        }
        for _ in 0..60 {
            assert_eq!(handle(&bus, request(&token)).status, 409);
        }
        for _ in 0..5 {
            assert_eq!(handle(&bus, request(&token)).status, 429);
        }
        bus.commit(|tx| {
            let rate: i64 = tx.query_row("SELECT count(*) FROM scheduled_task_webhook_deliveries WHERE outcome='rate_limited'", [], |r| r.get(0))?;
            let disabled: i64 = tx.query_row("SELECT count(*) FROM scheduled_task_webhook_deliveries WHERE outcome='disabled'", [], |r| r.get(0))?;
            assert_eq!(rate, 1);
            assert_eq!(disabled, 50);
            Ok(((),vec![]))
        }).unwrap();
    }

    #[test]
    fn body_log_limit_counts_bytes_and_does_not_split_utf8() {
        let body = format!("{}é", "a".repeat(9_999));
        assert_eq!(bounded_body(body.as_bytes()), "a".repeat(9_999));
    }

    #[test]
    fn validates_queues_and_dispatches_once() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')", []).unwrap();
        let input = json!({"commandId":"hook","title":"t","prompt":"Hello {{body.name}}","enabled":false,"schedule":{"type":"webhook","dedupe":{"replayKey":"{{body.id}}"},"signature":{"header":"x-sig","encoding":"hex","prefix":"sha256=","secret":"key"}},"projectId":"p","workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"});
        crate::scheduled_tasks::upsert(&db, &input, Utc::now()).unwrap();
        let token: String = db
            .query_row("SELECT webhook_token FROM scheduled_tasks", [], |r| {
                r.get(0)
            })
            .unwrap();
        db.execute("UPDATE scheduled_tasks SET enabled=1", [])
            .unwrap();
        let bus = EventBus::new(db, 16);
        let body = b"The quick brown fox jumps over the lazy dog".to_vec();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-sig",
            HeaderValue::from_static(
                "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
            ),
        );
        let request = |token: &str, data: Vec<u8>| WebhookHttpRequest {
            hook_id: "scheduled-task:hook".into(),
            token: token.into(),
            method: "POST".into(),
            path: "/api/hooks/scheduled-task%3Ahook".into(),
            query: "token=secret".into(),
            headers: headers.clone(),
            body: data,
        };
        assert_eq!(handle(&bus, request("bad", body.clone())).status, 404);
        assert_eq!(
            handle(&bus, request(&token, b"changed".to_vec())).status,
            401
        );
        let response = handle(&bus, request(&token, body));
        assert_eq!(response.status, 202);
        assert_eq!(response.outcome, "accepted");
        assert!(crate::webhook_worker::run_one(&bus, None).unwrap());
        bus.commit(|tx| {
            let n: i64 = tx.query_row(
                "SELECT count(*) FROM orchestration_v2_projection_messages",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(n, 1);
            let log: String = tx.query_row(
                "SELECT headers_json||query FROM scheduled_task_webhook_deliveries",
                [],
                |r| r.get(0),
            )?;
            assert!(!log.contains("secret"));
            Ok(((), vec![]))
        })
        .unwrap();
    }
}
