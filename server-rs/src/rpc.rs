//! JSON WebSocket RPC framing and message constructors.
//!
//! This module only handles the transport envelope; method payload validation,
//! request lifetimes, flow control and WebSocket I/O belong to higher layers.
use serde_json::{json, Number, Value};
use std::fmt;

/// Request identifiers retain their JSON type when echoed in responses.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RequestId {
    String(String),
    Number(Number),
}

impl RequestId {
    pub fn from_value(value: &Value) -> Result<Self, FrameError> {
        match value {
            Value::String(s) => Ok(Self::String(s.clone())),
            Value::Number(n) => Ok(Self::Number(n.clone())),
            _ => Err(FrameError("request id must be a string or number".into())),
        }
    }
    pub fn to_value(&self) -> Value {
        match self {
            Self::String(s) => Value::String(s.clone()),
            Self::Number(n) => Value::Number(n.clone()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: RequestId,
    pub tag: String,
    pub payload: Value,
    pub headers: Vec<(String, String)>,
    pub is_notification: bool,
    pub discard: bool,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub sampled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClientMessage {
    Request(Request),
    Ack { request_id: RequestId },
    Interrupt { request_id: RequestId },
    Ping,
    Eof,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameError(pub String);
impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for FrameError {}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, FrameError> {
    value
        .get(name)
        .ok_or_else(|| FrameError(format!("missing {name}")))
}
fn string_field(value: &Value, name: &str) -> Result<String, FrameError> {
    field(value, name)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| FrameError(format!("{name} must be a string")))
}
fn optional_string(value: &Value, name: &str) -> Result<Option<String>, FrameError> {
    value
        .get(name)
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| FrameError(format!("{name} must be a string")))
        })
        .transpose()
}
fn optional_bool(value: &Value, name: &str) -> Result<Option<bool>, FrameError> {
    value
        .get(name)
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| FrameError(format!("{name} must be a boolean")))
        })
        .transpose()
}

/// Decode one text or UTF-8 binary frame. Arrays are batches; an empty array is a no-op.
/// A malformed member rejects the entire frame so callers can send a connection Defect.
pub fn decode_frame(bytes: &[u8]) -> Result<Vec<ClientMessage>, FrameError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| FrameError(e.to_string()))?;
    match value {
        Value::Array(values) => values.iter().map(decode_message).collect(),
        other => Ok(vec![decode_message(&other)?]),
    }
}

pub fn decode_message(value: &Value) -> Result<ClientMessage, FrameError> {
    match string_field(value, "_tag")?.as_str() {
        "Request" => {
            let headers = field(value, "headers")?
                .as_array()
                .ok_or_else(|| FrameError("headers must be an array".into()))?
                .iter()
                .map(|entry| {
                    let pair = entry
                        .as_array()
                        .filter(|a| a.len() == 2)
                        .ok_or_else(|| FrameError("header must be a pair of strings".into()))?;
                    let name = pair[0]
                        .as_str()
                        .ok_or_else(|| FrameError("header name must be a string".into()))?;
                    let value = pair[1]
                        .as_str()
                        .ok_or_else(|| FrameError("header value must be a string".into()))?;
                    Ok((name.to_owned(), value.to_owned()))
                })
                .collect::<Result<Vec<_>, FrameError>>()?;
            Ok(ClientMessage::Request(Request {
                id: RequestId::from_value(field(value, "id")?)?,
                tag: string_field(value, "tag")?,
                payload: field(value, "payload")?.clone(),
                headers,
                is_notification: optional_bool(value, "isNotification")?.unwrap_or(false),
                discard: optional_bool(value, "discard")?.unwrap_or(false),
                trace_id: optional_string(value, "traceId")?,
                span_id: optional_string(value, "spanId")?,
                sampled: optional_bool(value, "sampled")?,
            }))
        }
        "Ack" => Ok(ClientMessage::Ack {
            request_id: RequestId::from_value(field(value, "requestId")?)?,
        }),
        "Interrupt" => Ok(ClientMessage::Interrupt {
            request_id: RequestId::from_value(field(value, "requestId")?)?,
        }),
        "Ping" => Ok(ClientMessage::Ping),
        "Eof" => Ok(ClientMessage::Eof),
        tag => Err(FrameError(format!("unknown client message tag: {tag}"))),
    }
}

/// Construct server frames as JSON values; each value encodes to one text frame.
pub fn pong() -> Value {
    json!({"_tag":"Pong"})
}
pub fn chunk(id: &RequestId, values: Vec<Value>) -> Result<Value, FrameError> {
    if values.is_empty() {
        return Err(FrameError("chunk values must be non-empty".into()));
    }
    Ok(json!({"_tag":"Chunk", "requestId":id.to_value(), "values":values}))
}
pub fn exit_success(id: &RequestId, value: Value) -> Value {
    json!({"_tag":"Exit", "requestId":id.to_value(), "exit":{"_tag":"Success", "value":value}})
}
pub fn exit_failure(id: &RequestId, cause: Vec<Value>) -> Value {
    json!({"_tag":"Exit", "requestId":id.to_value(), "exit":{"_tag":"Failure", "cause":cause}})
}
pub fn fail(error: Value) -> Value {
    json!({"_tag":"Fail", "error":error})
}
pub fn die(defect: Value) -> Value {
    json!({"_tag":"Die", "defect":defect})
}
pub fn interrupt(fiber_id: Option<Value>) -> Value {
    json!({"_tag":"Interrupt", "fiberId":fiber_id.unwrap_or(Value::Null)})
}
pub fn defect(value: Value) -> Value {
    json!({"_tag":"Defect", "defect":value})
}
pub fn encode_frame(message: &Value) -> Result<String, serde_json::Error> {
    serde_json::to_string(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_single_batch_and_empty_frames() {
        assert_eq!(
            decode_frame(br#"[{"_tag":"Ping"},{"_tag":"Ack","requestId":"1"}]"#).unwrap(),
            vec![
                ClientMessage::Ping,
                ClientMessage::Ack {
                    request_id: RequestId::String("1".into())
                }
            ]
        );
        assert!(decode_frame(b"[]").unwrap().is_empty());
        assert_eq!(
            decode_frame(br#"{"_tag":"Ping"}"#).unwrap(),
            vec![ClientMessage::Ping]
        );
        assert!(decode_frame(b"\xff").is_err());
        assert!(decode_frame(br#"[{"_tag":"Ping"},{"_tag":"Unknown"}]"#).is_err());
    }
    #[test]
    fn request_and_responses_preserve_id_types_and_null() {
        let messages = decode_frame(
            br#"{"_tag":"Request","id":0,"tag":"server.probe","payload":{},"headers":[["x","y"]]}"#,
        )
        .unwrap();
        let ClientMessage::Request(request) = &messages[0] else {
            panic!()
        };
        assert_eq!(request.headers, vec![("x".into(), "y".into())]);
        assert_eq!(
            exit_success(&request.id, Value::Null),
            json!({"_tag":"Exit","requestId":0,"exit":{"_tag":"Success","value":null}})
        );
        let id = RequestId::String("0".into());
        assert_eq!(
            chunk(&id, vec![json!({"x":1})]).unwrap()["requestId"],
            json!("0")
        );
        assert!(chunk(&id, vec![]).is_err());
        assert_eq!(
            exit_failure(&id, vec![interrupt(None)])["exit"]["cause"][0]["fiberId"],
            Value::Null
        );
    }
    #[test]
    fn rejects_invalid_envelopes() {
        for frame in [
            r#"{"_tag":"Request","id":null,"tag":"x","payload":{},"headers":[]}"#,
            r#"{"_tag":"Request","id":1,"tag":"x","payload":{},"headers":[["x"]]}"#,
            r#"{"_tag":"Ack","requestId":true}"#,
        ] {
            assert!(decode_frame(frame.as_bytes()).is_err());
        }
    }
}
