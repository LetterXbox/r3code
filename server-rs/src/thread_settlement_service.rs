//! Background automatic thread settlement service (`threadAutoSettlement` & `threadAutoSettlementScope`).

use crate::event_bus::EventBus;
use crate::settings::Settings;
use crate::terminal::TerminalManager;
use crate::thread_lifecycle::{self, Lifecycle};
use chrono::{DateTime, Utc};
use rusqlite::params;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1_000.0;
const QUEUED_TURN_START_GRACE_MS: i64 = 2 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedSettlementSettings {
    pub auto_settle_after_days: Option<f64>,
    pub auto_settle_on_merge: bool,
    pub auto_settle_keep_pull_requests: bool,
}

#[derive(Debug, Clone)]
pub struct SettlementPullRequest {
    pub state: String,
    pub closed_at: Option<String>,
    pub merged_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SettlementCandidate {
    pub id: String,
    pub project_id: String,
    pub created_at_ms: i64,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub settled_override: Option<String>,
    pub pinned_at: Option<String>,
    pub auto_settle_disabled_at: Option<String>,
    pub snoozed_at_ms: Option<i64>,
    pub snoozed_until_ms: Option<i64>,
    pub last_snooze_wake_at_ms: Option<i64>,
    pub status: String,
    pub latest_run_id: Option<String>,
    pub latest_run_requested_at_ms: Option<i64>,
    pub latest_run_started_at_ms: Option<i64>,
    pub latest_run_completed_at_ms: Option<i64>,
    pub latest_user_message_at_ms: Option<i64>,
    pub latest_user_authored_message_at_ms: Option<i64>,
    pub pending_runtime_request_kind: Option<String>,
    pub pending_runtime_request_created_at_ms: Option<i64>,
    pub pending_guest_message_count: i64,
    pub has_active_run: bool,
    pub has_holding_background_work: bool,
    pub has_pr_watch_task: bool,
    pub pull_requests: Vec<Value>,
    pub has_linked_or_branch_pr: bool,
    pub is_subagent: bool,
}

pub fn resolve_project_settlement_settings(
    settings: &Value,
    project_id: &str,
) -> ResolvedSettlementSettings {
    let global_after_days = match settings.get("sidebarAutoSettleAfterDays") {
        Some(Value::Null) => None,
        Some(v) => v.as_f64().filter(|n| n.is_finite()),
        None => Some(7.0),
    };
    let global_on_merge = settings
        .get("sidebarAutoSettleOnMerge")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let global_keep_prs = settings
        .get("sidebarAutoSettleKeepPullRequests")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let project_override = settings
        .get("projectSettingsOverrides")
        .and_then(|m| m.get(project_id))
        .and_then(Value::as_object);

    let auto_settle_after_days = match project_override.and_then(|o| o.get("sidebarAutoSettleAfterDays")) {
        Some(Value::Null) => None,
        Some(v) => v.as_f64().filter(|n| n.is_finite()).or(global_after_days),
        None => global_after_days,
    };
    let auto_settle_on_merge = project_override
        .and_then(|o| o.get("sidebarAutoSettleOnMerge"))
        .and_then(Value::as_bool)
        .unwrap_or(global_on_merge);
    let auto_settle_keep_pull_requests = project_override
        .and_then(|o| o.get("sidebarAutoSettleKeepPullRequests"))
        .and_then(Value::as_bool)
        .unwrap_or(global_keep_prs);

    ResolvedSettlementSettings {
        auto_settle_after_days,
        auto_settle_on_merge,
        auto_settle_keep_pull_requests,
    }
}

pub fn auto_settlement_configured(settings: &Value) -> bool {
    let global = resolve_project_settlement_settings(settings, "");
    if global.auto_settle_on_merge || global.auto_settle_after_days.is_some() {
        return true;
    }
    settings
        .get("projectSettingsOverrides")
        .and_then(Value::as_object)
        .is_some_and(|overrides| {
            overrides.values().any(|entry| {
                entry.get("sidebarAutoSettleOnMerge") == Some(&Value::Bool(true))
                    || entry
                        .get("sidebarAutoSettleAfterDays")
                        .is_some_and(|v| v.as_f64().is_some_and(|n| n.is_finite()))
            })
        })
}

pub fn auto_settlement_settings_key(settings: &Value) -> String {
    let global_on_merge = settings
        .get("sidebarAutoSettleOnMerge")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let global_after_days = settings
        .get("sidebarAutoSettleAfterDays")
        .cloned()
        .unwrap_or(Value::from(7));
    let global_keep_prs = settings
        .get("sidebarAutoSettleKeepPullRequests")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut per_project = BTreeMap::new();
    if let Some(overrides) = settings
        .get("projectSettingsOverrides")
        .and_then(Value::as_object)
    {
        for (project_id, entry) in overrides {
            let on_merge = entry.get("sidebarAutoSettleOnMerge");
            let after_days = entry.get("sidebarAutoSettleAfterDays");
            let keep_prs = entry.get("sidebarAutoSettleKeepPullRequests");
            if on_merge.is_some() || after_days.is_some() || keep_prs.is_some() {
                per_project.insert(
                    project_id.clone(),
                    serde_json::json!([
                        on_merge.cloned().unwrap_or(Value::String("inherit".into())),
                        after_days.cloned().unwrap_or(Value::String("inherit".into())),
                        keep_prs.cloned().unwrap_or(Value::String("inherit".into())),
                    ]),
                );
            }
        }
    }

    serde_json::json!([
        global_on_merge,
        global_after_days,
        global_keep_prs,
        per_project
    ])
    .to_string()
}

fn parse_ms(s: Option<&str>) -> Option<i64> {
    s.and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| dt.timestamp_millis())
}

fn latest_millis(values: &[Option<i64>]) -> Option<i64> {
    values.iter().copied().flatten().max()
}

pub fn thread_has_queued_turn_start(candidate: &SettlementCandidate, now_ms: i64) -> bool {
    let Some(message_at_ms) = candidate.latest_user_message_at_ms else {
        return false;
    };
    if candidate.status == "failed" {
        return false;
    }
    let age = now_ms - message_at_ms;
    if age.abs() > QUEUED_TURN_START_GRACE_MS {
        return false;
    }
    if candidate.latest_run_id.is_none() {
        return true;
    }
    [
        candidate.latest_run_requested_at_ms,
        candidate.latest_run_started_at_ms,
        candidate.latest_run_completed_at_ms,
    ]
    .into_iter()
    .all(|val| val.is_none_or(|v| v < message_at_ms))
}

pub fn is_snoozed(candidate: &SettlementCandidate, now_ms: i64) -> bool {
    let Some(snoozed_until_ms) = candidate.snoozed_until_ms else {
        return false;
    };
    if snoozed_until_ms <= now_ms {
        return false;
    }
    if candidate.pending_guest_message_count > 0 {
        return false;
    }
    if let Some(ref kind) = candidate.pending_runtime_request_kind {
        let woke_on_request = kind != "user_input"
            || candidate.snoozed_at_ms.is_none()
            || candidate
                .pending_runtime_request_created_at_ms
                .zip(candidate.snoozed_at_ms)
                .is_some_and(|(req, snz)| req > snz);
        if woke_on_request {
            return false;
        }
    }
    let woke_on_error = candidate.status == "failed"
        && (candidate.snoozed_at_ms.is_none()
            || candidate
                .latest_run_completed_at_ms
                .zip(candidate.snoozed_at_ms)
                .is_some_and(|(done, snz)| done > snz));
    !woke_on_error
}

pub fn is_auto_settlement_candidate(candidate: &SettlementCandidate, now_ms: i64) -> bool {
    if candidate.archived_at.is_some() || candidate.settled_override.is_some() {
        return false;
    }
    if candidate.pinned_at.is_some() || candidate.auto_settle_disabled_at.is_some() {
        return false;
    }
    if candidate.pending_runtime_request_kind.is_some() {
        return false;
    }
    if candidate.pending_guest_message_count > 0 {
        return false;
    }
    if candidate.has_active_run
        || candidate.has_holding_background_work
        || candidate.has_pr_watch_task
    {
        return false;
    }
    if thread_has_queued_turn_start(candidate, now_ms) {
        return false;
    }
    !is_snoozed(candidate, now_ms)
}

fn link_terminal_at_ms(link: &Value) -> Option<i64> {
    let snapshot = link.get("snapshot")?;
    let state = snapshot.get("state").and_then(Value::as_str)?;
    let ts = if state == "merged" {
        snapshot.get("mergedAt").and_then(Value::as_str)
    } else {
        snapshot.get("closedAt").and_then(Value::as_str)
    };
    parse_ms(ts)
}

fn visible_settlement_pr_links(links: &[Value]) -> Vec<&Value> {
    links
        .iter()
        .filter(|link| link.get("source").and_then(Value::as_str) != Some("stack-dismissed"))
        .filter(|link| {
            let snapshot = link.get("snapshot");
            let is_open_or_none = snapshot.is_none_or(|s| {
                s.is_null() || s.get("state").and_then(Value::as_str) == Some("open")
            });
            if is_open_or_none {
                return true;
            }
            let linked_at = parse_ms(link.get("linkedAt").and_then(Value::as_str));
            match (linked_at, link_terminal_at_ms(link)) {
                (Some(la), Some(ta)) => ta >= la,
                (None, _) => true,
                (Some(_), None) => false,
            }
        })
        .collect()
}

fn pull_request_settles(
    candidate: &SettlementCandidate,
    pr: &SettlementPullRequest,
    auto_settle_on_merge: bool,
) -> bool {
    if pr.state != "closed" && (pr.state != "merged" || !auto_settle_on_merge) {
        return false;
    }
    let terminal_at = if pr.state == "merged" {
        pr.merged_at.as_deref()
    } else {
        pr.closed_at.as_deref()
    };
    let Some(pr_at_ms) = parse_ms(terminal_at) else {
        return false;
    };
    let Some(user_anchor_ms) = latest_millis(&[
        Some(candidate.created_at_ms),
        candidate.latest_user_authored_message_at_ms,
    ]) else {
        return false;
    };
    pr_at_ms >= user_anchor_ms
}

pub fn resolve_auto_settlement_at(
    candidate: &SettlementCandidate,
    external_pr: Option<&SettlementPullRequest>,
    now_ms: i64,
    settings: &ResolvedSettlementSettings,
) -> Option<i64> {
    let links = visible_settlement_pr_links(&candidate.pull_requests);
    if links
        .iter()
        .any(|l| l.get("snapshot").is_none_or(Value::is_null))
    {
        return None;
    }
    let has_open_link = links
        .iter()
        .any(|l| l.get("snapshot").and_then(|s| s.get("state")).and_then(Value::as_str) == Some("open"));

    let resolved_pr_owned: Option<SettlementPullRequest>;
    let pr: Option<&SettlementPullRequest> = if has_open_link {
        None
    } else if !links.is_empty() {
        let latest = links
            .iter()
            .max_by_key(|l| link_terminal_at_ms(l).unwrap_or(i64::MIN))?;
        let snap = latest.get("snapshot")?;
        resolved_pr_owned = Some(SettlementPullRequest {
            state: snap.get("state").and_then(Value::as_str)?.to_owned(),
            merged_at: snap.get("mergedAt").and_then(Value::as_str).map(str::to_owned),
            closed_at: snap.get("closedAt").and_then(Value::as_str).map(str::to_owned),
        });
        resolved_pr_owned.as_ref()
    } else {
        external_pr
    };

    if !is_auto_settlement_candidate(candidate, now_ms) {
        return None;
    }

    let activity_at_ms = latest_millis(&[
        candidate.latest_user_message_at_ms,
        candidate.latest_run_requested_at_ms,
        candidate.latest_run_started_at_ms,
        candidate.latest_run_completed_at_ms,
    ])
    .unwrap_or(candidate.created_at_ms);

    if let Some(pr_ref) = pr {
        if pull_request_settles(candidate, pr_ref, settings.auto_settle_on_merge) {
            return Some(activity_at_ms);
        }
    }

    let has_pull_request = has_open_link || pr.is_some() || candidate.has_linked_or_branch_pr;
    if settings.auto_settle_keep_pull_requests && has_pull_request {
        return None;
    }
    let after_days = settings.auto_settle_after_days?;
    let timer_wake_at_ms = candidate
        .snoozed_until_ms
        .filter(|&until_ms| until_ms <= now_ms);
    let inactivity_at_ms = latest_millis(&[
        Some(activity_at_ms),
        candidate.last_snooze_wake_at_ms,
        timer_wake_at_ms,
    ])
    .unwrap_or(activity_at_ms);

    let cutoff_ms = now_ms as f64 - after_days * DAY_MS;
    if (inactivity_at_ms as f64) < cutoff_ms {
        Some(inactivity_at_ms)
    } else {
        None
    }
}

#[derive(Clone, Default)]
pub struct ThreadSettlementService;

impl ThreadSettlementService {
    pub fn new() -> Self {
        Self
    }

    pub fn sweep(&self, bus: &EventBus, settings: &Settings, target_thread_id: Option<&str>) {
        let settings_snapshot = settings.snapshot();
        let automatic_enabled = auto_settlement_configured(&settings_snapshot);
        let now_ms = Utc::now().timestamp_millis();

        let candidates = match load_settlement_candidates(bus, target_thread_id) {
            Ok(list) => list,
            Err(_) => return,
        };

        for candidate in candidates {
            if !automatic_enabled && !candidate.is_subagent {
                continue;
            }
            if !is_auto_settlement_candidate(&candidate, now_ms) {
                continue;
            }

            let settled_at_iso = if candidate.is_subagent {
                None
            } else {
                let resolved_settings =
                    resolve_project_settlement_settings(&settings_snapshot, &candidate.project_id);
                let Some(settled_at_ms) =
                    resolve_auto_settlement_at(&candidate, None, now_ms, &resolved_settings)
                else {
                    continue;
                };
                DateTime::from_timestamp_millis(settled_at_ms)
                    .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            };

            let command_id = format!(
                "server:auto-settle:{}:{}",
                candidate.id,
                uuid::Uuid::new_v4()
            );
            let now_iso = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let expected_run = candidate.latest_run_id.clone();
            let expected_updated = candidate.updated_at.clone();

            let _ = thread_lifecycle::dispatch_checked(
                bus,
                &command_id,
                &candidate.id,
                Lifecycle::Settle {
                    expected_latest_run_id: expected_run.as_deref(),
                    settled_at: settled_at_iso.as_deref(),
                },
                &now_iso,
                |tx| {
                    let current_updated: Option<String> = tx
                        .query_row(
                            "SELECT updated_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",
                            params![candidate.id],
                            |r| r.get(0),
                        )
                        .ok();
                    if current_updated.as_deref() != Some(expected_updated.as_str()) {
                        return Err(rusqlite::Error::InvalidQuery);
                    }
                    Ok(())
                },
            );
        }
    }

    pub fn start(
        &self,
        bus: Arc<EventBus>,
        settings: Arc<Settings>,
        terminals: Option<Arc<TerminalManager>>,
    ) {
        // Periodic 1-minute sweep
        let service_periodic = self.clone();
        let bus_periodic = bus.clone();
        let settings_periodic = settings.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let s = service_periodic.clone();
                let b = bus_periodic.clone();
                let st = settings_periodic.clone();
                let _ = tokio::task::spawn_blocking(move || s.sweep(&b, &st, None)).await;
            }
        });

        // Settings-change listener
        let service_settings = self.clone();
        let bus_settings = bus.clone();
        let settings_watch = settings.clone();
        let mut settings_rx = settings.subscribe();
        let mut last_key = auto_settlement_settings_key(&settings.snapshot());
        tokio::spawn(async move {
            loop {
                match settings_rx.recv().await {
                    Ok(snapshot) => {
                        let next_key = auto_settlement_settings_key(&snapshot);
                        if next_key != last_key {
                            last_key = next_key;
                            let s = service_settings.clone();
                            let b = bus_settings.clone();
                            let st = settings_watch.clone();
                            let _ =
                                tokio::task::spawn_blocking(move || s.sweep(&b, &st, None)).await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let snapshot = settings_watch.snapshot();
                        let next_key = auto_settlement_settings_key(&snapshot);
                        if next_key != last_key {
                            last_key = next_key;
                            let s = service_settings.clone();
                            let b = bus_settings.clone();
                            let st = settings_watch.clone();
                            let _ =
                                tokio::task::spawn_blocking(move || s.sweep(&b, &st, None)).await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        // EventBus domain-event listener
        let service_events = self.clone();
        let bus_events = bus.clone();
        let settings_events = settings;
        let latest_seq = bus
            .commit(|tx| Ok((crate::event_store::latest_thread_sequence(tx, None)?, vec![])))
            .unwrap_or(0);
        let Ok(mut events_rx) = bus.subscribe(latest_seq, crate::event_bus::Filter::default()) else {
            return;
        };
        tokio::spawn(async move {
            while let Ok(stored) = events_rx.next().await {
                let event = stored.event;
                        let thread_id = event.stream_id.clone();
                        match event.event_type.as_str() {
                            "thread.settled" => {
                                if let Some(ref tm) = terminals {
                                    let _ = tm.dispatch(
                                        "terminal.close",
                                        &serde_json::json!({ "threadId": thread_id }),
                                    );
                                }
                                let s = service_events.clone();
                                let b = bus_events.clone();
                                let st = settings_events.clone();
                                let _ =
                                    tokio::task::spawn_blocking(move || s.sweep(&b, &st, None))
                                        .await;
                            }
                            "thread.archived" | "thread.deleted" => {
                                let s = service_events.clone();
                                let b = bus_events.clone();
                                let st = settings_events.clone();
                                let _ =
                                    tokio::task::spawn_blocking(move || s.sweep(&b, &st, None))
                                        .await;
                            }
                            "thread.pull-request-link-updated"
                            | "thread.pull-request-synced"
                            | "provider-session.detached"
                            | "run.background-work-cancelled" => {
                                let s = service_events.clone();
                                let b = bus_events.clone();
                                let st = settings_events.clone();
                                let _ = tokio::task::spawn_blocking(move || {
                                    s.sweep(&b, &st, Some(&thread_id))
                                })
                                .await;
                            }
                            "run.updated" => {
                                let status = event
                                    .payload
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                if matches!(
                                    status,
                                    "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back"
                                ) {
                                    let s = service_events.clone();
                                    let b = bus_events.clone();
                                    let st = settings_events.clone();
                                    let _ = tokio::task::spawn_blocking(move || {
                                        s.sweep(&b, &st, Some(&thread_id))
                                    })
                                    .await;
                                }
                            }
                            "provider-session.updated" => {
                                let status = event
                                    .payload
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                if !matches!(status, "starting" | "running") {
                                    let s = service_events.clone();
                                    let b = bus_events.clone();
                                    let st = settings_events.clone();
                                    let _ = tokio::task::spawn_blocking(move || {
                                        s.sweep(&b, &st, Some(&thread_id))
                                    })
                                    .await;
                                }
                            }
                            "subagent.updated" => {
                                let status = event
                                    .payload
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                if !matches!(
                                    status,
                                    "preparing" | "starting" | "running" | "waiting" | "queued"
                                ) {
                                    let s = service_events.clone();
                                    let b = bus_events.clone();
                                    let st = settings_events.clone();
                                    let _ = tokio::task::spawn_blocking(move || {
                                        s.sweep(&b, &st, Some(&thread_id))
                                    })
                                    .await;
                                }
                            }
                            _ => {}
                        }
            }
        });
    }
}

fn load_settlement_candidates(
    bus: &EventBus,
    target_thread_id: Option<&str>,
) -> Result<Vec<SettlementCandidate>, crate::event_bus::BusError> {
    bus.commit(|tx| {
        let mut parent_done_map: HashMap<String, bool> = HashMap::new();
        {
            let mut stmt = tx.prepare(
                "SELECT thread_id, archived_at, deleted_at, json_extract(payload_json,'$.settledOverride') \
                 FROM orchestration_v2_projection_threads",
            )?;
            let rows = stmt.query_map([], |r| {
                let id: String = r.get(0)?;
                let archived: Option<String> = r.get(1)?;
                let deleted: Option<String> = r.get(2)?;
                let settled: Option<String> = r.get(3)?;
                Ok((
                    id,
                    archived.is_some() || deleted.is_some() || settled.as_deref() == Some("settled"),
                ))
            })?;
            for row in rows {
                let (id, done) = row?;
                parent_done_map.insert(id, done);
            }
        }

        let sql = if target_thread_id.is_some() {
            "SELECT thread_id, project_id, updated_at, payload_json \
             FROM orchestration_v2_projection_threads \
             WHERE deleted_at IS NULL AND archived_at IS NULL \
             AND COALESCE(json_extract(payload_json,'$.settledOverride'),'') = '' \
             AND thread_id = ?1"
        } else {
            "SELECT thread_id, project_id, updated_at, payload_json \
             FROM orchestration_v2_projection_threads \
             WHERE deleted_at IS NULL AND archived_at IS NULL \
             AND COALESCE(json_extract(payload_json,'$.settledOverride'),'') = ''"
        };
        let mut stmt = tx.prepare(sql)?;
        let rows: Vec<(String, String, String, String)> = if let Some(tid) = target_thread_id {
            stmt.query_map([tid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<Vec<_>, _>>()?
        };
        drop(stmt);

        let mut candidates = Vec::new();
        for (thread_id, project_id, updated_at, raw) in rows {
            let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let relationship = payload
                .get("lineage")
                .and_then(|l| l.get("relationshipToParent"))
                .and_then(Value::as_str);
            let is_subagent = relationship == Some("subagent");
            if is_subagent {
                let parent_id = payload
                    .get("lineage")
                    .and_then(|l| l.get("parentThreadId"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if parent_done_map.get(parent_id).copied() != Some(true) {
                    continue;
                }
            }

            let created_at_ms = parse_ms(payload.get("createdAt").and_then(Value::as_str))
                .or_else(|| parse_ms(Some(&updated_at)))
                .unwrap_or(0);

            type LatestRunRow = (String, String, Option<String>, Option<String>, Option<String>);
            let latest_run: Option<LatestRunRow> = tx
                .query_row(
                    "SELECT run_id, status, \
                     json_extract(payload_json,'$.requestedAt'), \
                     json_extract(payload_json,'$.startedAt'), \
                     json_extract(payload_json,'$.completedAt') \
                     FROM orchestration_v2_projection_runs \
                     WHERE thread_id=?1 ORDER BY ordinal DESC LIMIT 1",
                    [&thread_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .ok();

            let has_active_run: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting'))",
                [&thread_id],
                |r| r.get(0),
            )?;

            let pending_req: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT kind, created_at FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending' ORDER BY created_at LIMIT 1",
                    [&thread_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();

            let latest_user_msg_at: Option<String> = tx
                .query_row(
                    "SELECT created_at FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND role='user' ORDER BY ordinal DESC LIMIT 1",
                    [&thread_id],
                    |r| r.get(0),
                )
                .ok();

            let latest_user_authored_at: Option<String> = tx
                .query_row(
                    "SELECT created_at FROM orchestration_v2_projection_messages \
                     WHERE thread_id=?1 AND role='user' \
                     AND COALESCE(json_type(payload_json,'$.notification'),'null')='null' \
                     AND COALESCE(json_type(payload_json,'$.delegatedCompletion'),'null')='null' \
                     ORDER BY ordinal DESC LIMIT 1",
                    [&thread_id],
                    |r| r.get(0),
                )
                .ok();

            let pull_requests = payload
                .get("pullRequests")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let has_pr_watch_task = pull_requests
                .iter()
                .any(|link| link.get("watch").is_some_and(|w| !w.is_null()));
            let has_linked_or_branch_pr = payload
                .get("linkedPullRequest")
                .is_some_and(|v| !v.is_null())
                || payload
                    .get("branchPullRequest")
                    .is_some_and(|v| !v.is_null());

            let (
                latest_run_id,
                run_status,
                latest_run_requested_at_ms,
                latest_run_started_at_ms,
                latest_run_completed_at_ms,
            ) = match latest_run {
                Some((id, st, req, sta, comp)) => (
                    Some(id),
                    st,
                    parse_ms(req.as_deref()),
                    parse_ms(sta.as_deref()),
                    parse_ms(comp.as_deref()),
                ),
                None => (None, "idle".to_owned(), None, None, None),
            };

            candidates.push(SettlementCandidate {
                id: thread_id,
                project_id,
                created_at_ms,
                updated_at,
                archived_at: payload
                    .get("archivedAt")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                settled_override: payload
                    .get("settledOverride")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                pinned_at: payload
                    .get("pinnedAt")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                auto_settle_disabled_at: payload
                    .get("autoSettleDisabledAt")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                snoozed_at_ms: parse_ms(payload.get("snoozedAt").and_then(Value::as_str)),
                snoozed_until_ms: parse_ms(payload.get("snoozedUntil").and_then(Value::as_str)),
                last_snooze_wake_at_ms: parse_ms(
                    payload.get("lastSnoozeWakeAt").and_then(Value::as_str),
                ),
                status: run_status,
                latest_run_id,
                latest_run_requested_at_ms,
                latest_run_started_at_ms,
                latest_run_completed_at_ms,
                latest_user_message_at_ms: parse_ms(latest_user_msg_at.as_deref()),
                latest_user_authored_message_at_ms: parse_ms(latest_user_authored_at.as_deref()),
                pending_runtime_request_kind: pending_req.as_ref().map(|(k, _)| k.clone()),
                pending_runtime_request_created_at_ms: pending_req
                    .as_ref()
                    .and_then(|(_, c)| parse_ms(c.as_deref())),
                pending_guest_message_count: payload
                    .get("pendingGuestMessageCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                has_active_run,
                has_holding_background_work: false,
                has_pr_watch_task,
                pull_requests,
                has_linked_or_branch_pr,
                is_subagent,
            });
        }

        Ok((candidates, vec![]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "t3code-settle-test-{name}-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn insert_thread(bus: &EventBus, id: &str, project_id: &str, payload: Value) {
        let updated = payload["updatedAt"]
            .as_str()
            .unwrap_or("2020-01-01T00:00:00Z")
            .to_owned();
        let model = json!({"instanceId": "codex", "model": "gpt-5"});
        let source = json!("web");
        crate::thread_commands::create_thread_ordered(
            bus,
            crate::thread_commands::CreateThread {
                command_id: &format!("create-{id}"),
                thread_id: id,
                project_id,
                title: "Test",
                model_selection: &model,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            &format!("event-{id}"),
            &updated,
        )
        .unwrap();
        bus.commit(|tx| {
            tx.execute(
                "UPDATE orchestration_v2_projection_threads SET updated_at=?2, payload_json=?3 WHERE thread_id=?1",
                params![id, updated, payload.to_string()],
            )?;
            Ok(((), vec![]))
        })
        .unwrap();
    }

    #[test]
    fn resolves_project_settings_overrides_for_auto_settlement_scope() {
        let settings = json!({
            "sidebarAutoSettleOnMerge": true,
            "sidebarAutoSettleAfterDays": 7,
            "sidebarAutoSettleKeepPullRequests": false,
            "projectSettingsOverrides": {
                "proj-a": {
                    "sidebarAutoSettleOnMerge": false,
                    "sidebarAutoSettleAfterDays": null,
                    "sidebarAutoSettleKeepPullRequests": true
                }
            }
        });

        let global = resolve_project_settlement_settings(&settings, "proj-other");
        assert!(global.auto_settle_on_merge);
        assert_eq!(global.auto_settle_after_days, Some(7.0));
        assert!(!global.auto_settle_keep_pull_requests);

        let scoped = resolve_project_settlement_settings(&settings, "proj-a");
        assert!(!scoped.auto_settle_on_merge);
        assert_eq!(scoped.auto_settle_after_days, None);
        assert!(scoped.auto_settle_keep_pull_requests);
    }

    #[test]
    fn sweep_settles_inactive_and_merged_threads_respecting_project_scope() {
        let dir = temp_dir("sweep");
        let mut db = database::open_writer(&dir.join("db.sqlite")).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let settings = Settings::new(dir.join("settings.json"));
        settings
            .update(&json!({
                "sidebarAutoSettleOnMerge": true,
                "sidebarAutoSettleAfterDays": 7,
                "projectSettingsOverrides": {
                    "proj-disabled": {
                        "sidebarAutoSettleOnMerge": false,
                        "sidebarAutoSettleAfterDays": null
                    }
                }
            }))
            .unwrap();

        insert_thread(
            &bus,
            "t-old",
            "proj-default",
            json!({
                "id": "t-old",
                "projectId": "proj-default",
                "createdAt": "2020-01-01T00:00:00Z",
                "updatedAt": "2020-01-01T00:00:00Z",
                "archivedAt": null,
                "settledOverride": null,
                "pullRequests": []
            }),
        );
        insert_thread(
            &bus,
            "t-opt-out",
            "proj-default",
            json!({
                "id": "t-opt-out",
                "projectId": "proj-default",
                "createdAt": "2020-01-01T00:00:00Z",
                "updatedAt": "2020-01-01T00:00:00Z",
                "archivedAt": null,
                "settledOverride": null,
                "autoSettleDisabledAt": "2020-01-02T00:00:00Z",
                "pullRequests": []
            }),
        );
        insert_thread(
            &bus,
            "t-scoped-off",
            "proj-disabled",
            json!({
                "id": "t-scoped-off",
                "projectId": "proj-disabled",
                "createdAt": "2020-01-01T00:00:00Z",
                "updatedAt": "2020-01-01T00:00:00Z",
                "archivedAt": null,
                "settledOverride": null,
                "pullRequests": [{
                    "host": "github.com",
                    "repository": "a/b",
                    "number": 1,
                    "source": "manual",
                    "linkedAt": "2020-01-01T00:00:00Z",
                    "snapshot": { "state": "merged", "mergedAt": "2020-01-02T00:00:00Z" }
                }]
            }),
        );

        let service = ThreadSettlementService::new();
        service.sweep(&bus, &settings, None);

        let check_settled = |id: &str| -> Option<String> {
            bus.commit(|tx| {
                let v: Option<String> = tx.query_row(
                    "SELECT json_extract(payload_json,'$.settledOverride') FROM orchestration_v2_projection_threads WHERE thread_id=?1",
                    [id],
                    |r| r.get(0),
                )?;
                Ok((v, vec![]))
            })
            .unwrap()
        };

        assert_eq!(check_settled("t-old").as_deref(), Some("settled"));
        assert_eq!(check_settled("t-opt-out"), None);
        assert_eq!(check_settled("t-scoped-off"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
