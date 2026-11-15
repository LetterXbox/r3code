//! Credential verification for incoming scheduled task webhooks.
use crate::webhook_verification::{constant_time_equals, verify_signature};
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::collections::HashMap;

/// Validate the supported webhook schedule fields before persisting them.
pub fn validate_schedule(schedule: &Value) -> Result<(), String> {
    let invalid = || "Invalid webhook schedule.".to_owned();
    if let Some(age) = schedule.get("maxDeliveryAgeMinutes") {
        if !age.is_null() && age.as_i64().is_none_or(|n| !(1..=1440).contains(&n)) {
            return Err(invalid());
        }
    }
    if let Some(dedupe) = schedule.get("dedupe") {
        if !dedupe.is_object() {
            return Err(invalid());
        }
        let re =
            regex::Regex::new(r"\{\{\s*(?:(?:body|headers|query)(?:\.[^{}.\s]+)*|request)\s*\}\}")
                .unwrap();
        for name in ["replayKey", "coalesceKey"] {
            if let Some(value) = dedupe.get(name) {
                let text = value.as_str().ok_or_else(invalid)?;
                if !re.is_match(text) {
                    return Err(invalid());
                }
                let remainder = re.replace_all(text, "");
                if remainder.contains("{{") || remainder.contains("}}") {
                    return Err(invalid());
                }
            }
        }
        if dedupe
            .get("coalesceWindowSeconds")
            .is_some_and(|v| v.as_i64().is_none_or(|n| !(10..=3600).contains(&n)))
        {
            return Err(invalid());
        }
    }
    if let Some(filters) = schedule.get("filters") {
        let filters = filters.as_array().ok_or_else(invalid)?;
        if filters.len() > 16 {
            return Err(invalid());
        }
        for filter in filters {
            let path = filter["path"].as_str().ok_or_else(invalid)?;
            if path.trim() != path
                || path.is_empty()
                || !["body", "headers", "query"]
                    .iter()
                    .any(|root| path == *root || path.starts_with(&format!("{root}.")))
            {
                return Err(invalid());
            }
            match filter["op"].as_str() {
                Some("exists") => (),
                Some("equals" | "notEquals" | "startsWith") if filter["value"].is_string() => (),
                Some("in")
                    if filter["value"].as_array().is_some_and(|a| {
                        !a.is_empty()
                            && a.iter().all(|v| {
                                v.as_str().is_some_and(|s| {
                                    !s.is_empty() && s.trim() == s && !s.contains(',')
                                })
                            })
                    }) => {}
                _ => return Err(invalid()),
            }
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub enum Validation {
    NotFound,
    Disabled,
    InvalidSignature,
    Verified {
        task: Value,
        signature_verified: bool,
    },
}

/// Identify a webhook before reserving a rejection slot. Invalid tokens are never logged.
pub fn authenticated(db: &Connection, id: &str, token: &str) -> rusqlite::Result<bool> {
    let expected: Option<String> = db.query_row(
        "SELECT webhook_token FROM scheduled_tasks WHERE task_id=?1 AND json_extract(schedule_json,'$.type')='webhook'",
        [id], |r| r.get(0),
    ).optional()?.flatten();
    Ok(expected
        .as_deref()
        .is_some_and(|expected| constant_time_equals(token, expected)))
}

/// Validate against the current row. Call in the same transaction as admission,
/// so token rotation, disabling, and acceptance cannot race one another.
pub fn validate(
    db: &Connection,
    id: &str,
    token: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
) -> Result<Validation, String> {
    let credentials: Option<(Option<String>, Option<String>)> = db
        .query_row(
            "SELECT webhook_token,webhook_secret FROM scheduled_tasks WHERE task_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((Some(expected), secret)) = credentials else {
        return Ok(Validation::NotFound);
    };
    if !constant_time_equals(token, &expected) {
        return Ok(Validation::NotFound);
    }
    let Some(task) = crate::scheduled_tasks::get(db, id)? else {
        return Ok(Validation::NotFound);
    };
    if task["schedule"]["type"] != "webhook" {
        return Ok(Validation::NotFound);
    }
    if task["enabled"] != true {
        return Ok(Validation::Disabled);
    }
    let signature = &task["schedule"]["signature"];
    if signature.is_null() {
        return Ok(Validation::Verified {
            task,
            signature_verified: false,
        });
    }
    let verified = secret.as_ref().is_some_and(|secret| {
        verify_signature(
            signature["header"].as_str().unwrap_or(""),
            signature["encoding"].as_str().unwrap_or(""),
            signature["prefix"].as_str().unwrap_or(""),
            secret,
            headers,
            body,
        )
    });
    if !verified {
        return Ok(Validation::InvalidSignature);
    }
    Ok(Validation::Verified {
        task,
        signature_verified: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_invalid_webhook_schedule_fields() {
        for schedule in [
            json!({"type":"webhook","maxDeliveryAgeMinutes":0}),
            json!({"type":"webhook","dedupe":{"replayKey":"literal"}}),
            json!({"type":"webhook","dedupe":{"coalesceWindowSeconds":9}}),
            json!({"type":"webhook","filters":[{"path":"request","op":"exists"}]}),
            json!({"type":"webhook","filters":[{"path":"body.x","op":"in","value":["bad,entry"]}]}),
        ] {
            assert!(validate_schedule(&schedule).is_err(), "{schedule}");
        }
        assert!(validate_schedule(&json!({"type":"webhook","maxDeliveryAgeMinutes":1440,"dedupe":{"replayKey":"{{body.id}}","coalesceWindowSeconds":10},"filters":[{"path":"body.action","op":"equals","value":"push"}]})).is_ok());
    }
    #[test]
    fn token_and_signature_are_checked_before_admission() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../migrations/055-scheduled-tasks.sql"))
            .unwrap();
        db.execute_batch(include_str!("../migrations/057.sql"))
            .unwrap();
        db.execute_batch(include_str!("../migrations/080.sql"))
            .unwrap();
        let input = json!({"commandId":"hook", "title":"t", "prompt":"p", "enabled":false, "schedule":{"type":"webhook", "signature":{"header":"x-sig", "encoding":"hex", "prefix":"sha256=", "secret":"key"}}, "projectId":"p", "workspaceStrategy":{"type":"root"}, "modelSelection":{"instanceId":"i","model":"m"}, "runtimeMode":"full-access", "interactionMode":"default"});
        crate::scheduled_tasks::upsert(&db, &input, chrono::Utc::now()).unwrap();
        let token: String = db
            .query_row("SELECT webhook_token FROM scheduled_tasks", [], |r| {
                r.get(0)
            })
            .unwrap();
        let body = b"The quick brown fox jumps over the lazy dog";
        let headers = HashMap::from([(
            "x-sig".to_string(),
            "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8".to_string(),
        )]);
        assert_eq!(
            validate(&db, "scheduled-task:hook", "wrong", &headers, body).unwrap(),
            Validation::NotFound
        );
        assert_eq!(
            validate(&db, "scheduled-task:hook", &token, &headers, body).unwrap(),
            Validation::Disabled
        );
        db.execute("UPDATE scheduled_tasks SET enabled=1", [])
            .unwrap();
        assert_eq!(
            validate(&db, "scheduled-task:hook", &token, &headers, b"tampered").unwrap(),
            Validation::InvalidSignature
        );
        assert!(matches!(
            validate(&db, "scheduled-task:hook", &token, &headers, body).unwrap(),
            Validation::Verified {
                signature_verified: true,
                ..
            }
        ));
    }
}
