//! Pull request refresh notifications shared by RPC requests and subscribers.
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::watch;

type SyncRequest = (
    crate::event_bus::EventBus,
    Vec<(String, String, String)>,
    Value,
);
type StateReport = (String, String, Option<bool>, Instant);

const RETRY_CAPACITY: usize = 2048;
struct RetryQueue<T>(VecDeque<(String, Instant, T)>);
impl<T> RetryQueue<T> {
    fn new() -> Self {
        Self(VecDeque::new())
    }
    fn schedule(&mut self, key: String, at: Instant, item: T) {
        if let Some(entry) = self.0.iter_mut().find(|entry| entry.0 == key) {
            entry.2 = item;
            return;
        }
        if self.0.len() == RETRY_CAPACITY {
            self.0.pop_front();
        }
        self.0.push_back((key, at, item));
    }
    fn remove(&mut self, key: &str) {
        self.0.retain(|entry| entry.0 != key);
    }
    fn pop_due(&mut self, now: Instant) -> Option<T> {
        if self.0.front().is_some_and(|entry| entry.1 <= now) {
            return self.0.pop_front().map(|entry| entry.2);
        }
        None
    }
    fn wait(&self, now: Instant) -> Option<Duration> {
        self.0
            .front()
            .map(|entry| entry.1.saturating_duration_since(now))
    }
}

fn sync_identity(key: &Value) -> String {
    format!(
        "{}/{}/{}",
        key["host"].as_str().unwrap_or_default().to_lowercase(),
        key["repository"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase(),
        key["number"]
    )
}

pub(crate) struct Refreshes {
    epoch: Mutex<u64>,
    changes: watch::Sender<u64>,
    reports: Mutex<VecDeque<StateReport>>,
    state_changes: tokio::sync::broadcast::Sender<Value>,
    sync_worker: std::sync::OnceLock<std::sync::mpsc::SyncSender<SyncRequest>>,
}
impl Default for Refreshes {
    fn default() -> Self {
        Self {
            epoch: Mutex::new(0),
            changes: watch::channel(0).0,
            reports: Mutex::new(VecDeque::new()),
            state_changes: tokio::sync::broadcast::channel(64).0,
            sync_worker: std::sync::OnceLock::new(),
        }
    }
}
impl Refreshes {
    pub(crate) fn invalidate(&self, input: &Value) {
        if input["filesViewedOnly"] == true {
            return;
        }
        let mut epoch = self.epoch.lock().unwrap_or_else(|e| e.into_inner());
        // Global invalidation advances listing and file-revision epochs first;
        // a reference invalidation advances its own epoch first.
        *epoch += if input.get("reference").is_some() {
            2
        } else {
            3
        };
        self.changes.send_replace(*epoch);
    }
    pub(crate) fn report(
        &self,
        projects: Vec<(String, String, String)>,
        input: &Value,
    ) -> Result<Option<Value>, Value> {
        let reference = &input["reference"];
        let repo = reference["repository"].as_str().unwrap().trim();
        let host = reference.get("host").and_then(Value::as_str).map(str::trim);
        let resolved: Vec<_> = projects
            .into_iter()
            .map(|(id, _, root)| {
                let identity = crate::repository_identity::resolve(&root);
                (id, identity)
            })
            .collect();
        let selected = resolved
            .iter()
            .find(|(id, _)| id == reference["projectId"].as_str().unwrap());
        let matches = |entry: &&(String, Option<Value>)| {
            entry
                .1
                .as_ref()
                .and_then(|i| i["canonicalKey"].as_str())
                .and_then(|key| key.split_once('/'))
                .is_some_and(|(h, r)| {
                    r.eq_ignore_ascii_case(repo) && host.is_none_or(|x| x.eq_ignore_ascii_case(h))
                })
        };
        let project = selected.filter(matches).or_else(|| host.and_then(|_| resolved.iter().find(matches))).ok_or_else(|| {
            if host.is_none() && selected.is_some_and(|p| p.1.is_some()) {
                serde_json::json!({"_tag":"PullRequestOperationError","operation":"resolveRepository","detail":"The change request does not belong to the selected project."})
            } else { serde_json::json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"}) }
        })?;
        let key = project.1.as_ref().unwrap()["canonicalKey"]
            .as_str()
            .unwrap();
        let (host, repository) = key.split_once('/').unwrap();
        let number = reference["number"].as_i64().unwrap();
        let scope = format!("{}:{}:{}", project.0, key.to_lowercase(), number);
        let state = input["state"].as_str().unwrap();
        let draft = input.get("isDraft").and_then(Value::as_bool);
        let now = Instant::now();
        let mut reports = self.reports.lock().unwrap_or_else(|e| e.into_inner());
        if reports.iter().any(|(k, s, d, at)| {
            k == &scope && s == state && *d == draft && now.duration_since(*at).as_secs() < 300
        }) {
            return Ok(None);
        }
        reports.retain(|(k, _, _, _)| k != &scope);
        if reports.len() >= 2048 {
            reports.pop_front();
        }
        reports.push_back((scope, state.to_owned(), draft, now));
        let key = serde_json::json!({"host":host,"repository":repository,"number":number});
        let _ = self.state_changes.send(key.clone());
        Ok(Some(key))
    }
    pub(crate) fn queue_sync(
        &self,
        bus: crate::event_bus::EventBus,
        projects: Vec<(String, String, String)>,
        key: Value,
    ) {
        let sender = self.sync_worker.get_or_init(|| {
            let (sender, receiver) = std::sync::mpsc::sync_channel::<SyncRequest>(2048);
            std::thread::spawn(move || {
                let mut retries = RetryQueue::new();
                loop {
                    // Due retries take priority even when the incoming channel stays busy.
                    let request = if let Some(request) = retries.pop_due(Instant::now()) {
                        request
                    } else {
                        match retries.wait(Instant::now()) {
                            Some(wait) => match receiver.recv_timeout(wait) {
                                Ok(request) => request,
                                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                            },
                            None => match receiver.recv() {
                                Ok(request) => request,
                                Err(_) => break,
                            },
                        }
                    };
                    let (bus, projects, key) = request;
                    let identity = sync_identity(&key);
                    if sync_report(&bus, projects.clone(), &key) {
                        retries.remove(&identity);
                    } else {
                        retries.schedule(
                            identity,
                            Instant::now() + Duration::from_secs(60),
                            (bus, projects, key),
                        );
                    }
                }
            });
            sender
        });
        // Backpressure bounds outstanding work even if the host is slow.
        let _ = sender.send((bus, projects, key));
    }
    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }
}
pub(crate) fn valid_invalidate(input: &Value) -> bool {
    input
        .get("reference")
        .is_none_or(crate::pull_request_links::valid)
        && input.get("filesViewedOnly").is_none_or(Value::is_boolean)
}
pub(crate) fn valid_report(input: &Value) -> bool {
    input
        .get("reference")
        .is_some_and(crate::pull_request_links::valid)
        && input
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|s| matches!(s, "open" | "closed" | "merged"))
        && input.get("isDraft").is_none_or(Value::is_boolean)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn revisions_replay_and_files_viewed_does_not_notify() {
        let refreshes = Refreshes::default();
        let mut receiver = refreshes.subscribe();
        assert_eq!(*receiver.borrow_and_update(), 0);
        refreshes.invalidate(&json!({"filesViewedOnly": true}));
        assert!(!receiver.has_changed().unwrap());
        refreshes.invalidate(&json!({}));
        receiver.changed().await.unwrap();
        assert_eq!(*receiver.borrow_and_update(), 3);
        assert_eq!(*refreshes.subscribe().borrow(), 3);
        refreshes.invalidate(&json!({"reference":{"projectId":"p","repository":"a/b","number":1}}));
        receiver.changed().await.unwrap();
        assert_eq!(*receiver.borrow_and_update(), 5);
    }
    #[test]
    fn retry_queue_deduplicates_and_prioritizes_due_work_with_a_cap() {
        let now = Instant::now();
        let mut queue = RetryQueue::new();
        queue.schedule("same".into(), now, 1);
        queue.schedule("same".into(), now + Duration::from_secs(60), 2);
        assert_eq!(queue.pop_due(now), Some(2));
        for i in 0..=RETRY_CAPACITY {
            queue.schedule(i.to_string(), now, i);
        }
        assert_eq!(queue.0.len(), RETRY_CAPACITY);
        assert_eq!(queue.pop_due(now), Some(1));
        queue.remove("2");
        assert_eq!(queue.pop_due(now), Some(3));
    }
    #[test]
    fn validates_inputs() {
        assert!(valid_invalidate(&json!({})));
        assert!(!valid_invalidate(&json!({"filesViewedOnly": null})));
        assert!(valid_report(
            &json!({"reference":{"projectId":"p","repository":"a/b","number":1},"state":"open"})
        ));
        assert!(!valid_report(&json!({"reference":{},"state":"bad"})));
    }
}

/// Refresh linked snapshots using the checkout and credentials of each thread's project.
/// A state report is only a hint: never persist the unverified state supplied by a client.
fn sync_report(
    bus: &crate::event_bus::EventBus,
    projects: Vec<(String, String, String)>,
    key: &Value,
) -> bool {
    let mut pending = VecDeque::from([key.clone()]);
    let mut visits = std::collections::HashMap::new();
    let mut success = true;
    while let Some(key) = pending.pop_front() {
        let identity = format!(
            "{}/{}/{}",
            key["host"].as_str().unwrap_or_default().to_lowercase(),
            key["repository"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase(),
            key["number"]
        );
        let count = visits.entry(identity).or_insert(0);
        if *count >= 2 {
            continue;
        }
        *count += 1;
        let result = sync_report_with(
            bus,
            &key,
            |input| match crate::pull_request_summary::read(projects.clone(), input) {
                Ok(summary) => Some(summary),
                Err(error) if error["reason"] == "not-found" => Some(Value::Null),
                Err(_) => None,
            },
            |input| match crate::pull_request_stack::read(projects.clone(), input) {
                Ok(stack) => Some(stack),
                Err(error)
                    if error["reason"] == "provider-unsupported"
                        && projects
                            .iter()
                            .find(|(id, _, _)| Some(id.as_str()) == input["projectId"].as_str())
                            .and_then(|(_, _, root)| crate::repository_identity::resolve(root))
                            .is_some_and(|identity| identity["provider"] == "gitlab") =>
                {
                    Some(Value::Null)
                }
                Err(_) => None,
            },
        );
        success &= !result.failed;
        pending.extend(result.discovered);
    }
    success
}

#[derive(Default)]
struct SyncResult {
    discovered: Vec<Value>,
    failed: bool,
}

fn sync_report_with(
    bus: &crate::event_bus::EventBus,
    key: &Value,
    mut read: impl FnMut(&Value) -> Option<Value>,
    mut read_stack: impl FnMut(&Value) -> Option<Value>,
) -> SyncResult {
    use crate::migration_050::normalize_key;
    let target = normalize_key(
        key["host"].as_str().unwrap(),
        key["repository"].as_str().unwrap(),
        key["number"].as_i64().unwrap(),
    );
    let rows = bus.with_autocommit(|db| -> rusqlite::Result<Vec<(String, String)>> {
        let mut stmt = db.prepare("SELECT thread_id, project_id, payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_type(payload_json,'$.pullRequests')='array'")?;
        let mut result = Vec::new();
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?)))?;
        for row in rows {
            let (thread, project, raw) = row?;
            let Ok(value) = serde_json::from_str::<Value>(&raw) else { continue };
            if value["pullRequests"].as_array().is_some_and(|links| links.iter().any(|link| link_matches(link, &target))) { result.push((thread, project)); }
        }
        Ok(result)
    });
    let Ok(Ok(rows)) = rows else {
        return SyncResult {
            failed: true,
            ..Default::default()
        };
    };
    let mut result = SyncResult::default();
    let mut summaries = std::collections::HashMap::new();
    let mut stacks = std::collections::HashMap::new();
    for (thread_id, project_id) in rows {
        let summary = summaries.entry(project_id.clone()).or_insert_with(|| {
            let input = serde_json::json!({"projectId":project_id,"host":key["host"],"repository":key["repository"],"number":key["number"],"allowStale":false});
            read(&input)
        });
        let Some(summary) = summary else {
            result.failed = true;
            continue;
        };
        if summary.is_null() {
            continue;
        }
        let stack = stacks.entry(project_id.clone()).or_insert_with(|| {
            let input = serde_json::json!({"projectId":project_id,"host":key["host"],"repository":key["repository"],"number":key["number"],"includeDetails":false});
            read_stack(&input).map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.insert("kind".into(), Value::String("native".into()));
                    if let Some(layers) = object.get_mut("layers").and_then(Value::as_array_mut) {
                        for layer in layers { if let Some(fields) = layer.as_object_mut() { fields.remove("title"); fields.remove("isDraft"); fields.remove("headSha"); } }
                    }
                }
                value
            })
        });
        let Some(stack) = stack else {
            result.failed = true;
            continue;
        };
        // A changed layer list also makes already-linked members of the same stack stale.
        if let Some(layers) = stack["layers"].as_array() {
            let numbers: Vec<_> = layers.iter().map(|layer| layer["number"].clone()).collect();
            let siblings = bus.with_autocommit(|db| -> rusqlite::Result<Vec<Value>> {
                let mut stmt = db.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE project_id=?1 AND deleted_at IS NULL")?;
                let rows = stmt.query_map([&project_id], |r| r.get::<_, String>(0))?;
                let mut siblings = Vec::new();
                for raw in rows {
                    let Ok(thread) = serde_json::from_str::<Value>(&raw?) else { continue };
                    for link in thread["pullRequests"].as_array().into_iter().flatten() {
                        if link["source"] == "stack-dismissed" || link["stack"].is_null() || link["stack"]["id"] != stack["id"] { continue; }
                        if !link["host"].as_str().is_some_and(|h| h.eq_ignore_ascii_case(key["host"].as_str().unwrap_or_default())) || !link["repository"].as_str().is_some_and(|r| r.eq_ignore_ascii_case(key["repository"].as_str().unwrap_or_default())) { continue; }
                        let old: Vec<_> = link["stack"]["layers"].as_array().into_iter().flatten().map(|layer| layer["number"].clone()).collect();
                        if old != numbers && link["number"] != key["number"] {
                            siblings.push(serde_json::json!({"host":key["host"],"repository":key["repository"],"number":link["number"]}));
                        }
                    }
                }
                Ok(siblings)
            });
            match siblings {
                Ok(Ok(siblings)) => result.discovered.extend(siblings),
                _ => result.failed = true,
            }
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut snapshot = serde_json::json!({"state":summary["state"],"title":summary["title"],"headBranch":summary["headBranch"],"baseBranch":summary["baseBranch"],"isDraft":summary["isDraft"].as_bool().unwrap_or(false),"updatedAt":summary["updatedAt"],"closedAt":summary["closedAt"],"mergedAt":summary["mergedAt"],"syncedAt":now});
        for field in [
            "author",
            "additions",
            "deletions",
            "changedFiles",
            "reviewDecision",
            "checksState",
            "mergeability",
        ] {
            if let Some(value) = summary.get(field) {
                snapshot[field] = value.clone();
            }
        }
        let outcome = bus.commit(|tx| {
            use rusqlite::OptionalExtension;
            let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [&thread_id], |r| r.get(0)).optional()?;
            let Some(raw) = raw else { return Ok((Vec::new(), vec![])) };
            let mut thread: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let active = thread["archivedAt"].is_null() && thread["settledAt"].is_null() && thread["settledOverride"] != "settled" && thread["lineage"]["relationshipToParent"] != "subagent";
            let Some(links) = thread["pullRequests"].as_array_mut() else { return Ok((Vec::new(), vec![])) };
            let Some(index) = links.iter().position(|link| link_matches(link, &target)) else { return Ok((Vec::new(), vec![])) };
            let original = links[index].clone();
            let original_len = links.len();
            let mut added = Vec::new();
            if active {
                if let Some(layers) = stack["layers"].as_array() {
                    for layer in layers {
                        let Some(number) = layer["number"].as_i64().filter(|n| *n > 0) else { continue };
                        let sibling_key = crate::migration_050::normalize_key(key["host"].as_str().unwrap(), key["repository"].as_str().unwrap(), number);
                        // Dismissed links are tombstones and must prevent rediscovery.
                        if links.iter().any(|link| {
                            match (link["host"].as_str(), link["repository"].as_str(), link["number"].as_i64()) {
                                (Some(h),Some(r),Some(n)) => crate::migration_050::normalize_key(h,r,n) == sibling_key,
                                _ => false,
                            }
                        }) { continue }
                        let Some(url) = sibling_url(&original, number) else { continue };
                        links.push(serde_json::json!({"host":key["host"],"repository":original["repository"].as_str().unwrap_or_default().to_lowercase(),"number":number,"url":url,"source":"stack","linkedAt":now,"snapshot":null,"stack":null}));
                        added.push(number);
                    }
                }
            }
            let mut previous = original["snapshot"].clone();
            if let Some(object) = previous.as_object_mut() { object.remove("syncedAt"); }
            let mut comparable = snapshot.clone(); comparable.as_object_mut().unwrap().remove("syncedAt");
            let changed = previous != comparable || original["stack"] != *stack;
            if changed { links[index]["snapshot"] = snapshot.clone(); links[index]["stack"] = stack.clone(); }
            let updated_link = links[index].clone();
            if added.is_empty() && !changed { return Ok((Vec::new(), vec![])) }
            // Link commands publish full thread snapshots; sync publishes a link patch.
            let mut events = Vec::new();
            if !added.is_empty() {
                thread["updatedAt"] = serde_json::json!(now);
                for count in 1..=added.len() {
                    let mut link_thread = thread.clone();
                    let event_links = link_thread["pullRequests"].as_array_mut().unwrap();
                    event_links.truncate(original_len + count);
                    event_links[index] = original.clone();
                    if link_thread.get("linkedPullRequest").is_none() { link_thread["linkedPullRequest"] = Value::Null; }
                    let id = uuid::Uuid::new_v4().to_string();
                    events.push(crate::event_store::Event { id: id.clone(), aggregate_kind:"thread".into(), stream_id:thread_id.clone(), event_type:"thread.pull-request-synced".into(), occurred_at:now.clone(), command_id:Some(format!("server:pr-stack-link:{}:{id}", thread_id)), causation_event_id:None, correlation_id:None, actor_kind:"server".into(), payload:link_thread, metadata:serde_json::json!({"providerInstanceId":thread["providerInstanceId"]}) });
                }
                if thread.get("linkedPullRequest").is_none() { thread["linkedPullRequest"] = Value::Null; }
            }
            if changed {
                let id = uuid::Uuid::new_v4().to_string();
                events.push(crate::event_store::Event { id: id.clone(), aggregate_kind:"thread".into(), stream_id:thread_id.clone(), event_type:"thread.pull-request-link-updated".into(), occurred_at:now.clone(), command_id:Some(format!("server:pr-sync:{id}")), causation_event_id:None, correlation_id:None, actor_kind:"server".into(), payload:updated_link, metadata:serde_json::json!({"providerInstanceId":thread["providerInstanceId"]}) });
            }
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?2, updated_at=CASE WHEN ?3 THEN ?4 ELSE updated_at END WHERE thread_id=?1", rusqlite::params![thread_id, thread.to_string(), !added.is_empty(), now])?;
            Ok((added, crate::event_store::append(tx, &events)?))
        });
        match outcome {
            Ok(numbers) => result.discovered.extend(numbers.into_iter().map(|number| serde_json::json!({"host":key["host"],"repository":key["repository"],"number":number}))),
            Err(err) => { eprintln!("PR sync commit failed: {err}"); result.failed = true; },
        }
    }
    result
}

fn sibling_url(link: &Value, number: i64) -> Option<String> {
    let mut url = url::Url::parse(link["url"].as_str()?).ok()?;
    let segments: Vec<_> = url.path_segments()?.collect();
    let marker = segments
        .iter()
        .position(|s| matches!(*s, "pull" | "pulls" | "merge_requests"))?;
    if segments.get(marker + 1)?.parse::<i64>().ok()? != link["number"].as_i64()? {
        return None;
    }
    let path = format!("{}/{}", segments[..=marker].join("/"), number);
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn link_matches(link: &Value, target: &crate::migration_050::PullRequestKey) -> bool {
    if link["source"] == "stack-dismissed" {
        return false;
    }
    match (
        link["host"].as_str(),
        link["repository"].as_str(),
        link["number"].as_i64(),
    ) {
        (Some(host), Some(repository), Some(number)) => {
            crate::migration_050::normalize_key(host, repository, number) == *target
        }
        _ => false,
    }
}

#[cfg(test)]
mod sync_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn expands_stack_and_respects_dismissal_and_settlement() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, settled) in [("active", false), ("settled", true)] {
            let thread = json!({"id":id,"updatedAt":"old","settledAt":if settled {json!("time")} else {Value::Null},"pullRequests":[{"host":"github.com","repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","source":"manual","snapshot":null,"stack":null},{"host":"github.com","repository":"owner/repo","number":8,"source":"stack-dismissed"}]});
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?1,'p','T','codex','full-access','default','2026','old',?2)", rusqlite::params![id,thread.to_string()]).unwrap();
        }
        let bus = crate::event_bus::EventBus::new(db, 16);
        let key = json!({"host":"github.com","repository":"owner/repo","number":7});
        let summary = json!({"state":"open","title":"Change","headBranch":"a","baseBranch":"b","isDraft":false,"updatedAt":"time","closedAt":null,"mergedAt":null});
        let stack = json!({"id":"s","number":1,"layers":[{"number":7},{"number":8},{"number":9},{"number":10}]});
        sync_report_with(
            &bus,
            &key,
            |_| Some(summary.clone()),
            |_| Some(stack.clone()),
        );
        bus.with_autocommit(|db| {
            for (id, count) in [("active",4),("settled",2)] {
                let raw: String = db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",[id],|r| r.get(0)).unwrap();
                let thread:Value=serde_json::from_str(&raw).unwrap();
                assert_eq!(thread["pullRequests"].as_array().unwrap().len(),count);
                assert_eq!(thread["pullRequests"][0]["stack"]["kind"],"native");
                assert_eq!(thread["pullRequests"][1]["source"],"stack-dismissed");
                if id == "active" { assert_eq!(thread["pullRequests"][2]["url"],"https://github.com/owner/repo/pull/9"); }
            }
            let mut stmt = db.prepare("SELECT event_type,payload_json FROM orchestration_events WHERE stream_id='active' ORDER BY sequence").unwrap();
            let events: Vec<(String,Value)> = stmt.query_map([], |r| { let raw:String = r.get(1)?; Ok((r.get(0)?,serde_json::from_str(&raw).unwrap())) }).unwrap().map(Result::unwrap).collect();
            assert_eq!(events.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), vec!["thread.pull-request-synced", "thread.pull-request-synced", "thread.pull-request-link-updated"]);
            assert_eq!(events[0].1["pullRequests"].as_array().unwrap().len(),3);
            assert_eq!(events[1].1["pullRequests"].as_array().unwrap().len(),4);
            assert!(events[0].1["pullRequests"][0]["snapshot"].is_null());
            assert_eq!(events[2].1["snapshot"]["state"],"open");
            assert_eq!(events[2].1["stack"]["kind"],"native");
        }).unwrap();
    }
    #[test]
    fn retries_failed_reads_and_resweeps_stale_stack_members() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","pullRequests":[
            {"host":"github.com","repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","source":"manual","snapshot":null,"stack":null},
            {"host":"github.com","repository":"owner/repo","number":8,"url":"https://github.com/owner/repo/pull/8","source":"manual","snapshot":null,"stack":{"kind":"native","id":"s","layers":[{"number":7},{"number":8}]}}
        ]});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','old',?1)", [thread.to_string()]).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let key = json!({"host":"github.com","repository":"owner/repo","number":7});
        assert!(sync_report_with(&bus, &key, |_| None, |_| None).failed);
        let summary = json!({"state":"open","title":"Change","headBranch":"a","baseBranch":"b","updatedAt":"time"});
        let stack = json!({"id":"s","layers":[{"number":7},{"number":8},{"number":9}]});
        let result = sync_report_with(
            &bus,
            &key,
            |_| Some(summary.clone()),
            |_| Some(stack.clone()),
        );
        assert!(!result.failed);
        assert!(result.discovered.iter().any(|key| key["number"] == 8));
    }

    #[test]
    fn refreshes_matching_links_from_host_and_preserves_watch() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","updatedAt":"old","pullRequests":[{"host":"GitHub.com","repository":"Owner/Repo","number":7,"source":"manual","watch":{"checksPending":true},"snapshot":null,"stack":null},{"host":"github.com","repository":"owner/repo","number":8,"source":"manual","snapshot":null}]});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','old',?1)", [thread.to_string()]).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let key = json!({"host":"github.com","repository":"owner/repo","number":7});
        let summary = json!({"state":"merged","title":"Change","headBranch":"a","baseBranch":"b","isDraft":false,"updatedAt":"time","closedAt":null,"mergedAt":"time"});
        let mut count = 0;
        for _ in 0..2 {
            sync_report_with(
                &bus,
                &key,
                |input| {
                    count += 1;
                    assert_eq!(input["projectId"], "p");
                    Some(summary.clone())
                },
                |_| Some(Value::Null),
            );
        }
        assert_eq!(count, 2);
        bus.with_autocommit(|db| {
            let raw: String = db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'", [], |r| r.get(0)).unwrap();
            let thread: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(thread["pullRequests"][0]["snapshot"]["state"], "merged");
            assert_eq!(thread["pullRequests"][0]["watch"]["checksPending"], true);
            assert!(thread["pullRequests"][1]["snapshot"].is_null());
            let events: i64 = db.query_row("SELECT count(*) FROM orchestration_events WHERE event_type='thread.pull-request-link-updated'", [], |r| r.get(0)).unwrap();
            assert_eq!(events, 1);
            let event_raw: String = db.query_row("SELECT payload_json FROM orchestration_events WHERE event_type='thread.pull-request-link-updated'", [], |r| r.get(0)).unwrap();
            let event: Value = serde_json::from_str(&event_raw).unwrap();
            assert_eq!(event, thread["pullRequests"][0]);
            assert_eq!(thread["updatedAt"], "old");
        }).unwrap();
    }
}
