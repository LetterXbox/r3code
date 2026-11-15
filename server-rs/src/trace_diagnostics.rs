//! Summarize local, rotated OpenTelemetry trace files for the diagnostics RPC.
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.trim().is_empty())
}
fn timestamp(value: &Value) -> Option<DateTime<Utc>> {
    let nanos = text(value)?.parse::<i128>().ok()?;
    let millis = i64::try_from(nanos / 1_000_000).ok()?;
    Utc.timestamp_millis_opt(millis).single()
}
fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn option(value: Option<Value>) -> Value {
    crate::codec::encode_option(value)
}
#[derive(Default)]
struct Span {
    name: String,
    count: u64,
    failures: u64,
    total: f64,
    max: f64,
}
#[derive(Default)]
struct Failure {
    name: String,
    cause: String,
    count: u64,
    last: i64,
    trace: String,
    span: String,
}
#[derive(Default)]
struct Accumulator {
    records: u64,
    parse_errors: u64,
    failures: u64,
    interruptions: u64,
    slow: u64,
    first: Option<DateTime<Utc>>,
    last: Option<DateTime<Utc>>,
    spans: Vec<Span>,
    common: Vec<Failure>,
    slowest: Vec<(f64, Value)>,
    latest_failures: Vec<(i64, Value)>,
    logs: Vec<(i64, Value)>,
    levels: BTreeMap<String, u64>,
}
fn bounded<T>(items: &mut Vec<(T, Value)>, item: (T, Value), limit: usize)
where
    T: PartialOrd,
{
    items.push(item);
    items.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    items.truncate(limit);
}
impl Accumulator {
    fn line(&mut self, bytes: &[u8], threshold: f64) {
        let line = String::from_utf8_lossy(bytes);
        if line.trim().is_empty() {
            return;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            self.parse_errors += 1;
            return;
        };
        let Some(object) = record.as_object() else {
            self.parse_errors += 1;
            return;
        };
        let Some(name) = object.get("name").and_then(text) else {
            self.parse_errors += 1;
            return;
        };
        let Some(trace) = object.get("traceId").and_then(text) else {
            self.parse_errors += 1;
            return;
        };
        let Some(span) = object.get("spanId").and_then(text) else {
            self.parse_errors += 1;
            return;
        };
        let Some(duration) = object
            .get("durationMs")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        else {
            self.parse_errors += 1;
            return;
        };
        let Some(ended) = object.get("endTimeUnixNano").and_then(timestamp) else {
            self.parse_errors += 1;
            return;
        };
        let started = object.get("startTimeUnixNano").and_then(timestamp);
        self.records += 1;
        if let Some(started) = started {
            self.first = Some(self.first.map_or(started, |v| v.min(started)));
        }
        self.last = Some(self.last.map_or(ended, |v| v.max(ended)));
        let exit = &record["exit"]["_tag"];
        let failed = exit == "Failure" || record["status"]["code"] == "2";
        let interrupted = exit == "Interrupted"
            || record["attributes"]["effect.fiber.interrupted"] == true
            || record["status"]["message"] == "Interrupted";
        self.failures += u64::from(failed);
        self.interruptions += u64::from(interrupted);
        self.slow += u64::from(duration >= threshold);
        let index = self
            .spans
            .iter()
            .position(|v| v.name == name)
            .unwrap_or_else(|| {
                self.spans.push(Span {
                    name: name.into(),
                    ..Default::default()
                });
                self.spans.len() - 1
            });
        let summary = &mut self.spans[index];
        summary.count += 1;
        summary.failures += u64::from(failed);
        summary.total += duration;
        summary.max = summary.max.max(duration);
        let item = json!({"name":name,"durationMs":duration,"endedAt":iso(ended),"traceId":trace,"spanId":span});
        bounded(&mut self.slowest, (duration, item.clone()), 10);
        if failed {
            let cause = if exit == "Failure" {
                text(&record["exit"]["cause"])
            } else {
                text(&record["status"]["message"])
            }
            .map(str::trim)
            .unwrap_or("Failure");
            let mut failure = item;
            failure["cause"] = json!(cause);
            bounded(
                &mut self.latest_failures,
                (ended.timestamp_millis(), failure),
                20,
            );
            let index = self
                .common
                .iter()
                .position(|v| v.name == name && v.cause == cause)
                .unwrap_or_else(|| {
                    self.common.push(Failure {
                        name: name.into(),
                        cause: cause.into(),
                        last: i64::MIN,
                        ..Default::default()
                    });
                    self.common.len() - 1
                });
            let entry = &mut self.common[index];
            entry.count += 1;
            if ended.timestamp_millis() > entry.last {
                entry.last = ended.timestamp_millis();
                entry.trace = trace.into();
                entry.span = span.into();
            }
        }
        if let Some(events) = record["events"].as_array() {
            for event in events {
                let Some(level) = text(&event["attributes"]["effect.logLevel"]) else {
                    continue;
                };
                *self.levels.entry(level.into()).or_default() += 1;
                if !matches!(
                    level.to_ascii_lowercase().as_str(),
                    "warning" | "warn" | "error" | "fatal"
                ) {
                    continue;
                }
                let seen = timestamp(&event["timeUnixNano"]).unwrap_or(ended);
                let message = text(&event["name"]).map(str::trim).unwrap_or("Log event");
                bounded(
                    &mut self.logs,
                    (
                        seen.timestamp_millis(),
                        json!({"spanName":name,"level":level,"message":message,"seenAt":iso(seen),"traceId":trace,"spanId":span}),
                    ),
                    20,
                );
            }
        }
    }
    fn finish(
        mut self,
        path: &Path,
        paths: &[PathBuf],
        read_at: DateTime<Utc>,
        found: bool,
        error: Option<PathBuf>,
    ) -> Value {
        self.spans
            .sort_by(|a, b| b.count.cmp(&a.count).then_with(|| b.max.total_cmp(&a.max)));
        self.common
            .sort_by(|a, b| b.count.cmp(&a.count).then_with(|| b.last.cmp(&a.last)));
        let top: Vec<Value> = self.spans.into_iter().take(10).map(|s| json!({"name":s.name,"count":s.count,"failureCount":s.failures,"totalDurationMs":s.total,"averageDurationMs":s.total / s.count as f64,"maxDurationMs":s.max})).collect();
        let common: Vec<Value> = self.common.into_iter().take(10).filter_map(|f| Utc.timestamp_millis_opt(f.last).single().map(|date|json!({"name":f.name,"cause":f.cause,"count":f.count,"lastSeenAt":iso(date),"traceId":f.trace,"spanId":f.span}))).collect();
        let err = error.as_ref().map(|p| json!({"kind":"trace-file-read-failed","message":format!("Failed to read local trace file '{}'.",p.display())})).or_else(|| (!found).then(||json!({"kind":"trace-file-not-found","message":"No local trace files were found."})));
        json!({"traceFilePath":path.to_string_lossy(),"scannedFilePaths":paths.iter().map(|p|p.to_string_lossy().into_owned()).collect::<Vec<_>>(),"readAt":iso(read_at),"recordCount":self.records,"parseErrorCount":self.parse_errors,"firstSpanAt":option(self.first.map(|v|json!(iso(v)))),"lastSpanAt":option(self.last.map(|v|json!(iso(v)))),"failureCount":self.failures,"interruptionCount":self.interruptions,"slowSpanThresholdMs":1000,"slowSpanCount":self.slow,"logLevelCounts":self.levels,"topSpansByCount":top,"slowestSpans":self.slowest.into_iter().map(|v|v.1).collect::<Vec<_>>(),"commonFailures":common,"latestFailures":self.latest_failures.into_iter().map(|v|v.1).collect::<Vec<_>>(),"latestWarningAndErrorLogs":self.logs.into_iter().map(|v|v.1).collect::<Vec<_>>(),"partialFailure":option((found && error.is_some()).then_some(json!(true))),"error":option(err)})
    }
}
/// Read backups oldest first; missing files are normal, other failures are reported.
pub fn read(path: &Path, backups: usize) -> Value {
    let mut paths: Vec<PathBuf> = (1..=backups)
        .rev()
        .map(|n| {
            let mut p = path.as_os_str().to_os_string();
            p.push(format!(".{n}"));
            PathBuf::from(p)
        })
        .collect();
    paths.push(path.to_owned());
    let mut acc = Accumulator::default();
    let mut found = false;
    let mut error = None;
    for p in &paths {
        match std::fs::File::open(p) {
            Ok(file) => {
                let mut reader = BufReader::new(file);
                let mut line = Vec::new();
                loop {
                    line.clear();
                    match reader.read_until(b'\n', &mut line) {
                        Ok(0) => {
                            found = true;
                            break;
                        }
                        Ok(_) => acc.line(&line, 1000.0),
                        Err(_) => {
                            if error.is_none() {
                                error = Some(p.clone());
                            }
                            break;
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                if error.is_none() {
                    error = Some(p.clone());
                }
            }
        }
    }
    if !found {
        acc = Accumulator::default();
    }
    acc.finish(path, &paths, Utc::now(), found, error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aggregates_rotated_spans_failures_and_logs() {
        let root = std::env::temp_dir().join(format!("trace-diagnostics-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("trace.ndjson");
        let backup = root.join("trace.ndjson.1");
        let record = json!({"name":"run","traceId":"trace","spanId":"span","startTimeUnixNano":"1000000000","endTimeUnixNano":"2500000000","durationMs":1500,"exit":{"_tag":"Failure","cause":"bad"},"events":[{"name":"warning","attributes":{"effect.logLevel":"Warning"}}]});
        std::fs::write(&backup, format!("{}\ninvalid\n", record)).unwrap();
        std::fs::write(&path, "\n").unwrap();
        let result = read(&path, 1);
        assert_eq!(result["recordCount"], 1);
        assert_eq!(result["parseErrorCount"], 1);
        assert_eq!(result["failureCount"], 1);
        assert_eq!(result["slowSpanCount"], 1);
        assert_eq!(result["commonFailures"][0]["cause"], "bad");
        assert_eq!(result["latestWarningAndErrorLogs"][0]["message"], "warning");
        assert_eq!(result["error"]["_tag"], "None");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn reports_missing_files() {
        let path = std::env::temp_dir().join(format!("missing-trace-{}", uuid::Uuid::new_v4()));
        let result = read(&path, 2);
        assert_eq!(result["scannedFilePaths"].as_array().unwrap().len(), 3);
        assert_eq!(result["error"]["value"]["kind"], "trace-file-not-found");
        assert_eq!(result["partialFailure"]["_tag"], "None");
    }

    #[test]
    fn ranks_summaries_and_keeps_the_most_recent_failure_details() {
        let root = std::env::temp_dir().join(format!("trace-ranking-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("trace.ndjson");
        let record = |name: &str, trace: &str, end: &str, duration: f64| {
            json!({
                "name": name,
                "traceId": trace,
                "spanId": format!("{trace}-span"),
                "startTimeUnixNano": "1000000000",
                "endTimeUnixNano": end,
                "durationMs": duration,
                "exit": {"_tag": "Failure", "cause": "same cause"}
            })
        };
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                record("frequent", "old", "2000000000", 12.0),
                record("frequent", "new", "3000000000", 20.0),
                record("rare", "rare", "4000000000", 30.0)
            ),
        )
        .unwrap();

        let result = read(&path, 0);
        assert_eq!(result["topSpansByCount"][0]["name"], "frequent");
        assert_eq!(result["topSpansByCount"][0]["count"], 2);
        assert_eq!(result["topSpansByCount"][0]["averageDurationMs"], 16.0);
        assert_eq!(result["slowestSpans"][0]["name"], "rare");
        assert_eq!(result["latestFailures"][0]["traceId"], "rare");
        let common = result["commonFailures"].as_array().unwrap();
        assert_eq!(common[0]["name"], "frequent");
        assert_eq!(common[0]["traceId"], "new");
        assert_eq!(common[0]["count"], 2);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn reports_partial_failure_when_a_backup_can_be_read() {
        let root = std::env::temp_dir().join(format!("trace-partial-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("trace");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(root.join("trace.1"), "\n").unwrap();
        let result = read(&path, 1);
        assert_eq!(
            result["partialFailure"],
            json!({"_tag":"Some","value":true})
        );
        assert_eq!(result["error"]["value"]["kind"], "trace-file-read-failed");
        std::fs::remove_dir_all(root).unwrap();
    }
}
