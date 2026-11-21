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
    _settings: Option<&Value>,
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

pub(crate) const MANIFEST_T3_CODE_VERSION: &str = "0.1.11";

fn parse_semver_parts(raw: &str) -> Option<(u64, u64, u64, usize)> {
    let trimmed = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
    if trimmed.is_empty() || trimmed.contains(['-', '+']) {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.is_empty() || parts.len() > 3 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let major = parts[0].parse().ok()?;
    let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some((major, minor, patch, parts.len()))
}

pub(crate) fn satisfies_semver_range(version: &str, range: &str) -> bool {
    let Some((vmaj, vmin, vpat, vlen)) = parse_semver_parts(version) else {
        return false;
    };
    if vlen != 3 {
        return false;
    }
    let v = (vmaj, vmin, vpat);
    range.split("||").any(|clause| {
        let tokens: Vec<&str> = clause.split_whitespace().collect();
        !tokens.is_empty()
            && tokens.into_iter().all(|token| {
                let (op, rest) = if let Some(r) = token.strip_prefix(">=") {
                    (">=", r)
                } else if let Some(r) = token.strip_prefix("<=") {
                    ("<=", r)
                } else if let Some(r) = token.strip_prefix('>') {
                    (">", r)
                } else if let Some(r) = token.strip_prefix('<') {
                    ("<", r)
                } else if let Some(r) = token.strip_prefix('=') {
                    ("=", r)
                } else if let Some(r) = token.strip_prefix('^') {
                    ("^", r)
                } else {
                    ("=", token)
                };
                let Some((maj, min, pat, _)) = parse_semver_parts(rest) else {
                    return false;
                };
                let target = (maj, min, pat);
                match op {
                    ">=" => v >= target,
                    "<=" => v <= target,
                    ">" => v > target,
                    "<" => v < target,
                    "=" => v == target,
                    "^" => {
                        let upper = if maj > 0 {
                            (maj + 1, 0, 0)
                        } else if min > 0 {
                            (0, min + 1, 0)
                        } else {
                            (0, 0, pat + 1)
                        };
                        v >= target && v < upper
                    }
                    _ => false,
                }
            })
    })
}

fn load_compatibility_policies(state_dir: Option<&Path>) -> Vec<Value> {
    if let Some(cached) = state_dir
        .map(|dir| dir.join("model-manifest.json"))
        .and_then(|path| std::fs::read(&path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|doc| doc.get("compatibility").and_then(Value::as_array).cloned())
    {
        return cached;
    }
    serde_json::from_str::<Value>(include_str!("../../data/model-manifest.json"))
        .ok()
        .and_then(|doc| doc.get("compatibility").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

pub(crate) fn check_compatibility(
    driver: &str,
    version: Option<&str>,
    state_dir: Option<&Path>,
) -> Option<Value> {
    let policies = load_compatibility_policies(state_dir);
    let policy = policies.iter().find(|entry| {
        entry["driver"].as_str() == Some(driver)
            && entry["t3CodeRange"]
                .as_str()
                .is_some_and(|r| satisfies_semver_range(MANIFEST_T3_CODE_VERSION, r))
    })?;
    let unprefixed = version.map(|v| {
        let trimmed = v.trim();
        trimmed.strip_prefix('v').unwrap_or(trimmed)
    });
    let stable = if let Some(pattern) = policy["versionPattern"].as_str() {
        regex::Regex::new(pattern).ok().and_then(|re| {
            unprefixed.and_then(|u| re.captures(u).and_then(|c| c.get(1)).map(|m| m.as_str().to_owned()))
        })
    } else {
        unprefixed.map(|u| {
            if u.contains(char::is_whitespace) {
                let last = u.split_whitespace().last().unwrap_or(u);
                last.strip_prefix('v').unwrap_or(last).to_owned()
            } else {
                u.to_owned()
            }
        })
    };
    let status = stable
        .as_deref()
        .filter(|s| parse_semver_parts(s).is_some_and(|(_, _, _, len)| len == 3))
        .and_then(|s| {
            policy["ranges"].as_array().and_then(|ranges| {
                ranges
                    .iter()
                    .find(|entry| entry["range"].as_str().is_some_and(|r| satisfies_semver_range(s, r)))
                    .and_then(|entry| entry["status"].as_str())
            })
        })
        .unwrap_or("unknown");
    let base_message = match status {
        "broken" => Some("This provider version is known to be incompatible with this T3 Code release."),
        "unsupported" => Some("This provider version is outside the supported range for this T3 Code release."),
        "graceful" => Some("This provider version has limited compatibility with this T3 Code release."),
        _ => None,
    };
    let recommended_version = policy["recommendedVersion"].as_str().map(str::to_owned);
    let recommended_range = policy["recommendedRange"].as_str().map(str::to_owned);
    let recommendation = recommended_version.as_deref().or(recommended_range.as_deref());
    let message = base_message.map(|msg| match recommendation {
        Some(rec) => format!("{msg} Use {rec}."),
        None => msg.to_owned(),
    });
    Some(json!({
        "status": status,
        "message": message,
        "recommendedVersion": recommended_version,
        "recommendedRange": recommended_range,
    }))
}

pub(crate) fn broken_runtime_detail(
    name: &str,
    version: &str,
    advisory: Option<&Value>,
    action: Option<&str>,
) -> Option<String> {
    if advisory.and_then(|v| v["status"].as_str()) != Some("broken") {
        return None;
    }
    let target = advisory
        .and_then(|v| v["recommendedVersion"].as_str().or_else(|| v["recommendedRange"].as_str()))
        .unwrap_or("a newer version");
    let action = action.map(str::to_owned).unwrap_or_else(|| format!("Update {name}"));
    Some(format!(
        "{name} {version} does not work with this T3 Code release. {action} to {target}, then retry."
    ))
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
        assert_eq!(effort.as_array().unwrap().iter().find(|v|v["id"]=="high").unwrap()["label"],"High");
        let fresh=rows.iter().find(|m|m["slug"]=="new-v1").unwrap(); assert_eq!(fresh["capabilities"]["optionDescriptors"][0]["options"][3]["label"],"Extra High");
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
    #[test]
    fn compatibility_checks_bundled_manifest_ranges() {
        let agy_old = check_compatibility("antigravity", Some("agy_acp_server_1.4.5"), None).unwrap();
        assert_eq!(agy_old["status"], "broken");
        assert_eq!(agy_old["recommendedRange"], ">=1.5.12 <2");
        assert!(broken_runtime_detail("Antigravity", "1.4.5", Some(&agy_old), Some("Update it")).unwrap().contains(">=1.5.12 <2"));

        let agy_new = check_compatibility("antigravity", Some("1.5.12"), None).unwrap();
        assert_eq!(agy_new["status"], "supported");
        assert!(broken_runtime_detail("Antigravity", "1.5.12", Some(&agy_new), None).is_none());

        assert_eq!(check_compatibility("opencode", Some("1.14.18"), None).unwrap()["status"], "broken");
        assert_eq!(check_compatibility("opencode", Some("1.14.19"), None).unwrap()["status"], "graceful");
        assert_eq!(check_compatibility("opencode", Some("2.0.18"), None).unwrap()["status"], "supported");
        assert_eq!(check_compatibility("pi", Some("0.84.2"), None).unwrap()["status"], "broken");
        assert_eq!(check_compatibility("pi", Some("0.84.3"), None).unwrap()["status"], "supported");
        assert_eq!(check_compatibility("grok", Some("1.0.12"), None).unwrap()["status"], "broken");
        assert_eq!(check_compatibility("muse", Some("1.4.2-R1"), None).unwrap()["status"], "supported");
        assert_eq!(check_compatibility("fx", Some("0.0.13"), None).unwrap()["status"], "supported");
        assert_eq!(check_compatibility("codex", Some("0.148.0"), None).unwrap()["status"], "broken");
    }
}
