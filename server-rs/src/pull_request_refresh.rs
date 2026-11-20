//! Pull request refresh notifications shared by RPC requests and subscribers.
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex, OnceLock},
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
const WATCH_REMARK_WAKE_LIMIT: u64 = 10;
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
    sync_worker: OnceLock<std::sync::mpsc::SyncSender<SyncRequest>>,
    watch_sweep: OnceLock<()>,
    queued_syncs: Arc<Mutex<HashSet<String>>>,
}
impl Default for Refreshes {
    fn default() -> Self {
        Self {
            epoch: Mutex::new(0),
            changes: watch::channel(0).0,
            reports: Mutex::new(VecDeque::new()),
            state_changes: tokio::sync::broadcast::channel(64).0,
            sync_worker: OnceLock::new(),
            watch_sweep: OnceLock::new(),
            queued_syncs: Default::default(),
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
    pub(crate) fn start_watch_sweep(self: &Arc<Self>, bus: crate::event_bus::EventBus) {
        self.watch_sweep.get_or_init(|| {
            let refreshes = Arc::downgrade(self);
            std::thread::spawn(move || loop {
                let Some(refreshes) = refreshes.upgrade() else { break };
                if let Ok(Ok((projects, targets))) = bus.with_autocommit(|db| {
                    let targets = live_watch_keys(db).map_err(|error| serde_json::json!(error.to_string()))?;
                    let projects = if targets.is_empty() {
                        Vec::new()
                    } else {
                        crate::pull_request_routing::projects(db)?
                    };
                    Ok::<_, Value>((projects, targets))
                }) {
                    for key in targets {
                        refreshes.queue_sync(bus.clone(), projects.clone(), key);
                    }
                }
                drop(refreshes);
                std::thread::sleep(Duration::from_secs(60));
            });
        });
    }

    pub(crate) fn queue_sync(
        &self,
        bus: crate::event_bus::EventBus,
        projects: Vec<(String, String, String)>,
        key: Value,
    ) {
        let identity = sync_identity(&key);
        if !self.queued_syncs.lock().unwrap_or_else(|e| e.into_inner()).insert(identity.clone()) {
            return;
        }
        let sender = self.sync_worker.get_or_init(|| {
            let queued_syncs = self.queued_syncs.clone();
            let (sender, receiver) = std::sync::mpsc::sync_channel::<SyncRequest>(2048);
            std::thread::spawn(move || {
                let mut retries = RetryQueue::new();
                loop {
                    // Due retries take priority even when the incoming channel stays busy.
                    let (request, from_queue) = if let Some(request) = retries.pop_due(Instant::now()) {
                        (request, false)
                    } else {
                        let request = match retries.wait(Instant::now()) {
                            Some(wait) => match receiver.recv_timeout(wait) {
                                Ok(request) => request,
                                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                            },
                            None => match receiver.recv() {
                                Ok(request) => request,
                                Err(_) => break,
                            },
                        };
                        (request, true)
                    };
                    let (bus, projects, key) = request;
                    let identity = sync_identity(&key);
                    if from_queue {
                        queued_syncs.lock().unwrap_or_else(|e| e.into_inner()).remove(&identity);
                    }
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
        if sender.send((bus, projects, key)).is_err() {
            self.queued_syncs.lock().unwrap_or_else(|e| e.into_inner()).remove(&identity);
        }
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

fn live_watch_keys(db: &rusqlite::Connection) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = db.prepare(
        "SELECT DISTINCT lower(json_extract(link.value,'$.host')),
                lower(json_extract(link.value,'$.repository')), json_extract(link.value,'$.number')
         FROM orchestration_v2_projection_threads t, json_each(t.payload_json,'$.pullRequests') link
         WHERE link.type='object' AND t.archived_at IS NULL AND t.deleted_at IS NULL
           AND json_extract(t.payload_json,'$.settledAt') IS NULL
           AND COALESCE(json_extract(t.payload_json,'$.settledOverride'),'') != 'settled'
           AND COALESCE(json_extract(t.payload_json,'$.lineage.relationshipToParent'),'') != 'subagent'
           AND json_extract(link.value,'$.watch') IS NOT NULL
           AND COALESCE(json_extract(link.value,'$.source'),'') != 'stack-dismissed'
           AND json_type(link.value,'$.host')='text'
           AND json_type(link.value,'$.repository')='text'
           AND json_type(link.value,'$.number')='integer'
           AND json_extract(link.value,'$.number') > 0"
    )?;
    let rows = stmt.query_map([], |row| Ok(serde_json::json!({
        "host":row.get::<_,String>(0)?,
        "repository":row.get::<_,String>(1)?,
        "number":row.get::<_,i64>(2)?
    })))?;
    rows.collect()
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
        let result = sync_report_with_details(
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
            |input| crate::pull_request_detail::read(projects.clone(), input).ok(),
            |input| crate::pull_request_activity::read_for_watch(projects.clone(), input).ok(),
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

#[cfg(test)]
fn sync_report_with(
    bus: &crate::event_bus::EventBus,
    key: &Value,
    read: impl FnMut(&Value) -> Option<Value>,
    read_stack: impl FnMut(&Value) -> Option<Value>,
) -> SyncResult {
    sync_report_with_details(bus, key, read, read_stack, |_| None, |_| None)
}

fn sync_report_with_details(
    bus: &crate::event_bus::EventBus,
    key: &Value,
    mut read: impl FnMut(&Value) -> Option<Value>,
    mut read_stack: impl FnMut(&Value) -> Option<Value>,
    mut read_detail: impl FnMut(&Value) -> Option<Value>,
    mut read_activity: impl FnMut(&Value) -> Option<Value>,
) -> SyncResult {
    use crate::migration_050::normalize_key;
    let target = normalize_key(
        key["host"].as_str().unwrap(),
        key["repository"].as_str().unwrap(),
        key["number"].as_i64().unwrap(),
    );
    let rows = bus.with_autocommit(|db| -> rusqlite::Result<Vec<(String, String, Option<Value>)>> {
        let mut stmt = db.prepare("SELECT thread_id, project_id, payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND json_type(payload_json,'$.pullRequests')='array'")?;
        let mut result = Vec::new();
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?)))?;
        for row in rows {
            let (thread, project, raw) = row?;
            let Ok(value) = serde_json::from_str::<Value>(&raw) else { continue };
            if let Some(link) = value["pullRequests"].as_array().and_then(|links| links.iter().find(|link| link_matches(link, &target))) {
                let watch_started = (watch_thread_active(&value) && !link["watch"].is_null())
                    .then(|| link["watch"]["startedAt"].clone());
                result.push((thread, project, watch_started));
            }
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
    let mut details = std::collections::HashMap::new();
    let mut activities = std::collections::HashMap::new();
    for (thread_id, project_id, watch_started) in rows {
        let watching = watch_started.is_some();
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
        let detail = if watching && summary["state"] == "open" {
            details.entry(project_id.clone()).or_insert_with(|| {
                read_detail(&serde_json::json!({
                    "projectId":project_id,"host":key["host"],"repository":key["repository"],
                    "number":key["number"],"allowStale":false
                }))
            }).as_ref().filter(|detail| detail["state"] == "open")
        } else {
            None
        };
        let activity = if watching && summary["state"] == "open" {
            activities.entry(project_id.clone()).or_insert_with(|| {
                read_activity(&serde_json::json!({
                    "projectId":project_id,"host":key["host"],"repository":key["repository"],
                    "number":key["number"],"allowStale":false
                }))
            }).as_ref()
        } else {
            None
        };
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
        let stack = stack.as_ref();
        if stack.is_none() {
            result.failed = true;
            // A verified terminal state can end a watch even if stack data is unavailable.
            if !matches!(summary["state"].as_str(), Some("closed" | "merged")) {
                continue;
            }
        }
        // A changed layer list also makes already-linked members of the same stack stale.
        if let Some((stack, layers)) = stack.and_then(|stack| stack["layers"].as_array().map(|layers| (stack, layers))) {
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
        let outcome = bus.commit_with(|tx| -> Result<_, crate::message_commands::DispatchError> {
            use rusqlite::OptionalExtension;
            let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL", [&thread_id], |r| r.get(0)).optional()?;
            let Some(raw) = raw else { return Ok((Vec::new(), vec![])) };
            let mut thread: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let active = watch_thread_active(&thread);
            let Some(links) = thread["pullRequests"].as_array_mut() else { return Ok((Vec::new(), vec![])) };
            let Some(index) = links.iter().position(|link| link_matches(link, &target)) else { return Ok((Vec::new(), vec![])) };
            let original = links[index].clone();
            let original_len = links.len();
            let mut added = Vec::new();
            if active {
                if let Some(layers) = stack.and_then(|stack| stack["layers"].as_array()) {
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
            let snapshot_changed = previous != comparable || stack.is_some_and(|stack| original["stack"] != *stack);
            let link = &mut links[index];
            if snapshot_changed {
                link["snapshot"] = snapshot.clone();
                if let Some(stack) = stack {
                    link["stack"] = stack.clone();
                }
            }
            // A watch started or replaced during the host reads needs a new observation.
            let same_watch = active && !link["watch"].is_null()
                && watch_started.as_ref() == Some(&link["watch"]["startedAt"]);
            let check_update = if same_watch {
                let original = &link["watch"];
                let (mut next, mut notices) = detail
                    .and_then(|detail| evaluate_watch_checks(original, detail, &now))
                    .unwrap_or_else(|| (original.clone(), Vec::new()));
                if let Some(detail) = detail {
                    evaluate_watch_mergeability(original, detail, &mut next, &mut notices);
                }
                if let Some((remarks_through, remark_ids, notice)) =
                    activity.and_then(|activity| evaluate_watch_remarks(original, activity))
                {
                    next["remarksThrough"] = remarks_through;
                    next["remarkIds"] = remark_ids;
                    notices.extend(notice);
                }
                let exhausted = track_remark_wakes(original, &mut next, &mut notices);
                (&next != original).then_some((next, notices, exhausted))
            } else {
                None
            };
            let closed = same_watch && snapshot["state"] == "closed";
            let wake_route = if closed || check_update.as_ref().is_some_and(|(_, notices, _)| !notices.is_empty()) {
                tx.query_row(
                    "SELECT json_extract(pt.payload_json,'$.driver'), COALESCE(json_extract(t.payload_json,'$.worktreePath'), p.workspace_root)
                     FROM orchestration_v2_projection_threads t
                     JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id=?2 AND pt.thread_id=t.thread_id
                     JOIN projection_projects p ON p.project_id=t.project_id AND p.deleted_at IS NULL
                     WHERE t.thread_id=?1 AND t.archived_at IS NULL",
                    rusqlite::params![thread_id, crate::conversation_provider::select(tx, &thread_id)?],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                ).optional()?
            } else {
                None
            };
            // Read the current watch in the same transaction as the snapshot and wake.
            let watch_ended = (snapshot["state"] == "merged" || (closed && wake_route.is_some()))
                && !link["watch"].is_null();
            if watch_ended {
                let fields = link.as_object_mut().ok_or(rusqlite::Error::InvalidQuery)?;
                if let Some(watch) = fields.remove("watch") {
                    fields.insert("endedWatch".into(), watch);
                }
            }
            let mut notices = Vec::new();
            if let Some((next, changes, exhausted)) = check_update {
                if changes.is_empty() || wake_route.is_some() {
                    if exhausted {
                        let fields = link.as_object_mut().ok_or(rusqlite::Error::InvalidQuery)?;
                        fields.remove("watch");
                        fields.insert("endedWatch".into(), next);
                    } else {
                        link["watch"] = next;
                    }
                    notices = changes;
                }
            }
            let changed = snapshot_changed || watch_ended || link["watch"] != original["watch"];
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
                events.push(crate::event_store::Event { id: id.clone(), aggregate_kind:"thread".into(), stream_id:thread_id.clone(), event_type:"thread.pull-request-link-updated".into(), occurred_at:now.clone(), command_id:Some(format!("server:pr-sync:{id}")), causation_event_id:None, correlation_id:None, actor_kind:"server".into(), payload:updated_link.clone(), metadata:serde_json::json!({"providerInstanceId":thread["providerInstanceId"]}) });
            }
            tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?2, updated_at=CASE WHEN ?3 THEN ?4 ELSE updated_at END WHERE thread_id=?1", rusqlite::params![thread_id, thread.to_string(), !added.is_empty(), now])?;
            let mut stored = crate::event_store::append(tx, &events)?;
            if let Some((driver, cwd)) = wake_route {
                let number = updated_link["number"].as_i64().ok_or(rusqlite::Error::InvalidQuery)?;
                let url = updated_link["url"].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
                if closed {
                    notices.push(("closed, stopped watching", "was closed, so R3 Code stopped watching it. Call watch_pull_request if it reopens.".into()));
                }
                if !notices.is_empty() {
                    let labels = notices.iter().map(|(label, _)| *label).collect::<Vec<_>>().join("; ");
                    let text = notices.iter().map(|(_, detail)| format!("Pull request #{number} ({url}) {detail}")).collect::<Vec<_>>().join("\n");
                    stored.extend(queue_watch_notice(
                        tx, &thread_id, &driver, &cwd, &now,
                        &text, &format!("#{number}: {labels}"),
                    )?);
                }
            }
            Ok((added, stored))
        });
        match outcome {
            Ok(numbers) => result.discovered.extend(numbers.into_iter().map(|number| serde_json::json!({"host":key["host"],"repository":key["repository"],"number":number}))),
            Err(err) => { eprintln!("PR sync commit failed: {err}"); result.failed = true; },
        }
    }
    result
}

pub(crate) fn watch_tools() -> [Value; 2] {
    [("watch_pull_request", "Watch pull request"), ("unwatch_pull_request", "Stop watching pull request")]
        .map(|(name, title)| serde_json::json!({
            "name":name,"description":format!("{title} in the current thread. Supply a pull request URL or identify an existing link by repository and number."),
            "inputSchema":{"type":"object","properties":{
                "url":{"type":"string"},"repository":{"type":"string"},
                "host":{"type":"string"},"number":{"type":"integer","minimum":1}
            },"additionalProperties":false},
            "annotations":{"title":title,"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true}
        }))
}

pub(crate) fn set_watch(
    bus: &crate::event_bus::EventBus,
    scope: &crate::mcp_credentials::Scope,
    args: &Value,
    watching: bool,
) -> Result<Value, (&'static str, String)> {
    if scope.subagent || scope.client.is_some() || scope.thread_id.is_empty() {
        return Err(("forbidden", "Only the parent thread can manage its pull request watches.".into()));
    }
    let invalid = || ("invalid_arguments", "Provide a pull request URL or a linked repository and number.".to_owned());
    let explicit_url = args["url"].as_str().map(str::trim).filter(|url| !url.is_empty());
    if args.as_object().is_none_or(|fields| fields.keys().any(|key| !matches!(key.as_str(), "url" | "repository" | "host" | "number"))) {
        return Err(invalid());
    }
    let explicit_key = explicit_url.map(|url| {
        let parsed = url::Url::parse(url).ok()?;
        if !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() {
            return None;
        }
        crate::migration_050::change_request_url_key(url)
    });
    if explicit_key.as_ref().is_some_and(Option::is_none) {
        return Err(invalid());
    }
    let explicit_key = explicit_key.flatten();
    let repository = args["repository"].as_str();
    let number = args["number"].as_i64().filter(|n| *n > 0);
    if explicit_key.is_none() && (repository.is_none() || number.is_none()) {
        return Err(invalid());
    }

    bus.commit(|tx| {
        use rusqlite::OptionalExtension;
        use serde_json::json;
        let Some(raw) = tx.query_row(
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND archived_at IS NULL AND deleted_at IS NULL",
            [&scope.thread_id], |row| row.get::<_,String>(0)
        ).optional()? else { return Ok((None, Vec::new())) };
        let active_provider: Option<String> = tx.query_row(
            "SELECT provider_instance_id FROM orchestration_v2_projection_runs
             WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting')
             ORDER BY ordinal DESC LIMIT 1",
            [&scope.thread_id], |row| row.get(0)
        ).optional()?.flatten();
        if active_provider.as_deref() != Some(scope.provider_instance_id.as_str()) {
            return Ok((None, Vec::new()));
        }
        let mut thread: Value = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if !watch_thread_active(&thread) {
            return Ok((None, Vec::new()));
        }
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let links = thread.as_object_mut().ok_or(rusqlite::Error::InvalidQuery)?
            .entry("pullRequests").or_insert_with(|| json!([]));
        if links.is_null() { *links = json!([]); }
        let links = links.as_array_mut().ok_or(rusqlite::Error::InvalidQuery)?;
        let mut matches = links.iter().enumerate().filter(|(_, link)| {
            if let Some(target) = &explicit_key { return link_matches(link, target); }
            link["source"] != "stack-dismissed"
                && link["number"].as_i64() == number
                && link["repository"].as_str().zip(repository).is_some_and(|(a,b)| a.eq_ignore_ascii_case(b))
                && args["host"].as_str().is_none_or(|host| link["host"].as_str().is_some_and(|a| a.eq_ignore_ascii_case(host)))
        });
        let index = matches.next().map(|(index, _)| index);
        if matches.next().is_some() { return Ok((None, Vec::new())); }
        let index = if let Some(index) = index {
            index
        } else if let (true, Some(target), Some(url)) = (watching, explicit_key.as_ref(), explicit_url) {
            links.push(json!({"host":target.host,"repository":target.repository,"number":target.number,
                "url":url,"source":"manual","linkedAt":now,"snapshot":null,"stack":null}));
            links.len() - 1
        } else {
            return Ok((None, Vec::new()));
        };
        let link = &mut links[index];
        let was_watching = !link["watch"].is_null();
        let response = json!({"host":link["host"],"repository":link["repository"],"number":link["number"],
            "url":link["url"],"watching":watching,"wasWatching":was_watching});
        if watching == was_watching {
            return Ok((Some(response), Vec::new()));
        }
        let fields = link.as_object_mut().ok_or(rusqlite::Error::InvalidQuery)?;
        if watching {
            fields.insert("watch".into(), json!({"startedAt":now,"remarksThrough":now,"remarkIds":[],
                "headSha":null,"awaitingBaseline":"all","checksPending":true,"failedChecks":[],
                "passed":false,"passedChecks":[],"wakes":0}));
        } else if let Some(previous) = fields.remove("watch") {
            fields.insert("endedWatch".into(), previous);
        }
        if thread.get("linkedPullRequest").is_none() { thread["linkedPullRequest"] = Value::Null; }
        thread["updatedAt"] = json!(now);
        tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?2,updated_at=?3 WHERE thread_id=?1",
            rusqlite::params![scope.thread_id,thread.to_string(),now])?;
        let event = crate::event_store::Event {
            id: uuid::Uuid::new_v4().to_string(),
            aggregate_kind: "thread".into(),
            stream_id: scope.thread_id.clone(),
            event_type: "thread.pull-request-synced".into(),
            occurred_at: now,
            command_id: None, causation_event_id: None, correlation_id: None,
            actor_kind: "server".into(), metadata: json!({"providerInstanceId":thread["providerInstanceId"]}),
            payload: thread,
        };
        Ok((Some(response), crate::event_store::append(tx, &[event])?))
    }).map_err(|_| ("orchestration_error", "Could not update the pull request watch.".into()))?
        .ok_or(("not_found", "No matching pull request or active thread was found.".into()))
}

fn watch_thread_active(thread: &Value) -> bool {
    thread["archivedAt"].is_null()
        && thread["settledAt"].is_null()
        && thread["settledOverride"] != "settled"
        && thread["lineage"]["relationshipToParent"] != "subagent"
}

type WatchNotice = (&'static str, String);

fn workflow_run_url(url: &str) -> Option<&str> {
    let (prefix, suffix) = url.split_once("/actions/runs/")?;
    let digits = suffix.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0).then(|| &url[..prefix.len() + "/actions/runs/".len() + digits])
}

fn evaluate_watch_checks(watch: &Value, detail: &Value, now: &str) -> Option<(Value, Vec<WatchNotice>)> {
    watch.as_object()?;
    let checks = detail["checks"].as_array()?;
    if checks.iter().any(|check| check["placeholder"] == true) {
        return None;
    }
    let head = detail["headSha"].as_str().filter(|head| !head.is_empty())?;
    let moved = watch["headSha"].as_str().is_some_and(|previous| previous != head);
    let baseline = !moved && (watch["headSha"].is_null() || !watch["awaitingBaseline"].is_null());
    if checks.is_empty() {
        let mut next = watch.clone();
        next["headSha"] = serde_json::json!(head);
        if moved {
            for field in ["failedChecks", "passedChecks", "owedChecks", "awaitingApproval"] {
                next[field] = serde_json::json!([]);
            }
            next["passed"] = serde_json::json!(false);
            next["approvalAnnounced"] = serde_json::json!(false);
        }
        let since = if moved || watch["awaitingBaseline"] == "all" {
            Some(now)
        } else {
            watch["checksAwaitedSince"].as_str()
        };
        let expired = since
            .and_then(|since| chrono::DateTime::parse_from_rfc3339(since).ok())
            .zip(chrono::DateTime::parse_from_rfc3339(now).ok())
            .is_some_and(|(since, now)| now - since >= chrono::Duration::minutes(15));
        next["checksAwaitedSince"] = serde_json::json!(since.filter(|_| !expired));
        next["checksPending"] = serde_json::json!(since.is_some() && !expired);
        next.as_object_mut()?.remove("awaitingBaseline");
        let notices = if expired && detail["capabilities"]["checksAlwaysReport"] == true {
            vec![("no checks reported", "has no reported checks 15 minutes after watching this revision.".into())]
        } else {
            Vec::new()
        };
        return Some((next, notices));
    }
    let names = |filter: fn(&Value) -> bool| {
        checks.iter().filter(|check| filter(check)).filter_map(|check| check["name"].as_str()).collect::<Vec<_>>()
    };
    let failed = names(|check| matches!(check["status"].as_str(), Some("failure" | "cancelled")));
    let approval = names(|check| check["status"] == "action-required");
    let mut holds: Vec<&str> = checks.iter()
        .filter(|check| check["status"] == "action-required")
        .filter_map(|check| check["url"].as_str().and_then(workflow_run_url).or_else(|| check["name"].as_str()))
        .collect();
    let jobs_pending = checks.iter().any(|check| {
        check["status"] == "pending" && check["url"].as_str().is_none_or(|url| workflow_run_url(url).is_some())
    });
    if !moved {
        for hold in watch["awaitingApproval"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let finished = if workflow_run_url(hold) == Some(hold) {
                !jobs_pending && checks.iter().any(|check| {
                    !matches!(check["status"].as_str(), Some("pending" | "action-required"))
                        && check["url"].as_str().and_then(workflow_run_url) == Some(hold)
                })
            } else {
                let mut matching = checks.iter().filter(|check| check["name"] == hold).peekable();
                matching.peek().is_some() && matching.all(|check| {
                    !matches!(check["status"].as_str(), Some("pending" | "action-required"))
                })
            };
            if !finished && !holds.contains(&hold) {
                holds.push(hold);
            }
        }
    }
    holds.sort_unstable();
    holds.dedup();
    let pending = checks.iter().any(|check| check["status"] == "pending");
    let required = checks.iter().any(|check| check["required"] == true);
    let gate: Vec<_> = checks.iter().filter(|check| !required || check["required"] == true).collect();
    let passed = holds.is_empty() && gate.iter().all(|check| {
        matches!(check["status"].as_str(), Some("success" | "neutral" | "skipped"))
    });
    let gate_names: Vec<_> = gate.iter().filter_map(|check| check["name"].as_str()).collect();
    let old_contains = |field: &str, name: &str| {
        !moved && watch[field].as_array().is_some_and(|items| items.iter().any(|item| item == name))
    };
    let newly_failed: Vec<_> = failed.iter().copied().filter(|name| !old_contains("failedChecks", name)).collect();
    let mut notices = Vec::new();
    let was_passing = !moved && watch["passed"] == true;
    let gate_grew = required && watch["passedChecks"].as_array().is_some_and(|previous| {
        !previous.is_empty() && gate_names.iter().any(|name| !old_contains("passedChecks", name))
    });
    let newly_passing = passed && (!was_passing || gate_grew);
    let approval_announced = !moved && watch["approvalAnnounced"] == true;
    let mut owed = if passed && was_passing {
        names(|check| check["required"] != true)
            .into_iter().filter(|name| old_contains("owedChecks", name)).collect()
    } else {
        Vec::new()
    };
    if newly_passing {
        if !baseline {
            notices.push(("checks passed", if required { "passed its required checks.".into() } else { "passed its checks.".into() }));
        }
        if required {
            owed = names(|check| check["required"] != true && check["status"] == "pending");
        }
    } else if !baseline && passed && !pending && failed.is_empty() && !owed.is_empty() {
        notices.push(("checks passed", "finished and passed its remaining checks.".into()));
        owed.clear();
    }
    if !baseline {
        if !newly_failed.is_empty() {
            notices.push(("checks failed", format!("has newly failed checks: {}.", newly_failed.join(", "))));
        }
        if !approval.is_empty() && !approval_announced {
            notices.push(("checks await approval", format!("has checks awaiting approval: {}.", approval.join(", "))));
        }
    }
    let mut next = watch.clone();
    next["headSha"] = serde_json::json!(head);
    next["failedChecks"] = serde_json::json!(failed);
    next["approvalAnnounced"] = serde_json::json!(approval_announced || !approval.is_empty());
    next["owedChecks"] = serde_json::json!(owed);
    next["awaitingApproval"] = serde_json::json!(holds);
    next["checksPending"] = serde_json::json!(pending);
    next["checksAwaitedSince"] = Value::Null;
    next["passed"] = serde_json::json!(passed);
    next["passedChecks"] = if passed { serde_json::json!(gate_names) } else { serde_json::json!([]) };
    next.as_object_mut()?.remove("awaitingBaseline");
    Some((next, notices))
}

fn evaluate_watch_mergeability(
    watch: &Value,
    detail: &Value,
    next: &mut Value,
    notices: &mut Vec<WatchNotice>,
) {
    if !watch.is_object() {
        return;
    }
    let baseline = watch["awaitingBaseline"] == "all";
    for (field, observation, label, message) in [
        ("conflicting", match detail["mergeability"].as_str() {
            Some("conflicting") => Some(true),
            Some("mergeable") => Some(false),
            _ => None,
        }, "merge conflict", "has a merge conflict."),
        ("rebaseRequired", detail["rebaseRequired"].as_bool(), "rebase required", "needs a rebase."),
    ] {
        let Some(observed) = observation else { continue };
        let head_field = format!("{field}ObservedHead");
        let previous_head = watch[&head_field].as_str().or_else(|| watch["headSha"].as_str());
        let head = detail["headSha"].as_str();
        let moved = head.zip(previous_head).is_some_and(|(head, previous)| head != previous);
        if observed && !baseline && (moved || watch[field] != true) {
            notices.push((label, message.into()));
        }
        next[field] = serde_json::json!(observed);
        if let Some(head) = head {
            next[&head_field] = serde_json::json!(head);
        }
    }
}

fn evaluate_watch_remarks(watch: &Value, activity: &Value) -> Option<(Value, Value, Option<WatchNotice>)> {
    watch.as_object()?;
    let comments = activity["comments"].as_array()?;
    if activity["commentsTruncated"] == true {
        // Advancing the cursor over a partial read could permanently miss unseen comments.
        return None;
    }
    let parse = |value: &Value| chrono::DateTime::parse_from_rfc3339(value.as_str()?).ok();
    let through = parse(&watch["remarksThrough"]).or_else(|| parse(&watch["startedAt"]))?;
    let known = watch["remarkIds"].as_array();
    let viewer = activity["viewer"].as_str().or_else(|| activity["author"]["login"].as_str());
    let cutoff = comments.iter().filter_map(|comment| {
        let id = comment["id"].as_str()?;
        let stamp = parse(&comment["editedAt"]).or_else(|| parse(&comment["createdAt"]))?;
        let own = viewer.is_some_and(|viewer| comment["author"]["login"].as_str().is_some_and(|author| author.eq_ignore_ascii_case(viewer)));
        let already_seen = stamp == through && known.is_some_and(|ids| ids.iter().any(|seen| seen == id));
        (!own && stamp >= through && !already_seen).then_some((stamp, id))
    }).collect::<Vec<_>>();
    let latest = cutoff.iter().map(|(stamp, _)| *stamp).max()?;
    let mut ids = if latest == through { known.cloned().unwrap_or_default() } else { Vec::new() };
    for (_, id) in cutoff.iter().filter(|(stamp, _)| *stamp == latest) {
        let id = serde_json::json!(id);
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let notice = Some((
        "new remarks",
        format!("has {} new or edited remarks. Read its latest review activity before proceeding.", cutoff.len()),
    ));
    Some((serde_json::json!(latest.to_rfc3339()), serde_json::json!(ids), notice))
}

fn track_remark_wakes(watch: &Value, next: &mut Value, notices: &mut Vec<WatchNotice>) -> bool {
    if !watch.is_object() {
        return false;
    }
    let remarks_only = notices.len() == 1 && notices[0].0 == "new remarks";
    let moved = watch["headSha"].as_str().zip(next["headSha"].as_str())
        .is_some_and(|(old, new)| old != new);
    if !moved && notices.is_empty() {
        return false;
    }
    let previous = if moved || !remarks_only { 0 } else { watch["wakes"].as_u64().unwrap_or(0) };
    let wakes = previous.saturating_add(u64::from(remarks_only));
    next["wakes"] = serde_json::json!(wakes);
    let exhausted = remarks_only && wakes >= WATCH_REMARK_WAKE_LIMIT;
    if exhausted {
        notices.push((
            "stopped watching",
            format!("reached {WATCH_REMARK_WAKE_LIMIT} consecutive comment-only updates, so R3 Code stopped watching it. Call watch_pull_request to resume."),
        ));
    }
    exhausted
}

fn queue_watch_notice(
    tx: &rusqlite::Transaction<'_>,
    thread_id: &str,
    driver: &str,
    cwd: &str,
    now: &str,
    text: &str,
    summary: &str,
) -> Result<Vec<crate::event_store::StoredEvent>, crate::message_commands::DispatchError> {
    let command = format!("pr-watch:{}", uuid::Uuid::new_v4());
    let message = format!("message:{command}");
    let notification = serde_json::json!({
        "source":{"kind":"monitor"},
        "outcome":"updated",
        "summary":summary
    });
    let cmd = crate::message_commands::DispatchMessage {
        context: None,
        command_id: &command,
        thread_id,
        message_id: &message,
        text,
        attachments: &[],
        creation_source: "server",
        cwd,
        driver,
    };
    let (receipt, events) =
        crate::message_commands::dispatch_agent_notification_tx(tx, cmd, now, &notification)?;
    if !receipt.committed || receipt.receipt.status != "accepted" {
        return Err(rusqlite::Error::InvalidQuery.into());
    }
    Ok(events)
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
    fn pending_workflow_approval_survives_an_omitted_hold() {
        let watch = json!({"headSha":"a","awaitingApproval":["https://github.com/o/r/actions/runs/123"]});
        let at = "2026-01-01T00:00:00Z";
        let unrelated = json!({"headSha":"a","checks":[{"name":"lint","status":"success"}]});
        let (watch, notices) = evaluate_watch_checks(&watch, &unrelated, at).unwrap();
        assert!(notices.is_empty());
        assert_eq!(watch["passed"], false);
        let completed = json!({"headSha":"a","checks":[
            {"name":"job","status":"success","url":"https://github.com/o/r/actions/runs/123/job/456"}
        ]});
        let (watch, notices) = evaluate_watch_checks(&watch, &completed, at).unwrap();
        assert_eq!(watch["awaitingApproval"], json!([]));
        assert_eq!(notices[0].0, "checks passed");
    }

    #[test]
    fn remark_only_wake_limit_restarts_after_head_or_check_progress() {
        let watch = json!({"headSha":"a","wakes":9});
        let mut next = watch.clone();
        let mut notices = vec![("new remarks", "has a new remark.".into())];
        assert!(track_remark_wakes(&watch, &mut next, &mut notices));
        assert_eq!(next["wakes"], 10);
        assert_eq!(notices[1].0, "stopped watching");

        let mut next = json!({"headSha":"b"});
        let mut notices = vec![("new remarks", "has a new remark.".into())];
        assert!(!track_remark_wakes(&watch, &mut next, &mut notices));
        assert_eq!(next["wakes"], 1);

        notices.push(("checks passed", "passed its checks.".into()));
        assert!(!track_remark_wakes(&watch, &mut next, &mut notices));
        assert_eq!(next["wakes"], 0);
    }

    #[test]
    fn mergeability_notices_preserve_unknown_state_and_repeat_on_new_head() {
        let mut watch = json!({"headSha":"a","awaitingBaseline":"all"});
        let mut next = watch.clone();
        let mut notices = Vec::new();
        let conflict = json!({"headSha":"a","mergeability":"conflicting","rebaseRequired":true});
        evaluate_watch_mergeability(&watch, &conflict, &mut next, &mut notices);
        assert!(notices.is_empty());
        assert_eq!(next["conflicting"], true);
        assert_eq!(next["rebaseRequired"], true);
        next.as_object_mut().unwrap().remove("awaitingBaseline");
        watch = next.clone();
        evaluate_watch_mergeability(
            &watch, &json!({"headSha":"b","mergeability":"unknown"}), &mut next, &mut notices,
        );
        assert_eq!(next, watch);
        assert!(notices.is_empty());

        let still_conflicting = json!({"headSha":"b","mergeability":"conflicting","rebaseRequired":true});
        evaluate_watch_mergeability(&watch, &still_conflicting, &mut next, &mut notices);
        assert_eq!(notices.iter().map(|(label, _)| *label).collect::<Vec<_>>(), ["merge conflict", "rebase required"]);
        watch = next.clone();
        notices.clear();
        evaluate_watch_mergeability(&watch, &still_conflicting, &mut next, &mut notices);
        assert!(notices.is_empty());
    }

    #[test]
    fn watch_remarks_keep_ids_at_the_same_timestamp_and_ignore_own_comments() {
        let at = "2026-01-01T00:00:00Z";
        let watch = json!({"remarksThrough":at,"remarkIds":["old"]});
        let activity = json!({"viewer":"Me","comments":[
            {"id":"old","createdAt":at,"author":{"login":"reviewer"}},
            {"id":"new","createdAt":at,"author":{"login":"reviewer"}},
            {"id":"own","createdAt":at,"author":{"login":"me"}}
        ]});
        let (through, ids, notice) = evaluate_watch_remarks(&watch, &activity).unwrap();
        assert_eq!(ids, json!(["old","new"]));
        assert_eq!(notice.unwrap().0, "new remarks");
        let updated = json!({"remarksThrough":through,"remarkIds":ids});
        assert!(evaluate_watch_remarks(&updated, &activity).is_none());
        let mut truncated = activity;
        truncated["commentsTruncated"] = json!(true);
        assert!(evaluate_watch_remarks(&watch, &truncated).is_none());
    }

    #[test]
    fn watch_checks_baseline_deduplicate_and_report_new_head() {
        let at = "2026-01-01T00:00:00Z";
        let pending = json!({"headSha":"a","checks":[{"name":"build","status":"pending"}]});
        let (watch, notices) = evaluate_watch_checks(&json!({"awaitingBaseline":"all"}), &pending, at).unwrap();
        assert!(notices.is_empty());
        assert_eq!(watch["checksPending"], true);

        let failing = json!({"headSha":"a","checks":[{"name":"build","status":"failure"}]});
        let (watch, notices) = evaluate_watch_checks(&watch, &failing, at).unwrap();
        assert_eq!(notices[0].0, "checks failed");
        assert!(evaluate_watch_checks(&watch, &failing, at).unwrap().1.is_empty());
        assert!(evaluate_watch_checks(&watch, &json!({"headSha":"a","checks":[{"placeholder":true}]}), at).is_none());

        let gate = json!({"headSha":"b","checks":[
            {"name":"build","status":"success","required":true},
            {"name":"extra","status":"pending"}
        ]});
        let (watch, notices) = evaluate_watch_checks(&watch, &gate, at).unwrap();
        assert_eq!(notices[0].0, "checks passed");
        assert_eq!(watch["owedChecks"], json!(["extra"]));
        let settled = json!({"headSha":"b","checks":[
            {"name":"build","status":"success","required":true},
            {"name":"extra","status":"success"}
        ]});
        let (watch, notices) = evaluate_watch_checks(&watch, &settled, at).unwrap();
        assert_eq!(notices[0].1, "finished and passed its remaining checks.");
        assert!(evaluate_watch_checks(&watch, &settled, at).unwrap().1.is_empty());
    }

    #[test]
    fn empty_check_list_times_out_once_for_hosts_that_report_checks() {
        let detail = json!({"headSha":"a","checks":[],"capabilities":{"checksAlwaysReport":true}});
        let (watch, notices) = evaluate_watch_checks(
            &json!({"awaitingBaseline":"all"}), &detail, "2026-01-01T00:00:00Z"
        ).unwrap();
        assert_eq!(watch["checksPending"], true);
        assert!(notices.is_empty());
        let at = "2026-01-01T00:15:00Z";
        let (watch, notices) = evaluate_watch_checks(&watch, &detail, at).unwrap();
        assert_eq!(watch["checksPending"], false);
        assert_eq!(notices[0].0, "no checks reported");
        assert!(evaluate_watch_checks(&watch, &detail, at).unwrap().1.is_empty());
    }

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
    fn closed_watch_queues_one_monitor_notification() {
        use crate::message_commands::{dispatch_first_message, DispatchMessage};
        use crate::thread_commands::{create_thread_ordered, CreateThread};

        let at = "2026-01-01T00:00:00.000Z";
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('p','P','/tmp','[]',?1,?1)", [at]).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "t",
                project_id: "p",
                title: "Watched PR",
                model_selection: &json!({"instanceId":"codex","model":"fixture"}),
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &json!("web"),
                link_origin: None,
                delegated_from: None,
            },
            "create-event",
            at,
        ).unwrap();
        dispatch_first_message(&bus, DispatchMessage {
            context: None, command_id: "send", thread_id: "t", message_id: "first",
            text: "Watch this PR", attachments: &[], creation_source: "web", cwd: "/tmp",
            driver: "codex",
        }, at).unwrap();
        let key = json!({"host":"github.com","repository":"owner/repo","number":7});
        let scope = crate::mcp_credentials::Scope {
            thread_id: "t".into(),
            provider_instance_id: "codex".into(),
            ..Default::default()
        };
        let target = json!({"url":"https://github.com/owner/repo/pull/7"});
        let child = crate::mcp_credentials::Scope { subagent: true, ..scope.clone() };
        assert_eq!(set_watch(&bus, &child, &target, true).unwrap_err().0, "forbidden");
        assert_eq!(set_watch(&bus, &scope, &target, true).unwrap()["wasWatching"], false);
        assert_eq!(set_watch(&bus, &scope, &target, true).unwrap()["wasWatching"], true);
        let reference = json!({"repository":"owner/repo","number":7});
        assert_eq!(set_watch(&bus, &scope, &reference, false).unwrap()["wasWatching"], true);
        assert_eq!(set_watch(&bus, &scope, &reference, false).unwrap()["wasWatching"], false);
        assert_eq!(set_watch(&bus, &scope, &reference, true).unwrap()["watching"], true);
        bus.with_autocommit(|db| {
            db.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.activeProviderThreadId',(SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads WHERE thread_id='t')) WHERE thread_id='t'", []).unwrap();
        }).unwrap();
        assert_eq!(bus.with_autocommit(live_watch_keys).unwrap().unwrap(), vec![key.clone()]);
        let open = json!({"state":"open","title":"Change","headBranch":"a","baseBranch":"b","updatedAt":at});
        bus.with_autocommit(|db| {
            db.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(json_remove(payload_json,'$.pullRequests[0].watch.awaitingBaseline'),'$.pullRequests[0].watch.headSha','abc','$.pullRequests[0].watch.remarksThrough',?1) WHERE thread_id='t'", [at]).unwrap();
        }).unwrap();
        let replaced = sync_report_with_details(
            &bus, &key, |_| Some(open.clone()), |_| Some(Value::Null),
            |_| {
                bus.with_autocommit(|db| {
                    db.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.pullRequests[0].watch.startedAt',?1) WHERE thread_id='t'", [at]).unwrap();
                }).unwrap();
                Some(json!({"state":"open","headSha":"abc","checks":[{"name":"stale","status":"failure"}]}))
            },
            |_| None,
        );
        assert!(!replaced.failed);
        bus.with_autocommit(|db| {
            let count: i64 = db.query_row(
                "SELECT count(*) FROM orchestration_v2_projection_messages WHERE thread_id='t' AND json_extract(payload_json,'$.notification.source.kind')='monitor'",
                [], |row| row.get(0)
            ).unwrap();
            assert_eq!(count, 0);
        }).unwrap();
        for _ in 0..2 {
            let result = sync_report_with_details(
                &bus, &key, |_| Some(open.clone()), |_| Some(Value::Null),
                |_| Some(json!({"state":"open","headSha":"abc","checks":[{"name":"build","status":"failure"}]})),
                |_| Some(json!({"viewer":"me","comments":[{"id":"remark","createdAt":at,"author":{"login":"reviewer"}}]})),
            );
            assert!(!result.failed);
        }
        bus.with_autocommit(|db| {
            let (count, summary): (i64, String) = db.query_row(
                "SELECT count(*), min(json_extract(payload_json,'$.notification.summary')) FROM orchestration_v2_projection_messages WHERE thread_id='t' AND json_extract(payload_json,'$.notification.source.kind')='monitor'",
                [], |row| Ok((row.get(0)?, row.get(1)?))
            ).unwrap();
            assert_eq!(count, 1);
            assert_eq!(summary, "#7: checks failed; new remarks");
        }).unwrap();
        let summary = json!({"state":"closed","title":"Change","headBranch":"a","baseBranch":"b","isDraft":false,"updatedAt":at,"closedAt":at,"mergedAt":null});
        bus.with_autocommit(|db| {
            db.execute_batch("CREATE TRIGGER reject_monitor_message BEFORE INSERT ON orchestration_v2_projection_messages
                WHEN json_extract(NEW.payload_json,'$.notification.source.kind')='monitor'
                BEGIN SELECT RAISE(ABORT, 'fixture rejects monitor notifications'); END;").unwrap();
        }).unwrap();
        assert!(sync_report_with(&bus, &key, |_| Some(summary.clone()), |_| Some(Value::Null)).failed);
        bus.with_autocommit(|db| {
            let state: (i64, Option<String>) = db.query_row(
                "SELECT json_extract(payload_json,'$.pullRequests[0].watch.checksPending'), json_extract(payload_json,'$.pullRequests[0].snapshot.state') FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [], |row| Ok((row.get(0)?, row.get(1)?))
            ).unwrap();
            assert_eq!(state, (0, Some("open".into())));
            db.execute_batch("DROP TRIGGER reject_monitor_message;").unwrap();
        }).unwrap();
        // A failed stack read still schedules the wake from the verified closed summary.
        assert!(sync_report_with(&bus, &key, |_| Some(summary.clone()), |_| None).failed);
        for _ in 0..2 {
            assert!(!sync_report_with(&bus, &key, |_| Some(summary.clone()), |_| Some(Value::Null)).failed);
        }
        bus.with_autocommit(|db| {
            let (watch, ended): (Option<i64>, i64) = db.query_row(
                "SELECT json_extract(payload_json,'$.pullRequests[0].watch.checksPending'), json_extract(payload_json,'$.pullRequests[0].endedWatch.checksPending') FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [], |row| Ok((row.get(0)?, row.get(1)?))
            ).unwrap();
            assert_eq!((watch, ended), (None, 0));
            assert!(live_watch_keys(db).unwrap().is_empty());
            let (count, summary): (i64, String) = db.query_row(
                "SELECT count(*), min(json_extract(payload_json,'$.notification.summary')) FROM orchestration_v2_projection_messages WHERE thread_id='t' AND json_extract(payload_json,'$.notification.source.kind')='monitor' AND json_extract(payload_json,'$.notification.summary') LIKE '%stopped watching'",
                [], |row| Ok((row.get(0)?, row.get(1)?))
            ).unwrap();
            assert_eq!(count, 1);
            assert_eq!(summary, "#7: closed, stopped watching");
        }).unwrap();
    }

    #[test]
    fn refreshes_matching_links_and_ends_merged_watches_once() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","updatedAt":"old","pullRequests":[{"host":"GitHub.com","repository":"Owner/Repo","number":7,"source":"manual","watch":{"checksPending":true},"snapshot":null,"stack":null},{"host":"github.com","repository":"owner/repo","number":8,"source":"manual","snapshot":null}]});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','old',?1)", [thread.to_string()]).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let key = json!({"host":"github.com","repository":"owner/repo","number":7});
        let mut summary = json!({"state":"open","title":"Change","headBranch":"a","baseBranch":"b","isDraft":false,"updatedAt":"time","closedAt":null,"mergedAt":null});
        let mut count = 0;
        for state in ["open", "merged", "merged"] {
            summary["state"] = json!(state);
            if state == "merged" {
                summary["mergedAt"] = json!("time");
            }
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
            if state == "open" {
                bus.with_autocommit(|db| {
                    let raw: String = db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'", [], |r| r.get(0)).unwrap();
                    let thread: Value = serde_json::from_str(&raw).unwrap();
                    assert_eq!(thread["pullRequests"][0]["watch"]["checksPending"], true);
                }).unwrap();
            }
        }
        assert_eq!(count, 3);
        bus.with_autocommit(|db| {
            let raw: String = db.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'", [], |r| r.get(0)).unwrap();
            let thread: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(thread["pullRequests"][0]["snapshot"]["state"], "merged");
            assert!(thread["pullRequests"][0].get("watch").is_none());
            assert_eq!(thread["pullRequests"][0]["endedWatch"]["checksPending"], true);
            assert!(thread["pullRequests"][1]["snapshot"].is_null());
            let events: i64 = db.query_row("SELECT count(*) FROM orchestration_events WHERE event_type='thread.pull-request-link-updated'", [], |r| r.get(0)).unwrap();
            assert_eq!(events, 2);
            let event_raw: String = db.query_row("SELECT payload_json FROM orchestration_events WHERE event_type='thread.pull-request-link-updated' ORDER BY sequence DESC LIMIT 1", [], |r| r.get(0)).unwrap();
            let event: Value = serde_json::from_str(&event_raw).unwrap();
            assert_eq!(event, thread["pullRequests"][0]);
            assert_eq!(thread["updatedAt"], "old");
        }).unwrap();
    }
}
