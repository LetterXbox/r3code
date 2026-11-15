//! Read-only Claude stream-json capability and usage probe.
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Read, Write}, path::Path, process::{Child, Command, Stdio}, sync::mpsc, time::{Duration, Instant}};

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)] unsafe { libc::kill(-(self.0.id() as i32), libc::SIGKILL); }
        let _=self.0.kill(); let _=self.0.wait();
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ProbeError { Failed, TimedOut }

pub(super) fn probe(mut command: Command) -> Result<(Value, Option<Value>, Option<Value>), ProbeError> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child=Process(command.spawn().map_err(|_| ProbeError::Failed)?);
    let mut stdin=child.0.stdin.take().ok_or(ProbeError::Failed)?;
    let stdout=child.0.stdout.take().ok_or(ProbeError::Failed)?;
    let (tx,rx)=mpsc::sync_channel::<Value>(16);
    std::thread::spawn(move || {
        let mut reader=BufReader::new(stdout.take(4*1024*1024));
        loop {
            let mut line=String::new(); if reader.read_line(&mut line).ok().is_none_or(|n| n==0) { break; }
            if let Ok(value)=serde_json::from_str::<Value>(&line) { if tx.send(value).is_err() { break; } }
        }
    });
    let send=|stdin:&mut std::process::ChildStdin,id:&str,request:Value| writeln!(stdin,"{}",json!({"type":"control_request","request_id":id,"request":request})).is_ok();
    if !send(&mut stdin,"probe-init",json!({"subtype":"initialize"})) { return Err(ProbeError::Failed); }
    let end=Instant::now()+Duration::from_secs(25);
    let init=loop {
        let frame=rx.recv_timeout(end.saturating_duration_since(Instant::now())).map_err(|e| match e { mpsc::RecvTimeoutError::Timeout => ProbeError::TimedOut, mpsc::RecvTimeoutError::Disconnected => ProbeError::Failed })?;
        if frame["type"] == "control_response" && frame["response"]["request_id"] == "probe-init" {
            if frame["response"]["subtype"] != "success" { return Err(ProbeError::Failed); }
            break frame["response"]["response"].clone();
        }
    };
    if !init.is_object() { return Err(ProbeError::Failed); }
    let mut pending_usage=send(&mut stdin,"probe-usage",json!({"subtype":"get_usage","skip_behaviors":true}));
    let mut pending_settings=send(&mut stdin,"probe-settings",json!({"subtype":"get_settings"}));
    let end=Instant::now()+Duration::from_secs(4);
    let mut usage=None; let mut settings=None;
    while pending_usage || pending_settings {
        let Ok(frame)=rx.recv_timeout(end.saturating_duration_since(Instant::now())) else {break};
        if frame["type"] != "control_response" { continue; }
        match frame["response"]["request_id"].as_str() {
            Some("probe-usage") => {pending_usage=false; if frame["response"]["subtype"] == "success" {usage=Some(frame["response"]["response"].clone());}},
            Some("probe-settings") => {pending_settings=false; if frame["response"]["subtype"] == "success" {settings=Some(frame["response"]["response"].clone());}},
            _ => {}
        }
    }
    Ok((init,usage,settings))
}

pub(crate) fn usage(response: &Value, checked: &str) -> Value {
    use chrono::SecondsFormat;
    if response["rate_limits_available"] != true || !response["rate_limits"].is_object() {
        return json!({"checkedAt":checked,"windows":[],"unavailable":{"reason":if response["rate_limits_available"] == true {"probeFailed"} else {"unsupported"}}});
    }
    let source=&response["rate_limits"]; let mut windows=Vec::new();
    let reset=|v:&Value| v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&chrono::Utc).to_rfc3339_opts(SecondsFormat::Millis,true));
    for (id,kind,label,duration) in [("five_hour","session","Session",300),("seven_day","weekly","Weekly",10080)] {
        let w=&source[id]; if let Some(n)=w["utilization"].as_f64().filter(|v| v.is_finite()) { let mut row=json!({"id":id,"kind":kind,"label":label,"windowDurationMins":duration,"usedPercent":n.clamp(0.0,100.0)}); if let Some(t)=reset(&w["resets_at"]) {row["resetsAt"]=json!(t)} windows.push(row); }
    }
    let scope_regex=regex::Regex::new(r"[^a-z0-9]+").unwrap();
    for w in source["model_scoped"].as_array().into_iter().flatten() {
        if let (Some(name),Some(n))=(w["display_name"].as_str(),w["utilization"].as_f64().filter(|v| v.is_finite())) {
            let id=format!("seven_day_{}",scope_regex.replace_all(&name.to_lowercase(),"_")); let mut row=json!({"id":id,"kind":"weekly","label":format!("Weekly · {name}"),"windowDurationMins":10080,"usedPercent":n.clamp(0.0,100.0)}); if let Some(t)=reset(&w["resets_at"]) {row["resetsAt"]=json!(t)} windows.push(row);
        }
    }
    let spend=&source["spend"]; let used=&spend["used"]; let limit=&spend["limit"];
    let ratio=|used:f64,limit:f64| (used.is_finite() && limit.is_finite() && used>=0.0 && limit>0.0).then(|| (100.0*used/limit).clamp(0.0,100.0));
    let spend_pct=if spend["enabled"] == true && used["currency"].as_str().is_some_and(|s| !s.trim().is_empty()) && used["currency"] == limit["currency"] && used["exponent"] == limit["exponent"] { used["amount_minor"].as_f64().zip(limit["amount_minor"].as_f64()).and_then(|(u,l)|ratio(u,l)) } else {None};
    let extra=&source["extra_usage"];
    let spend_pct=spend_pct.or_else(|| if extra["is_enabled"] == true { extra["used_credits"].as_f64().zip(extra["monthly_limit"].as_f64()).and_then(|(u,l)|ratio(u,l)).or_else(||extra["utilization"].as_f64().filter(|v| v.is_finite() && *v>=0.0).map(|v|v.clamp(0.0,100.0))) } else { None });
    if let Some(n)=spend_pct { windows.push(json!({"id":"monthly_spend","kind":"monthly","label":"Monthly spend","usedPercent":n})); }
    windows.sort_by(|a,b| { let order=|v:&Value| match v["kind"].as_str(){Some("session")=>0,Some("weekly")=>1,Some("monthly")=>2,_=>3}; order(a).cmp(&order(b)).then_with(||a["id"].as_str().cmp(&b["id"].as_str())) });
    let mut result=json!({"checkedAt":checked,"windows":windows}); if extra["is_enabled"] == true && extra["monthly_limit"] == 0 { result["zeroSpendCap"]=json!(true); } result
}


pub(crate) fn refresh_model_catalog(state_dir: Option<&Path>, update_checks_enabled: bool) -> bool {
    load_catalog_with_ttl(
        state_dir,
        update_checks_enabled,
        std::time::Duration::from_secs(300),
    )
    .1
}

fn load_catalog(state_dir: Option<&Path>, update_checks_enabled: bool) -> Vec<Value> {
    load_catalog_with_ttl(
        state_dir,
        update_checks_enabled,
        std::time::Duration::from_secs(3600),
    )
    .0
}

fn load_catalog_with_ttl(
    state_dir: Option<&Path>,
    update_checks_enabled: bool,
    ttl: std::time::Duration,
) -> (Vec<Value>, bool) {
    let bundled: Vec<Value> = serde_json::from_str(include_str!("../review_guide_claude_catalog.json"))
        .expect("bundled Claude model catalog");
    let Some(state_dir) = state_dir else {
        return (bundled, false);
    };
    let cache_path = state_dir.join("model-manifest.json");
    let mut cached_models: Option<Vec<Value>> = std::fs::read(&cache_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|doc| doc.pointer("/models/claudeAgent").and_then(Value::as_array).cloned())
        .filter(|arr| !arr.is_empty());

    let stale = std::fs::metadata(&cache_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|age| age > ttl);

    let mut changed = false;
    if update_checks_enabled && stale {
        static LAST_ATTEMPT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
        let should_attempt = LAST_ATTEMPT
            .lock()
            .ok()
            .is_some_and(|mut guard| {
                let ready = guard.is_none_or(|t| t.elapsed() > std::time::Duration::from_secs(300));
                if ready {
                    *guard = Some(std::time::Instant::now());
                }
                ready
            });
        if should_attempt {
            let fetched = std::thread::spawn(|| {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok()?;
                rt.block_on(async {
                    let client = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(10))
                        .build()
                        .ok()?;
                    let resp = client
                        .get("https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json")
                        .send()
                        .await
                        .ok()?;
                    if !resp.status().is_success() {
                        return None;
                    }
                    let text = resp.text().await.ok()?;
                    let doc: Value = serde_json::from_str(&text).ok()?;
                    if doc.pointer("/models/claudeAgent").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
                        Some((text, doc))
                    } else {
                        None
                    }
                })
            })
            .join()
            .ok()
            .flatten();
            if let Some((raw, doc)) = fetched {
                let _ = std::fs::create_dir_all(state_dir);
                let tmp = state_dir.join(format!("model-manifest.{}.tmp", uuid::Uuid::new_v4()));
                if std::fs::write(&tmp, raw.as_bytes()).is_ok() {
                    let _ = std::fs::rename(&tmp, &cache_path);
                }
                if let Some(models) = doc.pointer("/models/claudeAgent").and_then(Value::as_array).cloned() {
                    if cached_models.as_ref() != Some(&models) {
                        changed = true;
                    }
                    cached_models = Some(models);
                }
            }
        }
    }

    (cached_models.unwrap_or(bundled), changed)
}

// The SDK can report models introduced after the bundled manifest. Keep its ordering,
// while avoiding duplicate catalog aliases and context-window suffixed IDs.
#[cfg(test)]
pub(super) fn discovered(init: &Value, settings: Option<&Value>, version: Option<&str>, custom: &Value) -> (Value, Value, Value) {
    discovered_with_catalog(init, settings, version, custom, None, false)
}

pub(super) fn discovered_with_catalog(
    init: &Value,
    settings: Option<&Value>,
    version: Option<&str>,
    custom: &Value,
    state_dir: Option<&Path>,
    update_checks_enabled: bool,
) -> (Value, Value, Value) {
    use std::collections::HashSet;
    let catalog = load_catalog(state_dir, update_checks_enabled);
    let trim_suffix = |v: &str| { let trimmed=v.trim(); let base=if trimmed.ends_with(']') {trimmed.rfind('[').map(|i|&trimmed[..i]).unwrap_or(trimmed)} else {trimmed}; base.trim().to_lowercase() };
    let version_num = |v: &str| -> Vec<u64> { v.split(['.', '-', '+']).take(3).map(|s| s.parse().unwrap_or(0)).collect() };
    let mut known=HashSet::new();
    for row in &catalog {
        if let Some(slug)=row["slug"].as_str() { known.insert(trim_suffix(slug)); }
        for alias in row["aliases"].as_array().into_iter().flatten().filter_map(Value::as_str) { known.insert(trim_suffix(alias)); }
    }
    for item in custom.as_array().into_iter().flatten() { if let Some(slug)=item.as_str().or_else(||item["slug"].as_str()) {known.insert(trim_suffix(slug));} }
    let mut models=Vec::new(); let mut update=Vec::new();
    for row in &catalog {
        let min=row["compatibility"]["minVersion"].as_str();
        let unsupported=version.zip(min).is_some_and(|(v,m)| version_num(v)<version_num(m));
        if unsupported {
            if row["status"] != "legacy" { update.push(json!({"slug":row["slug"],"name":row["name"],"minVersion":min})); }
            continue;
        }
        let mut descriptors=row["descriptors"].as_array().cloned().unwrap_or_default();
        if let Some(index)=descriptors.iter().position(|d| d["id"] == "effort" && d["options"].as_array().is_some_and(|v| v.iter().any(|o|o["id"]=="ultracode"))) {
            let d=&mut descriptors[index];
            let options=d["options"].as_array_mut().unwrap(); let ultracode_default=options.iter().any(|o|o["id"]=="ultracode" && o["isDefault"]==true);
            let has_xhigh=options.iter().any(|o|o["id"]=="xhigh");
            for option in options.iter_mut() { if option["id"]=="ultracode" && !has_xhigh { *option=json!({"id":"xhigh","label":"Extra High"}); if ultracode_default {option["isDefault"]=json!(true);} } else if option["id"]=="xhigh" && ultracode_default {option["isDefault"]=json!(true);} }
            options.retain(|o|o["id"]!="ultracode");
            let mut toggle=json!({"id":"ultracode","label":"Ultracode","type":"boolean"}); if ultracode_default {toggle["currentValue"]=json!(true);} descriptors.insert(index+1,toggle);
        }
        let mut model=json!({"slug":row["slug"],"name":row["name"],"isCustom":false,"capabilities":{"optionDescriptors":descriptors}});
        if row["aliases"].as_array().is_some_and(|v|!v.is_empty()) {model["aliases"]=row["aliases"].clone();}
        if row["status"]=="legacy" {model["isLegacy"]=json!(true);}
        if row["slug"]=="claude-opus-5-5" {model["isDefault"]=json!(true);}
        models.push(model);
    }
    for info in init["models"].as_array().into_iter().flatten() {
        let Some(slug)=info["value"].as_str().map(str::trim).filter(|v|!v.is_empty() && *v!="default") else {continue};
        let ids=[slug,info["resolvedModel"].as_str().unwrap_or("")].map(trim_suffix);
        if ids.iter().any(|id| !id.is_empty() && known.contains(id)) {continue;} for id in ids {if !id.is_empty(){known.insert(id);}}
        let name=info["displayName"].as_str().map(str::trim).filter(|s|!s.is_empty()).unwrap_or(slug);
        let mut descriptors=Vec::new();
        if info["supportsEffort"]==true { let mut options=vec![json!({"id":"default","label":"Default","isDefault":true})]; for effort in info["supportedEffortLevels"].as_array().into_iter().flatten().filter_map(Value::as_str) { options.push(json!({"id":effort,"label":match effort {"low"=>"Low","medium"=>"Medium","high"=>"High","xhigh"=>"Extra High","max"=>"Max",_=>effort}})); } if options.len()>1 {descriptors.push(json!({"id":"effort","label":"Reasoning","type":"select","options":options}));} }
        models.push(json!({"slug":slug,"name":name,"isCustom":false,"capabilities":{"optionDescriptors":descriptors}}));
    }
    for item in custom.as_array().into_iter().flatten() {
        let Some(slug)=item.as_str().or_else(||item["slug"].as_str()).map(str::trim).filter(|s|!s.is_empty()) else {continue};
        let name=item["name"].as_str().map(str::trim).filter(|s|!s.is_empty()).unwrap_or(slug);
        if let Some(existing)=models.iter_mut().find(|m|m["slug"]==slug) {if name!=slug {existing["name"]=json!(name);} continue;}
        models.push(json!({"slug":slug,"name":name,"isCustom":true,"capabilities":item.get("capabilities").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!({"optionDescriptors":[]}))}));
    }
    let sources:Vec<&Value>=match settings { Some(v) if v["sources"].is_array()=>v["sources"].as_array().unwrap().iter().map(|s|&s["settings"]).collect(), Some(v)=>vec![&v["effective"]],None=>vec![] };
    let rank=|v:&str| ["low","medium","high","xhigh","max"].iter().position(|x|*x==v);
    for model in &mut models {
        if model["isCustom"]==true {continue;} let slug=model["slug"].as_str().unwrap_or("").to_owned();
        let mut cap=None;
        for source in &sources {
            let mut model_cap=None;
            for (key,val) in source["modelSettings"].as_object().into_iter().flatten() {
                let key=key.trim().to_lowercase(); let family=key.strip_suffix("[1m]").unwrap_or(&key);
                let key_match=if ["opus","sonnet","haiku","fable"].contains(&family) { catalog.iter().find(|r|r["aliases"].as_array().is_some_and(|a|a.iter().any(|x|x==family))).is_some_and(|r|r["slug"]==slug) } else {catalog.iter().filter_map(|r|r["slug"].as_str()).filter(|s|key.contains(s)).max_by_key(|s|s.len())==Some(slug.as_str())};
                if key_match { if let Some(r)=val["maxEffortLevel"].as_str().and_then(rank) {model_cap=Some(model_cap.map_or(r,|old:usize|old.min(r)));} }
            }
            if let Some(r)=model_cap.or_else(||source["maxEffortLevel"].as_str().and_then(rank)).filter(|r|*r<4) {cap=Some(cap.map_or(r,|old:usize|old.min(r)));}
        }
        if let Some(cap)=cap { for descriptor in model["capabilities"]["optionDescriptors"].as_array_mut().into_iter().flatten().filter(|d|d["id"]=="effort" && d["type"]=="select") {
            let options=descriptor["options"].as_array_mut().unwrap();
            let cap_label=options.iter().filter_map(|o|o["id"].as_str().and_then(rank).filter(|r|*r<=cap).map(|r|(r,o["label"].as_str().unwrap_or("").to_owned()))).max_by_key(|(r,_)|*r);
            if let Some((actual,label))=cap_label {for option in options {let id=option["id"].as_str().unwrap_or(""); let id_rank=rank(id); let runtime_map=catalog.iter().find(|r|r["slug"]==slug).and_then(|r|r["runtime"]["effortMap"].as_object()); let sent_rank=runtime_map.and_then(|m|m.get(id)).map_or(id_rank,|v|v.as_str().and_then(rank)); let displayed=id_rank.or(sent_rank); let runs=sent_rank.or(id_rank); if displayed.is_some_and(|r|r>actual) && runs.is_some_and(|r|r>actual) {if let Some(original)=option["label"].as_str() {option["label"]=json!(format!("{original} (capped to {label})"));}}}}
        }}
    }
    let mut commands=vec![json!({"name":"compact","description":"Summarize the conversation and reduce context usage"})];
    for command in init["commands"].as_array().into_iter().flatten() {
        let Some(name)=command["name"].as_str().map(str::trim).filter(|v|!v.is_empty()) else {continue};
        let description=command["description"].as_str().map(str::trim).filter(|v|!v.is_empty()); let hint=command["argumentHint"].as_str().map(str::trim).filter(|v|!v.is_empty());
        let idx=commands.iter().position(|c|c["name"].as_str().is_some_and(|v|v.eq_ignore_ascii_case(name)));
        if let Some(idx)=idx { if commands[idx].get("description").is_none() {if let Some(v)=description {commands[idx]["description"]=json!(v);}}
        if commands[idx].get("input").is_none() {if let Some(v)=hint {commands[idx]["input"]=json!({"hint":v});}} }
        else {let mut c=json!({"name":name}); if let Some(v)=description {c["description"]=json!(v);}
        if let Some(v)=hint {c["input"]=json!({"hint":v});} commands.push(c);}
    }
    (json!(models),json!(commands),json!(update))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_catalog_reported_models_commands_and_settings_caps() {
        let init=json!({"models":[{"value":"opus[1m]","displayName":"duplicate"},{"value":"new-v1","resolvedModel":"new-real","displayName":" New model ","supportsEffort":true,"supportedEffortLevels":["low","high","xhigh"]},{"value":"new-real","displayName":"duplicate"}],"commands":[{"name":" compact ","description":"Ignored","argumentHint":"where"},{"name":" review ","description":" Inspect ","argumentHint":" target "},{"name":"REVIEW","description":"ignored"}]});
        let settings=json!({"sources":[{"settings":{"maxEffortLevel":"medium","modelSettings":{"opus":{"maxEffortLevel":"low"}}}},{"settings":{"maxEffortLevel":"high"}}]});
        let (models,commands,updates)=discovered(&init,Some(&settings),Some("2.1.301"),&json!([]));
        assert!(updates.as_array().unwrap().is_empty());
        let rows=models.as_array().unwrap(); assert_eq!(rows.iter().filter(|m|m["slug"]=="new-v1").count(),1); assert!(!rows.iter().any(|m|m["slug"]=="new-real"));
        let opus=rows.iter().find(|m|m["slug"]=="claude-opus-5-5").unwrap(); let effort=&opus["capabilities"]["optionDescriptors"][0]["options"];
        assert_eq!(effort.as_array().unwrap().iter().find(|v|v["id"]=="high").unwrap()["label"],"High (capped to Low)");
        let fresh=rows.iter().find(|m|m["slug"]=="new-v1").unwrap(); assert_eq!(fresh["capabilities"]["optionDescriptors"][0]["options"][3]["label"],"Extra High (capped to Low)");
        assert_eq!(commands,json!([{"name":"compact","description":"Summarize the conversation and reduce context usage","input":{"hint":"where"}},{"name":"review","description":"Inspect","input":{"hint":"target"}}]));
    }
    #[test]
    fn version_filters_catalog_and_retains_custom_models() {
        let (models,_,updates)=discovered(&Value::Null,None,Some("2.1.100"),&json!([{"slug":"private","name":"Private"}]));
        assert!(!models.as_array().unwrap().iter().any(|m|m["slug"]=="claude-opus-5-5"));
        assert!(models.as_array().unwrap().iter().any(|m|m["slug"]=="private" && m["isCustom"]==true));
        assert!(updates.as_array().unwrap().iter().any(|m|m["slug"]=="claude-opus-5-5"));
    }
    #[test]
    fn usage_matches_original_golden_and_unsupported_response() {
        let value=json!({"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":100,"resets_at":"2030-01-01T00:00:00Z"},"seven_day":{"utilization":42,"resets_at":null},"model_scoped":[{"display_name":"Opus 4.6","utilization":99,"resets_at":"2030-02-01T00:00:00Z"}],"extra_usage":{"is_enabled":true,"monthly_limit":200,"used_credits":50}}});
        assert_eq!(usage(&value,"2026-01-01T00:00:00.000Z"),json!({"checkedAt":"2026-01-01T00:00:00.000Z","windows":[{"id":"five_hour","kind":"session","label":"Session","windowDurationMins":300,"usedPercent":100.0,"resetsAt":"2030-01-01T00:00:00.000Z"},{"id":"seven_day","kind":"weekly","label":"Weekly","windowDurationMins":10080,"usedPercent":42.0},{"id":"seven_day_opus_4_6","kind":"weekly","label":"Weekly · Opus 4.6","windowDurationMins":10080,"usedPercent":99.0,"resetsAt":"2030-02-01T00:00:00.000Z"},{"id":"monthly_spend","kind":"monthly","label":"Monthly spend","usedPercent":25.0}]}));
        assert_eq!(usage(&json!({"rate_limits_available":false}),"now")["unavailable"]["reason"],"unsupported");
    }
}
