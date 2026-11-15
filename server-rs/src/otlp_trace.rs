//! Convert browser OTLP JSON into local trace records.
use serde_json::{json, Map, Value};

fn items(value: Option<&Value>) -> Result<&[Value], ()> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(v)) => Ok(v),
        _ => Err(()),
    }
}
fn decode_value(value: &Value) -> Result<Value, ()> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let value = value.as_object().ok_or(())?;
    for key in [
        "stringValue",
        "boolValue",
        "intValue",
        "doubleValue",
        "bytesValue",
    ] {
        if let Some(v) = value.get(key) {
            return Ok(v.clone());
        }
    }
    if let Some(v) = value.get("arrayValue").filter(|v| !v.is_null()) {
        return Ok(Value::Array(
            items(v.get("values"))?
                .iter()
                .map(decode_value)
                .collect::<Result<_, _>>()?,
        ));
    }
    if let Some(v) = value.get("kvlistValue").filter(|v| !v.is_null()) {
        return attributes(v.get("values"));
    }
    Ok(Value::Null)
}
fn truncate(value: &mut Value, limit: usize, budget: &mut usize) {
    match value {
        Value::String(s) => {
            let n = s.encode_utf16().count();
            if n > limit {
                let mut units: Vec<u16> = s.encode_utf16().take(limit).collect();
                units.extend("…[truncated]".encode_utf16());
                *s = String::from_utf16_lossy(&units);
            }
        }
        Value::Array(v) => {
            if *budget == 0 {
                *value = json!("[Truncated]");
                return;
            }
            *budget -= 1;
            for item in v {
                truncate(item, 500, budget);
            }
        }
        Value::Object(v) => {
            if *budget == 0 {
                *value = json!("[Truncated]");
                return;
            }
            *budget -= 1;
            for item in v.values_mut() {
                truncate(item, 500, budget);
            }
        }
        _ => {}
    }
}
fn attributes(input: Option<&Value>) -> Result<Value, ()> {
    let mut out = Map::new();
    for item in items(input)? {
        let key = item.get("key").and_then(Value::as_str).ok_or(())?;
        out.insert(
            key.to_owned(),
            decode_value(item.get("value").unwrap_or(&Value::Null))?,
        );
    }
    let mut budget = 10_000;
    for (key, value) in &mut out {
        truncate(
            value,
            if key == "db.query.text" && value.is_string() {
                200
            } else {
                500
            },
            &mut budget,
        );
    }
    Ok(Value::Object(out))
}
fn bigint(v: &Value) -> i128 {
    v.as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| v.as_i64().map(i128::from))
        .unwrap_or(0)
}
fn field(v: &Value, key: &str) -> Value {
    v.get(key).cloned().unwrap_or(Value::Null)
}

pub fn decode(payload: &Value) -> Result<Vec<Value>, ()> {
    if !payload.is_object() {
        return Err(());
    }
    let mut records = Vec::new();
    for resource in items(payload.get("resourceSpans"))? {
        let resource_attrs = attributes(resource.pointer("/resource/attributes"))?;
        for scope_span in items(resource.get("scopeSpans"))? {
            let scope = &scope_span["scope"];
            let mut scope_record = Map::new();
            if let Some(name) = scope
                .get("name")
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            {
                scope_record.insert("name".into(), name.clone());
            }
            if let Some(version) = scope
                .get("version")
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            {
                scope_record.insert("version".into(), version.clone());
            }
            scope_record.insert("attributes".into(), attributes(scope.get("attributes"))?);
            for span in items(scope_span.get("spans"))? {
                let mut events = Vec::new();
                for event in items(span.get("events"))? {
                    events.push(json!({"name":field(event,"name"),"timeUnixNano":field(event,"timeUnixNano"),"attributes":attributes(event.get("attributes"))?}));
                }
                let mut links = Vec::new();
                for link in items(span.get("links"))? {
                    links.push(json!({"traceId":field(link,"traceId"),"spanId":field(link,"spanId"),"attributes":attributes(link.get("attributes"))?}));
                }
                let status = &span["status"];
                let code = status
                    .get("code").filter(|v| !v.is_null())
                    .map(|v| {
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string())
                    })
                    .unwrap_or_else(|| "0".into());
                let mut status_record = json!({"code":code});
                if let Some(message) = status
                    .get("message")
                    .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                {
                    status_record["message"] = message.clone();
                }
                let start = field(span, "startTimeUnixNano");
                let end = field(span, "endTimeUnixNano");
                let kind = match span.get("kind").and_then(Value::as_i64) {
                    Some(2) => "server",
                    Some(3) => "client",
                    Some(4) => "producer",
                    Some(5) => "consumer",
                    _ => "internal",
                };
                let mut record = json!({"type":"otlp-span","name":field(span,"name"),"traceId":field(span,"traceId"),"spanId":field(span,"spanId"),"sampled":true,"kind":kind,"startTimeUnixNano":start,"endTimeUnixNano":end,"durationMs":(bigint(&end)-bigint(&start)) as f64 / 1_000_000.0,"attributes":attributes(span.get("attributes"))?,"resourceAttributes":resource_attrs,"scope":scope_record,"events":events,"links":links,"status":status_record});
                if let Some(parent) = span
                    .get("parentSpanId")
                    .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                {
                    record["parentSpanId"] = parent.clone();
                }
                records.push(record);
            }
        }
    }
    Ok(records)
}
