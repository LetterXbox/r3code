//! Shared wire-codec primitives; method-specific schemas are still required.
use serde_json::{json, Map, Value};

pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// ECMAScript WhiteSpace and LineTerminator characters, used by String.trim().
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn trimmed_nonempty(value: &Value) -> Option<String> {
    let result = value.as_str()?.trim_matches(js_whitespace);
    (!result.is_empty()).then(|| result.to_owned())
}
pub fn safe_integer(value: &Value) -> Option<i64> {
    let value = value.as_f64()?;
    (value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER as f64)
        .then_some(value as i64)
}
/// Default only when absent. A present null is left to the field decoder.
pub fn field_or_default<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    default: &'a Value,
) -> &'a Value {
    object.get(key).unwrap_or(default)
}
pub fn encode_option(value: Option<Value>) -> Value {
    match value {
        Some(value) => json!({"_tag":"Some", "value":value}),
        None => json!({"_tag":"None"}),
    }
}
pub fn decode_option(value: &Value) -> Option<Option<&Value>> {
    let object = value.as_object()?;
    match object.get("_tag")?.as_str()? {
        "None" => Some(None),
        "Some" => Some(Some(object.get("value")?)),
        _ => None,
    }
}
pub fn encode_number(number: f64) -> Value {
    if number.is_nan() {
        json!("NaN")
    } else if number == f64::INFINITY {
        json!("Infinity")
    } else if number == f64::NEG_INFINITY {
        json!("-Infinity")
    } else {
        json!(number)
    }
}
pub fn decode_number(value: &Value) -> Option<f64> {
    match value {
        Value::String(s) if s == "NaN" => Some(f64::NAN),
        Value::String(s) if s == "Infinity" => Some(f64::INFINITY),
        Value::String(s) if s == "-Infinity" => Some(f64::NEG_INFINITY),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trim_uses_ecmascript_whitespace() {
        assert_eq!(
            trimmed_nonempty(&json!("\u{feff} hello \u{a0}")),
            Some("hello".into())
        );
        assert_eq!(trimmed_nonempty(&json!("\u{feff}")), None);
        assert_eq!(trimmed_nonempty(&json!("\u{85}")), Some("\u{85}".into()));
    }
    #[test]
    fn option_defaults_and_numbers_preserve_wire_semantics() {
        let none = encode_option(None);
        assert_eq!(decode_option(&none), Some(None));
        let some = encode_option(Some(Value::Null));
        assert_eq!(decode_option(&some), Some(Some(&Value::Null)));
        assert_eq!(decode_option(&json!({"_tag":"Some"})), None);
        let default = json!(12);
        let object = json!({"present":null}).as_object().unwrap().clone();
        assert_eq!(field_or_default(&object, "present", &default), &Value::Null);
        assert_eq!(field_or_default(&object, "absent", &default), &default);
        assert_eq!(
            safe_integer(&json!(9_007_199_254_740_991_i64)),
            Some(MAX_SAFE_INTEGER)
        );
        assert_eq!(safe_integer(&json!(9_007_199_254_740_992_i64)), None);
        assert_eq!(encode_number(f64::INFINITY), json!("Infinity"));
        assert!(decode_number(&json!("NaN")).unwrap().is_nan());
    }
}
