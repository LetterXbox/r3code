//! Diagnostics for malformed stored guide fields, following the wire schema.
use serde_json::{json, Value};

fn error(path: &str, depth: usize, message: &str, issue: &str) -> Value {
    let mut nested = issue.to_owned();
    for _ in 0..depth { nested = format!("Composite(Pointer({nested}))"); }
    json!({"_tag":"PullRequestOperationError","operation":"reviewGuide","detail":"Could not read the stored review guide.","cause":{"name":"PersistenceDecodeError","message":format!("Decode error in PullRequestReviewGuide: {nested}"),"cause":{"name":"SchemaError","message":format!("{message}\n  at {path}")}}})
}
fn check(value: Option<&Value>, path: &str, depth: usize, kind: &str) -> Option<Value> {
    let Some(v) = value else { return Some(error(path,depth,"Missing key","MissingKey")) };
    let (message, issue) = match kind {
        "object" if !v.is_object() => ("Expected object","InvalidType"),
        "array" if !v.is_array() => ("Expected array","InvalidType"),
        "string" if !v.is_string() => ("Expected string","InvalidType"),
        "nonempty" if !v.is_string() => ("Expected string","Encoding(InvalidType)"),
        "nonempty" if v.as_str().is_some_and(|s| s.trim().is_empty()) => ("Expected a non-blank string","Composite(Filter(InvalidValue))"),
        "positive" if !v.is_number() => ("Expected number","InvalidType"),
        "positive" if v.as_i64().is_none() && v.as_u64().is_none() => ("Expected an integer","Composite(Filter(InvalidValue))"),
        "positive" if v.as_i64().is_some_and(|n| n < 1) || v.as_u64() == Some(0) => ("Expected a value greater than or equal to 1","Composite(Filter(InvalidValue))"),
        "side" if !matches!(v.as_str(), Some("new" | "old")) => ("Expected \"new\" | \"old\"","AnyOf()"),
        _ => return None,
    }; Some(error(path,depth,message,issue))
}
fn key(path: &str, key: &str) -> String { format!("{path}[{}]",json!(key)) }
fn field(value: &Value, path: &str, depth: usize, name: &str, kind: &str) -> Option<Value> { check(value.get(name), &key(path,name), depth, kind) }

pub(crate) fn diagnose(guide: &Value) -> Option<Value> {
    let root="[\"guide\"]";
    if let Some(e)=check(Some(guide),root,1,"object") { return Some(e); }
    for (name,kind) in [("headSha","nonempty"),("generatedAt","string")] { if let Some(e)=field(guide,root,2,name,kind) { return Some(e); } }
    let selection=guide.get("modelSelection"); let selection_path=key(root,"modelSelection");
    if selection.is_none() { return Some(error(&selection_path,2,"Missing key","MissingKey")); }
    let selection=selection.unwrap();
    if !selection.is_object() { return Some(error(&selection_path,2,"Expected object","Encoding(InvalidType)")); }
    if let Some(e)=field(selection,&selection_path,3,"model","nonempty") { return Some(e); }
    let instance = selection.get("instanceId").or_else(|| selection.get("provider"));
    if instance.is_none_or(|v| !v.is_string()) { return Some(error(&key(&selection_path,"instanceId"),3,"Expected string","Encoding(InvalidType)")); }
    if instance.and_then(Value::as_str).is_some_and(|s| s.trim().is_empty()) { return Some(error(&key(&selection_path,"instanceId"),3,"Expected a non-blank string","Composite(Filter(InvalidValue))")); }
    let instance = instance.and_then(Value::as_str).unwrap_or("").trim();
    if instance.encode_utf16().count() > 64 { return Some(error(&key(&selection_path,"instanceId"),3,"Expected a value with a length of at most 64","Composite(Filter(InvalidValue))")); }
    if !instance.bytes().enumerate().all(|(i,b)| b.is_ascii_alphabetic() || (i > 0 && (b.is_ascii_digit() || b == b'_' || b == b'-'))) { return Some(error(&key(&selection_path,"instanceId"),3,"Expected a string matching the RegExp ^[a-zA-Z][a-zA-Z0-9_-]*$","Composite(Filter(InvalidValue))")); }
    if selection.get("options").is_some_and(|v| !v.is_object() && !v.is_array()) { return Some(error(&key(&selection_path,"options"),3,"Expected array | object","AnyOf()")); }
    if let Some(options) = selection["options"].as_array() {
        let options_path = key(&selection_path,"options");
        for (i,item) in options.iter().enumerate() {
            let item_path = format!("{options_path}[{i}]");
            if !item.is_object() { return Some(error(&item_path,3,"Expected object","AnyOf(Composite(Pointer(InvalidType)))")); }
            for name in ["id","value"] {
                let path=key(&item_path,name); let value=item.get(name);
                if value.is_none() { return Some(error(&path,3,"Missing key","AnyOf(Composite(Pointer(Composite(Pointer(MissingKey)))))")); }
                let value=value.unwrap();
                if name == "id" && !value.is_string() { return Some(error(&path,3,"Expected string","AnyOf(Composite(Pointer(Composite(Pointer(Encoding(InvalidType))))))")); }
                if name == "value" && !(value.is_string() || value.is_boolean()) { return Some(error(&path,3,"Expected string | boolean","AnyOf(Composite(Pointer(Composite(Pointer(AnyOf())))))")); }
                if value.as_str().is_some_and(|s| s.trim().is_empty()) { return Some(error(&path,3,"Expected a non-blank string",if name == "id" {"AnyOf(Composite(Pointer(Composite(Pointer(Composite(Filter(InvalidValue)))))))"} else {"AnyOf(Composite(Pointer(Composite(Pointer(AnyOf(Composite(Filter(InvalidValue))))))))"})); }
            }
        }
    }
    if let Some(e)=field(guide,root,2,"stops","array") { return Some(e); }
    for (i,stop) in guide["stops"].as_array().unwrap().iter().enumerate() {
        let path=format!("{}[{i}]",key(root,"stops"));
        if let Some(e)=check(Some(stop),&path,3,"object") { return Some(e); }
        for (name,kind) in [("title","nonempty"),("summary","string")] { if let Some(e)=field(stop,&path,4,name,kind) { return Some(e); } }
        let attention_path=key(&path,"attention");
        let Some(attention)=stop.get("attention") else { return Some(error(&attention_path,4,"Missing key","MissingKey")); };
        if !attention.is_null() {
            if !attention.is_object() { return Some(error(&attention_path,4,"Expected object | null","AnyOf()")); }
            let kind=attention.get("kind");
            if kind.is_none() { return Some(error(&key(&attention_path,"kind"),4,"Missing key","AnyOf(Composite(Pointer(MissingKey)))")); }
            if !matches!(kind.and_then(Value::as_str),Some("tradeoff"|"contract"|"product"|"risk"|"accessibility")) { return Some(error(&key(&attention_path,"kind"),4,"Expected \"tradeoff\" | \"contract\" | \"product\" | \"risk\" | \"accessibility\"","AnyOf(Composite(Pointer(AnyOf())))")); }
            let note=attention.get("note");
            if note.is_none() { return Some(error(&key(&attention_path,"note"),4,"Missing key","AnyOf(Composite(Pointer(MissingKey)))")); }
            if note.is_some_and(|v| !v.is_string()) { return Some(error(&key(&attention_path,"note"),4,"Expected string","AnyOf(Composite(Pointer(Encoding(InvalidType))))")); }
            if note.and_then(Value::as_str).is_some_and(|s| s.trim().is_empty()) { return Some(error(&key(&attention_path,"note"),4,"Expected a non-blank string","AnyOf(Composite(Pointer(Composite(Filter(InvalidValue)))))")); }
        }
        for name in ["excerpts","files","notes","questions"] {
            let array_path=key(&path,name);
            if let Some(e)=check(stop.get(name),&array_path,4,"array") { return Some(e); }
            for (j,item) in stop[name].as_array().unwrap().iter().enumerate() {
                let item_path=format!("{array_path}[{j}]");
                if name=="questions" { if let Some(e)=check(Some(item),&item_path,5,"nonempty") {return Some(e)}; continue; }
                if let Some(e)=check(Some(item),&item_path,5,"object") {return Some(e)}
                let fields: &[(&str,&str)] = match name { "excerpts"=>&[("path","nonempty"),("side","side"),("start","positive"),("end","positive"),("caption","string")], "files"=>&[("path","nonempty")], _=>&[("path","nonempty"),("line","positive"),("title","nonempty"),("body","string")] };
                for (field_name,kind) in fields { if let Some(e)=field(item,&item_path,6,field_name,kind) {return Some(e)} }
                if name=="files" && item.get("note").is_some() { if let Some(e)=field(item,&item_path,6,"note","string") {return Some(e)} }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_errors_match_original_schema_diagnostics() {
        let valid = json!({"headSha":"abc","generatedAt":"x","modelSelection":{"instanceId":"codex","model":"m"},"stops":[]});
        let mut cases = Vec::new();
        cases.push((json!(null), "Expected object\n  at [\"guide\"]", "Composite(Pointer(InvalidType))"));
        cases.push((json!({}), "Missing key\n  at [\"guide\"][\"headSha\"]", "Composite(Pointer(Composite(Pointer(MissingKey))))"));
        let mut bad=valid.clone(); bad["headSha"]=json!(""); cases.push((bad,"Expected a non-blank string\n  at [\"guide\"][\"headSha\"]","Composite(Pointer(Composite(Pointer(Composite(Filter(InvalidValue))))))"));
        let mut bad=valid.clone(); bad["stops"]=json!([{}]); cases.push((bad,"Missing key\n  at [\"guide\"][\"stops\"][0][\"title\"]","Composite(Pointer(Composite(Pointer(Composite(Pointer(Composite(Pointer(MissingKey))))))))"));
        let mut bad=valid.clone(); bad["modelSelection"]["options"]=json!(42); cases.push((bad,"Expected array | object\n  at [\"guide\"][\"modelSelection\"][\"options\"]","Composite(Pointer(Composite(Pointer(Composite(Pointer(AnyOf()))))))"));
        let mut bad=valid.clone(); bad["modelSelection"]["instanceId"]=json!("bad.id"); cases.push((bad,"Expected a string matching the RegExp ^[a-zA-Z][a-zA-Z0-9_-]*$\n  at [\"guide\"][\"modelSelection\"][\"instanceId\"]","Composite(Pointer(Composite(Pointer(Composite(Pointer(Composite(Filter(InvalidValue))))))))"));
        let mut bad=valid.clone(); bad["modelSelection"]["options"]=json!([{"id":"abc","value":3}]); cases.push((bad,"Expected string | boolean\n  at [\"guide\"][\"modelSelection\"][\"options\"][0][\"value\"]","Composite(Pointer(Composite(Pointer(Composite(Pointer(AnyOf(Composite(Pointer(Composite(Pointer(AnyOf())))))))))))"));
        assert!(diagnose(&valid).is_none());
        for (value,message,issue) in cases { let e=diagnose(&value).unwrap(); assert_eq!(e["cause"]["cause"]["message"],message); assert_eq!(e["cause"]["message"],format!("Decode error in PullRequestReviewGuide: {issue}")); }
    }
}
