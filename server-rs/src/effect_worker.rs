//! Durable outbox worker. Publishers must signal only after their transaction commits.
use crate::outbox::{self, Effect};
use rusqlite::Connection;
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{watch, Semaphore};

// Called under the event-bus transaction so a new run cannot become active
// between the durable reference check and the registry removal.
fn retire_unbound_shared_session(
    bus: &crate::event_bus::EventBus,
    sessions: &crate::provider::session_registry::SessionRegistry,
    id: &str,
) -> Result<bool, String> {
    bus.commit(|tx| {
        let bound: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id=?1)",[id],|r|r.get(0))?;
        if bound { return Ok((true,vec![])); }
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=r.provider_thread_id WHERE p.provider_session_id=?1 AND r.status IN ('preparing','starting','running','waiting'))",[id],|r|r.get(0))?;
        if active { return Ok((false,vec![])); }
        let Some(handle) = sessions.get(id).map_err(|_|rusqlite::Error::InvalidQuery)? else { return Ok((true,vec![])); };
        let removed = sessions.retire_if_idle(id,&handle).map_err(|_|rusqlite::Error::InvalidQuery)?;
        Ok((removed,vec![]))
    }).map_err(|e|e.to_string())
}

pub type Execution<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;
/// Side effects must be safe for the outbox's at-least-once delivery contract.
pub trait EffectExecutor: Send + Sync + 'static {
    fn execute<'a>(&'a self, effect: &'a Effect, will_retry: bool) -> Execution<'a>;
}

pub struct Signals {
    available: Mutex<usize>,
    available_tokens: Semaphore,
    cancellations: Mutex<HashMap<String, watch::Sender<bool>>>,
}
impl Default for Signals {
    fn default() -> Self {
        Self {
            available: Mutex::new(0),
            available_tokens: Semaphore::new(0),
            cancellations: Mutex::new(HashMap::new()),
        }
    }
}
impl Signals {
    pub fn available(&self) {
        self.available_count(1);
    }
    pub fn available_count(&self, count: usize) {
        let mut queued = self.available.lock().unwrap();
        let added = count.min(64 - *queued);
        *queued += added;
        self.available_tokens.add_permits(added);
    }
    async fn await_available(&self) {
        if let Ok(permit) = self.available_tokens.acquire().await {
            // Hold the count lock while consuming the permit, so publishers
            // cannot exceed the bounded queue during this transition.
            let mut queued = self.available.lock().unwrap();
            *queued -= 1;
            permit.forget();
        }
    }
    /// Call after cancellation is committed, never inside its transaction.
    pub fn cancelled(&self, ids: &[String]) {
        let mut signals = self.cancellations.lock().unwrap();
        for id in ids {
            if let Some(signal) = signals.get_mut(id) {
                signal.send_replace(true);
            }
        }
        self.available_count(ids.len());
    }
    pub fn active_ids(&self) -> Vec<String> {
        self.cancellations.lock().unwrap().keys().cloned().collect()
    }
    fn arm(&self, id: &str) -> watch::Receiver<bool> {
        self.cancellations
            .lock()
            .unwrap()
            .entry(id.to_owned())
            .or_insert_with(|| watch::channel(false).0)
            .subscribe()
    }
    fn clear(&self, id: &str) {
        self.cancellations.lock().unwrap().remove(id);
    }
}

/// Dispatch only effects whose execution and replay behavior are implemented.
pub struct RuntimeExecutor {
    pub bus: crate::event_bus::EventBus,
    pub provider: crate::provider::executor::CodexTurnExecutor,
    pub worktrees_dir: std::path::PathBuf,
    pub settings_path: std::path::PathBuf,
    pub terminals: Arc<crate::terminal::TerminalManager>,
}
impl EffectExecutor for RuntimeExecutor {
    fn execute<'a>(&'a self, effect: &'a Effect, will_retry: bool) -> Execution<'a> {
        Box::pin(async move {
            match effect.request["type"].as_str() {
                Some("provider-turn.start" | "provider-turn.interrupt" | "provider-turn.steer" | "provider-turn.restart") => {
                    if effect.request["type"]!="provider-turn.interrupt" {
                        let mode=self.bus.commit(|tx| {let mode:String=tx.query_row("SELECT runtime_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL",[&effect.thread_id],|r|r.get(0))?;Ok((mode,vec![]))}).map_err(|e|e.to_string())?;
                        crate::managed_policy::check_runtime_mode(&mode)?;
                    }
                    let driver = self.bus.commit(|tx| {
                        use rusqlite::OptionalExtension;
                        let driver: Option<String> = if let Some(id) = effect.request["providerThreadId"].as_str() {
                            tx.query_row("SELECT json_extract(payload_json,'$.driver') FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND thread_id=?2", rusqlite::params![id,effect.thread_id], |r|r.get(0)).optional()?.flatten()
                        } else if let Some(id) = effect.request["runId"].as_str() {
                            tx.query_row("SELECT json_extract(p.payload_json,'$.driver') FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=r.provider_thread_id WHERE r.run_id=?1 AND r.thread_id=?2",rusqlite::params![id,effect.thread_id],|r|r.get(0)).optional()?.flatten()
                        } else {None};
                        Ok((driver,vec![]))
                    }).map_err(|e|e.to_string())?;
                    if effect.request["type"]!="provider-turn.interrupt" {crate::managed_policy::check_provider_allowed(driver.as_deref().unwrap_or("codex"))?;}
                    if driver.as_deref() == Some("claudeAgent") {
                        return match effect.request["type"].as_str() {
                            Some("provider-turn.start") => crate::provider::claude_executor::start(self.bus.clone(),effect,&self.settings_path,&self.provider.attachments_dir,self.provider.mcp_endpoint.as_deref().map(|endpoint|(endpoint,self.provider.sessions.as_ref()))).await,
                            Some("provider-turn.steer") => crate::provider::claude_executor::steer(&self.bus,effect,&self.provider.attachments_dir).await,
                            Some("provider-turn.restart") => crate::provider::claude_executor::restart(self.bus.clone(),effect,&self.settings_path,&self.provider.attachments_dir,self.provider.mcp_endpoint.as_deref().map(|endpoint|(endpoint,self.provider.sessions.as_ref()))).await,
                            Some("provider-turn.interrupt") if effect.request.get("subagent").is_none() => crate::provider::claude_executor::interrupt(&effect.thread_id,effect.request["providerTurnId"].as_str().ok_or("Missing providerTurnId")?),
                            _ => Err("Claude steering and subagent interruption are not yet available".into()),
                        };
                    }
                    if matches!(driver.as_deref(),Some("fx" | "grok" | "kiro" | "acpRegistry" | "antigravity")) {
                        return crate::provider::acp_executor::execute(&self.bus,effect,Some(&self.settings_path),&self.provider.attachments_dir,&self.provider.sessions,self.provider.mcp_endpoint.as_deref().map(|endpoint|(endpoint,&self.provider.sessions))).await;
                    }
                    if driver.as_deref()==Some("pi") {
                        return match effect.request["type"].as_str() {
                            Some("provider-turn.start") => crate::provider::pi_executor::start(self.bus.clone(),effect,&self.settings_path,&self.provider.attachments_dir,self.provider.mcp_endpoint.as_deref().map(|endpoint|(endpoint,self.provider.sessions.as_ref()))).await,
                            Some("provider-turn.interrupt") if effect.request.get("subagent").is_none() => crate::provider::pi_executor::interrupt(&effect.thread_id,effect.request["providerTurnId"].as_str().ok_or("Missing providerTurnId")?).await,
                            _ => Err("Pi provider operation is not yet implemented".into()),
                        };
                    }
                    if driver.as_deref()==Some("opencode") {
                        return crate::provider::opencode_executor::execute(&self.bus,effect,Some(&self.settings_path),&self.provider.attachments_dir,self.provider.mcp_endpoint.as_deref().map(|endpoint|(endpoint,self.provider.sessions.as_ref()))).await;
                    }
                    if driver.as_deref()==Some("cursor") {
                        return crate::provider::cursor_executor::execute(&self.bus,effect,Some(&self.settings_path)).await;
                    }
                    if driver.as_deref()==Some("muse") {
                        if effect.request["type"] == "provider-turn.start" && std::env::var_os("T3CODE_EXPERIMENTAL_MUSE").as_deref()!=Some(std::ffi::OsStr::new("1")) {
                            return crate::provider::acp_executor::fail_provider_start(&self.bus,effect,"Muse turn execution is not yet available.");
                        }
                        return crate::provider::muse_executor::execute(&self.bus,effect,Some(&self.settings_path),self.provider.mcp_endpoint.as_deref().map(|endpoint|(endpoint,&self.provider.sessions))).await;
                    }
                    let result = self.provider.execute(effect, will_retry).await;
                    if effect.request["type"] == "provider-turn.interrupt" && result.as_ref().is_err_and(|e| e == "provider interrupt unresponsive") {
                        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        crate::interrupt_commands::mark_interrupt_unresponsive(&self.bus, effect, &now).map_err(|e| e.to_string())?;
                        return Ok(());
                    }
                    result?;
                    if effect.request["type"] == "provider-turn.interrupt" {
                        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        crate::interrupt_commands::settle_background_after_interrupt(&self.bus, &self.provider.sessions, effect, &now).map_err(|e| e.to_string())?;
                    }
                    Ok(())
                }
                Some("provider-runtime.continue") => {
                    let settings=crate::settings::Settings::new(self.settings_path.clone()).snapshot();
                    crate::restart_continuation::execute(&self.bus,effect,&settings,&now())
                }
                Some("delegated-tasks.stop") => {
                    let children = self.bus.commit(|tx| {
                        let mut stmt = tx.prepare("SELECT DISTINCT json_extract(payload_json,'$.childThreadId') FROM orchestration_v2_projection_subagents WHERE thread_id=?1 AND origin='app_owned' AND status IN ('pending','idle','running','waiting') AND json_extract(payload_json,'$.childThreadId') IS NOT NULL")?;
                        let children = stmt.query_map([&effect.thread_id], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                        Ok((children, vec![]))
                    }).map_err(|e| e.to_string())?;
                    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    for child in children {
                        let command = format!("{}:child:{}:attempt:{}", effect.command_id, child, effect.attempt_count);
                        let result = crate::interrupt_commands::stop_thread(&self.bus, &self.provider.sessions, &command, &child, effect.request["reason"].as_str(), true, &now).map_err(|e| format!("{e:?}"))?;
                        if result.receipt.status != "accepted" { return Err(format!("Failed to stop delegated thread {child}: {:?}", result.receipt.error)); }
                    }
                    Ok(())
                }
                Some("provider-session.detach") => {
                    if effect.request.get("forceStopRetryThroughOrdinal").is_some() {
                        let at=now();
                        let result=if effect.request["forceStopPi"]==true {crate::interrupt_commands::retry_pi_force_stop(&self.bus,effect,&at)} else if effect.request["forceStopCursor"]==true {crate::interrupt_commands::retry_cursor_force_stop(&self.bus,effect,&at)} else {crate::interrupt_commands::retry_opencode_force_stop(&self.bus,effect,&self.settings_path,&at)};
                        if result.is_err() && !will_retry {return crate::interrupt_commands::renew_opencode_force_stop(&self.bus,effect,&at);}
                        return result;
                    }
                    if effect.request["onlyIfIdle"] == true {
                        let now=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
                        return crate::queue_promotion::fresh_context::execute_idle_detach(&self.bus,&self.provider.sessions,effect,&now);
                    }
                    let id = effect.request["providerSessionId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Missing providerSessionId")?;
                    if effect.request["revokeMcpCredential"].as_bool() == Some(true) {
                        self.provider
                            .sessions
                            .mcp_credentials
                            .revoke_thread(&effect.thread_id);
                    }
                    let driver = self.bus.commit(|tx| {
                        use rusqlite::OptionalExtension;
                        let driver: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.driver') FROM orchestration_v2_projection_provider_threads WHERE thread_id=?1 AND json_extract(payload_json,'$.providerSessionId')=?2 LIMIT 1",rusqlite::params![effect.thread_id,id],|r|r.get(0)).optional()?.flatten();
                        Ok((driver,vec![]))
                    }).map_err(|e|e.to_string())?;
                    if driver.as_deref()==Some("claudeAgent") {crate::provider::claude_executor::detach(&effect.thread_id); return Ok(());}
                    if driver.as_deref()==Some("opencode") {return crate::provider::opencode_executor::detach(&effect.thread_id).await;}
                    if driver.as_deref()==Some("pi") {crate::provider::pi_executor::detach(&effect.thread_id).await;return Ok(());}
                    if driver.as_deref()==Some("cursor") {return crate::provider::cursor_executor::detach(id,&effect.thread_id);}
                    if matches!(driver.as_deref(),Some("fx"|"grok"|"kiro"|"acpRegistry"|"antigravity")) { return crate::provider::acp_executor::detach(id,&effect.thread_id); }
                    if id.starts_with("provider-session:provider-instance:") && id.ends_with(":shared") {
                        if !retire_unbound_shared_session(&self.bus,&self.provider.sessions,id)? {
                            let bus=self.bus.clone(); let sessions=self.provider.sessions.clone(); let id=id.to_owned();
                            tokio::spawn(async move { loop {
                                tokio::time::sleep(Duration::from_secs(1)).await;
                                if retire_unbound_shared_session(&bus,&sessions,&id).unwrap_or(false) { break; }
                            }});
                        }
                    } else {
                        self.provider.sessions.remove(id).map_err(|e| e.to_string())?;
                    }
                    Ok(())
                }
                Some("terminal.cleanup") => {
                    self.terminals.dispatch("terminal.close", &serde_json::json!({"threadId": effect.thread_id, "deleteHistory": true})).map_err(|e| e.to_string())?;
                    Ok(())
                }
                Some("scheduled-tasks.cleanup") => {
                    self.bus.commit(|tx| {
                        tx.execute("DELETE FROM scheduled_task_webhook_deliveries WHERE task_id IN (SELECT task_id FROM scheduled_tasks WHERE thread_id=?1)", [&effect.thread_id])?;
                        tx.execute("DELETE FROM scheduled_tasks WHERE thread_id=?1", [&effect.thread_id])?;
                        Ok(((), vec![]))
                    }).map_err(|e| e.to_string())
                }
                // This server does not create or hold preview sessions.
                Some("preview.cleanup") => Ok(()),
                Some("attachment.cleanup") => {
                    let ids = effect.request["attachmentIds"].as_array().ok_or("Missing attachmentIds")?
                        .iter().map(|id| id.as_str().map(str::to_owned).ok_or("Invalid attachment ID"))
                        .collect::<Result<Vec<_>, _>>()?;
                    crate::attachment_store::cleanup(&self.provider.attachments_dir, &ids)
                }
                Some("runtime-request.respond") => {
                    let id = effect.request["requestId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Missing requestId")?;
                    let result = if id.starts_with("runtime-request:provider:muse:") {
                        crate::provider::muse_requests::deliver(id,effect.request["decision"].as_str().ok_or("Missing Muse approval decision")?)
                    } else if id.starts_with("runtime-request:provider:claudeAgent:") {
                        crate::provider::claude_requests::deliver(id,effect.request["decision"].as_str(),effect.request.get("answers"))
                    } else if id.starts_with("runtime-request:provider:pi:") && crate::provider::pi_questions::owns(id) {
                        crate::provider::pi_questions::deliver(id,effect.request.get("answers"))
                    } else if id.starts_with("runtime-request:provider:opencode:") && crate::provider::opencode_questions::owns(id) {
                        crate::provider::opencode_questions::deliver(id,effect.request.get("answers"))
                    } else if ["fx", "grok", "kiro", "acpRegistry", "antigravity", "opencode", "pi"].iter().any(|driver| id.starts_with(&format!("runtime-request:provider:{driver}:"))) {
                        crate::provider::acp_executor::deliver_approval(id,effect.request["decision"].as_str())
                    } else {
                        crate::provider::codex_requests::deliver(id,effect.request["decision"].as_str(),effect.request.get("answers")).await
                    };
                    if result.is_err() && !will_retry {
                        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
                        if let Err(error) = crate::request_delivery_failure::record(&self.bus,&format!("{}:delivery-failed",effect.command_id),&effect.thread_id,id,&at) { eprintln!("Failed to record answer delivery failure: {error}"); }
                    }
                    result
                }
                Some("provider-thread.rollback") => {
                    let result = crate::rollback_executor::execute_with_roots(
                        &self.bus,
                        &self.provider,
                        effect,
                        &self.worktrees_dir,
                        &self.settings_path,
                    )
                    .await;
                    if result.is_err() && !will_retry {
                        let _ = crate::rollback_commands::record_failure(&self.bus, &format!("{}:rollback-failed", effect.command_id), &effect.thread_id, &effect.command_id, "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.", &now());
                    }
                    result
                }
                Some("thread-title.generate") => {
                    crate::thread_title::execute(&self.bus, effect, &self.settings_path).await
                }
                Some("checkpoint.capture") => {
                    let run = effect.request["runId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Missing runId")?
                        .to_owned();
                    let scope = effect.request["scopeId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Missing scopeId")?
                        .to_owned();
                    let thread = effect.thread_id.clone();
                    let bus = self.bus.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::checkpoint::execute(&bus, &thread, &run, &scope, &now())
                            .map_err(|e| e.to_string())
                    })
                    .await
                    .map_err(|e| e.to_string())?
                }
                _ => Err("Unsupported effect".into()),
            }
        })
    }
}

pub struct EffectWorker<E> {
    pub db: Arc<Mutex<Connection>>,
    pub signals: Arc<Signals>,
    executor: Arc<E>,
    worker_id: String,
    max_attempts: i64,
    supported: Option<String>,
}
impl<E: EffectExecutor> Clone for EffectWorker<E> {
    fn clone(&self) -> Self {
        Self {
            db: self.db.clone(),
            signals: self.signals.clone(),
            executor: self.executor.clone(),
            worker_id: self.worker_id.clone(),
            max_attempts: self.max_attempts,
            supported: self.supported.clone(),
        }
    }
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn replay_safe(effect: &Effect) -> bool {
    matches!(
        effect.request["type"].as_str(),
        Some(
            "provider-runtime.continue"
                | "provider-session.detach"
                | "provider-thread.rollback"
                | "checkpoint.capture"
                | "scheduled-tasks.cleanup"
                | "terminal.cleanup"
                | "preview.cleanup"
                | "attachment.cleanup"
                | "thread-title.generate"
                | "delegated-tasks.stop"
        )
    )
}
fn already_stopped(effect: &Effect, error: &str) -> bool {
    effect.request["type"] == "provider-turn.interrupt"
        && [
            "is not active",
            "hard teardown is already in progress",
            "treating as already interrupted",
            "treating as already stopped",
        ]
        .iter()
        .any(|s| error.to_lowercase().contains(s))
}
impl<E: EffectExecutor> EffectWorker<E> {
    pub fn new(
        db: Arc<Mutex<Connection>>,
        signals: Arc<Signals>,
        executor: Arc<E>,
        worker_id: String,
        max_attempts: i64,
    ) -> Self {
        Self {
            db,
            signals,
            executor,
            worker_id,
            max_attempts: max_attempts.max(1),
            supported: None,
        }
    }
    pub fn with_supported_types(mut self, types: &[&str]) -> Self {
        self.supported = Some(serde_json::to_string(types).expect("effect types serialize"));
        self
    }
    /// Claim and handle at most one effect. Cancellation drops the execution future.
    pub async fn run_once(
        &self,
        exclude_continuations: bool,
        max_titles: Option<i64>,
    ) -> Result<bool, String> {
        let effect = {
            let db = self.db.lock().map_err(|e| e.to_string())?;
            outbox::claim_next_supported(
                &db,
                &self.worker_id,
                &now(),
                exclude_continuations,
                max_titles,
                self.supported.as_deref(),
            )
            .map_err(|e| e.to_string())?
        };
        let Some(effect) = effect else {
            return Ok(false);
        };
        let mut cancellation = self.signals.arm(&effect.id);
        let cancelled = match self.db.lock() {
            Ok(db) => match outbox::get(&db, &effect.id) {
                Ok(row) => row.is_some_and(|e| e.status == "cancelled"),
                Err(error) => {
                    let cause = error.to_string();
                    let timestamp = now();
                    let _ = outbox::retry(
                        &db,
                        &effect.id,
                        &self.worker_id,
                        &timestamp,
                        &timestamp,
                        &format!("Worker failed before settling the claimed effect: {cause}"),
                    );
                    self.signals.clear(&effect.id);
                    self.signals.available();
                    return Err(cause);
                }
            },
            Err(error) => {
                self.signals.clear(&effect.id);
                return Err(error.to_string());
            }
        };
        if cancelled || *cancellation.borrow() {
            self.signals.clear(&effect.id);
            return Ok(true);
        }
        let execution = self
            .executor
            .execute(&effect, effect.attempt_count < self.max_attempts);
        let result = if effect.request["type"] == "delegated-tasks.stop" {
            tokio::select! { biased; _ = cancellation.changed() => None, result = tokio::time::timeout(Duration::from_secs(30), execution) => Some(result.unwrap_or_else(|_| Err("Effect execution timed out".into()))) }
        } else {
            tokio::select! { biased; _ = cancellation.changed() => None, result = execution => Some(result) }
        };
        self.signals.clear(&effect.id);
        let Some(result) = result else {
            return Ok(true);
        };
        let timestamp = now();
        let db = self.db.lock().map_err(|e| e.to_string())?;
        let update = match &result {
            Ok(()) => outbox::settle(&db, &effect.id, &self.worker_id, &timestamp, None),
            Err(error) if already_stopped(&effect, error) => {
                outbox::settle(&db, &effect.id, &self.worker_id, &timestamp, None)
            }
            Err(error) if effect.attempt_count >= self.max_attempts => {
                outbox::settle(&db, &effect.id, &self.worker_id, &timestamp, Some(error))
            }
            Err(error) => {
                let delay =
                    (100_i64 * (1_i64 << (effect.attempt_count - 1).clamp(0, 9))).min(30_000);
                let next = (chrono::Utc::now() + chrono::Duration::milliseconds(delay))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                outbox::retry(&db, &effect.id, &self.worker_id, &timestamp, &next, error)
            }
        };
        match update {
            Ok(true) => {
                self.signals.available();
                Ok(true)
            }
            Ok(false)
                if outbox::get(&db, &effect.id)
                    .map_err(|e| e.to_string())?
                    .is_some_and(|e| e.status == "cancelled") =>
            {
                Ok(true)
            }
            other => {
                let cause = match other {
                    Ok(_) => "The worker no longer owns the effect lease.".to_owned(),
                    Err(e) => e.to_string(),
                };
                // A failed execution which was due for retry gives the claim
                // back even if its initial retry write failed. After success,
                // process-bound effects must never be replayed.
                let requeue = match &result {
                    Ok(()) => replay_safe(&effect),
                    Err(error) => {
                        !already_stopped(&effect, error) && effect.attempt_count < self.max_attempts
                    }
                };
                let message = if requeue {
                    format!("Worker failed before settling the claimed effect: {cause}")
                } else {
                    format!("Worker failed to settle a process-bound effect after execution started: {cause}")
                };
                if requeue {
                    let _ = outbox::retry(
                        &db,
                        &effect.id,
                        &self.worker_id,
                        &timestamp,
                        &timestamp,
                        &message,
                    );
                } else {
                    let _ = outbox::settle(
                        &db,
                        &effect.id,
                        &self.worker_id,
                        &timestamp,
                        Some(&message),
                    );
                }
                Err(cause)
            }
        }
    }
    pub async fn drain(&self, max: usize) -> Result<usize, String> {
        let mut count = 0;
        while count < max && self.run_once(false, None).await? {
            count += 1;
        }
        Ok(count)
    }
    /// Runs until the returned task is aborted. The liveness poll repairs missed signals.
    pub async fn run_daemon(&self, concurrency: usize, poll: Duration) {
        let concurrency = concurrency.max(1);
        let poll = poll.max(Duration::from_millis(1));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..concurrency {
            let worker = self.clone();
            tasks.spawn(async move {
            let cap = if concurrency > 1 { Some((concurrency - 1) as i64) } else { None };
            // Attempts that outlive the slot timeout remain owned by this slot;
            // dropping the daemon aborts them rather than leaking tasks.
            let mut attempts = tokio::task::JoinSet::new();
            loop {
                while attempts.try_join_next().is_some() {}
                let attempt_worker = worker.clone();
                let (send, receive) = tokio::sync::oneshot::channel();
                attempts.spawn(async move { let _ = send.send(attempt_worker.run_once(false, cap).await); });
                let outcome = match tokio::time::timeout(Duration::from_secs(30), receive).await {
                    Ok(Ok(result)) => result,
                    Ok(Err(error)) => Err(error.to_string()),
                    Err(_) => Ok(true),
                };
                match outcome {
                    Ok(true) => tokio::task::yield_now().await,
                    Err(_) => tokio::time::sleep(poll.min(Duration::from_secs(1))).await,
                    Ok(false) => {
                        let deadline = if worker.supported.is_none() { worker.db.lock().ok().and_then(|db| outbox::next_claimable_at(&db, cap).ok().flatten()) } else { None };
                        let delay = deadline.and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok()).map(|d| (d.to_utc() - chrono::Utc::now()).to_std().unwrap_or(Duration::from_millis(25)).max(Duration::from_millis(25))).unwrap_or(poll).min(poll);
                        tokio::select! { _ = worker.signals.await_available() => {}, _ = tokio::time::sleep(delay) => {} }
                    }
                }
            }
        });
        }
        while tasks.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[cfg(unix)]
    #[test]
    fn shared_detach_preserves_bindings_and_live_leases_then_retires() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 16);
        let sessions = crate::provider::session_registry::SessionRegistry::default();
        let id = "provider-session:provider-instance:codex:shared";
        let path = std::env::temp_dir().join(format!("codex-detach-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\nwhile read line; do :; done\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let handle = sessions
            .open(
                id,
                crate::provider::CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        bus.commit(|tx| {tx.execute("INSERT INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id) VALUES(?1,'sibling')",[id])?; Ok(((),vec![]))}).unwrap();
        assert!(retire_unbound_shared_session(&bus, &sessions, id).unwrap());
        assert!(sessions.get(id).unwrap().is_some());
        bus.commit(|tx| {tx.execute("DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id=?1",[id])?; Ok(((),vec![]))}).unwrap();
        let lease = sessions.claim_turn(id, &handle).unwrap().unwrap();
        assert!(!retire_unbound_shared_session(&bus, &sessions, id).unwrap());
        assert!(sessions.get(id).unwrap().is_some());
        drop(lease);
        assert!(retire_unbound_shared_session(&bus, &sessions, id).unwrap());
        assert!(sessions.get(id).unwrap().is_none());
        let _ = std::fs::remove_file(path);
    }
    struct Failing(AtomicUsize);
    impl EffectExecutor for Failing {
        fn execute<'a>(&'a self, _: &'a Effect, _: bool) -> Execution<'a> {
            Box::pin(async move {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err("failure".into())
            })
        }
    }
    fn fixture() -> (Arc<Mutex<Connection>>, Effect) {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let timestamp = now();
        let effect = Effect {
            id: "a".into(),
            command_id: "cmd".into(),
            thread_id: "thread".into(),
            request: serde_json::json!({"type":"checkpoint.capture"}),
            status: "pending".into(),
            attempt_count: 0,
            available_at: timestamp.clone(),
            lease_owner: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            completed_at: None,
            last_error: None,
        };
        let tx = db.transaction().unwrap();
        outbox::enqueue(&tx, &effect).unwrap();
        tx.commit().unwrap();
        (Arc::new(Mutex::new(db)), effect)
    }
    #[tokio::test]
    async fn scheduled_cleanup_removes_only_current_thread_bindings() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let insert = "INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count) VALUES (?1,'t','p',1,'{}','p',?2,'{}','{}','full-access','default','user','web','x','x','never',0)";
        db.execute(insert, ["a", "thread"]).unwrap();
        db.execute(insert, ["b", "other"]).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 8);
        let executor = RuntimeExecutor {
            provider: crate::provider::executor::CodexTurnExecutor::new(
                bus.clone(),
                Arc::new(crate::provider::session_registry::SessionRegistry::default()),
            ),
            bus: bus.clone(),
            worktrees_dir: Default::default(),
            settings_path: Default::default(),
            terminals: Arc::new(crate::terminal::TerminalManager::default()),
        };
        let (_, mut effect) = fixture();
        effect.request = serde_json::json!({"type":"scheduled-tasks.cleanup"});
        executor.execute(&effect, false).await.unwrap();
        executor.execute(&effect, false).await.unwrap();
        let remaining: Vec<String> = bus
            .commit(|tx| {
                let mut stmt =
                    tx.prepare("SELECT task_id FROM scheduled_tasks ORDER BY task_id")?;
                let ids = stmt
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((ids, vec![]))
            })
            .unwrap();
        assert_eq!(remaining, ["b"]);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn detach_effect_removes_live_session_and_is_replay_safe() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("t3-detach-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\nwhile read line; do :; done\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let registry = Arc::new(crate::provider::session_registry::SessionRegistry::default());
        registry
            .open(
                "session",
                crate::provider::CodexLaunch {
                    binary: Some(path.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = crate::event_bus::EventBus::new(db, 8);
        let executor = RuntimeExecutor {
            provider: crate::provider::executor::CodexTurnExecutor::new(
                bus.clone(),
                registry.clone(),
            ),
            bus,
            worktrees_dir: Default::default(),
            settings_path: Default::default(),
            terminals: Arc::new(crate::terminal::TerminalManager::default()),
        };
        let timestamp = now();
        let effect = Effect {
            id: "detach".into(),
            command_id: "cmd".into(),
            thread_id: "thread".into(),
            request: serde_json::json!({"type":"provider-session.detach","providerSessionId":"session"}),
            status: "pending".into(),
            attempt_count: 0,
            available_at: timestamp.clone(),
            lease_owner: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            completed_at: None,
            last_error: None,
        };
        executor.execute(&effect, false).await.unwrap();
        assert!(registry.get("session").unwrap().is_none());
        executor.execute(&effect, false).await.unwrap();
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn supported_filter_preserves_unsupported_work_and_thread_order() {
        let (db, _) = fixture();
        {
            let mut db = db.lock().unwrap();
            db.execute(r#"UPDATE orchestration_v2_effect_outbox SET effect_type='terminal.cleanup', payload_json='{"type":"terminal.cleanup"}' WHERE effect_id='a'"#, []).unwrap();
            let tx = db.transaction().unwrap();
            let timestamp = now();
            let later = Effect {
                id: "b".into(),
                command_id: "cmd".into(),
                thread_id: "thread".into(),
                request: serde_json::json!({"type":"checkpoint.capture"}),
                status: "pending".into(),
                attempt_count: 0,
                available_at: timestamp.clone(),
                lease_owner: None,
                created_at: timestamp.clone(),
                updated_at: timestamp,
                completed_at: None,
                last_error: None,
            };
            outbox::enqueue(&tx, &later).unwrap();
            tx.commit().unwrap();
        }
        let worker = EffectWorker::new(
            db.clone(),
            Arc::new(Signals::default()),
            Arc::new(Failing(AtomicUsize::new(0))),
            "worker".into(),
            1,
        )
        .with_supported_types(&["checkpoint.capture"]);
        assert!(!worker.run_once(false, None).await.unwrap());
        let db = db.lock().unwrap();
        assert_eq!(outbox::get(&db, "a").unwrap().unwrap().status, "pending");
        assert_eq!(outbox::get(&db, "b").unwrap().unwrap().status, "pending");
    }
    #[tokio::test]
    async fn availability_queue_preserves_bursts_and_caps_at_64() {
        let signals = Signals::default();
        signals.available_count(100);
        for _ in 0..64 {
            signals.await_available().await;
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(1), signals.await_available())
                .await
                .is_err()
        );
        signals.available_count(2);
        signals.await_available().await;
        signals.await_available().await;
    }
    #[tokio::test]
    async fn failed_pre_execution_read_requeues_claim_without_running_effect() {
        let (db, _) = fixture();
        db.lock().unwrap().execute_batch("CREATE TRIGGER corrupt_after_claim AFTER UPDATE ON orchestration_v2_effect_outbox WHEN NEW.status='running' BEGIN UPDATE orchestration_v2_effect_outbox SET payload_json='invalid' WHERE effect_id=NEW.effect_id; END;").unwrap();
        let executor = Arc::new(Failing(AtomicUsize::new(0)));
        let worker = EffectWorker::new(
            db.clone(),
            Arc::new(Signals::default()),
            executor.clone(),
            "worker".into(),
            5,
        );
        assert!(worker.run_once(false, None).await.is_err());
        assert_eq!(executor.0.load(Ordering::SeqCst), 0);
        let db = db.lock().unwrap();
        let (status, owner, error): (String, Option<String>, String) = db.query_row("SELECT status,lease_owner,last_error FROM orchestration_v2_effect_outbox WHERE effect_id='a'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(status, "pending");
        assert!(owner.is_none());
        assert!(error.starts_with("Worker failed before settling the claimed effect:"));
    }
    #[tokio::test]
    async fn retry_bookkeeping_failure_returns_process_bound_claim() {
        let (db, _) = fixture();
        db.lock().unwrap().execute_batch("UPDATE orchestration_v2_effect_outbox SET effect_type='provider-turn.start',payload_json='{\"type\":\"provider-turn.start\",\"runId\":\"r\"}'; CREATE TRIGGER fail_first_retry BEFORE UPDATE ON orchestration_v2_effect_outbox WHEN NEW.status='pending' AND NEW.last_error='failure' BEGIN SELECT RAISE(ABORT, 'injected retry failure'); END;").unwrap();
        let executor = Arc::new(Failing(AtomicUsize::new(0)));
        let worker = EffectWorker::new(
            db.clone(),
            Arc::new(Signals::default()),
            executor,
            "worker".into(),
            5,
        );
        assert!(worker.run_once(false, None).await.is_err());
        let effect = outbox::get(&db.lock().unwrap(), "a").unwrap().unwrap();
        assert_eq!(effect.status, "pending");
        assert!(effect.lease_owner.is_none());
        assert!(effect
            .last_error
            .unwrap()
            .starts_with("Worker failed before settling the claimed effect:"));
    }
    #[tokio::test]
    async fn retries_then_terminalizes_at_attempt_limit() {
        let (db, _) = fixture();
        let executor = Arc::new(Failing(AtomicUsize::new(0)));
        let worker = EffectWorker::new(
            db.clone(),
            Arc::new(Signals::default()),
            executor.clone(),
            "worker".into(),
            2,
        );
        assert!(worker.run_once(false, None).await.unwrap());
        let effect = outbox::get(&db.lock().unwrap(), "a").unwrap().unwrap();
        assert_eq!(
            (
                effect.status.as_str(),
                effect.attempt_count,
                effect.last_error.as_deref()
            ),
            ("pending", 1, Some("failure"))
        );
        db.lock()
            .unwrap()
            .execute(
                "UPDATE orchestration_v2_effect_outbox SET available_at='2000-01-01T00:00:00.000Z'",
                [],
            )
            .unwrap();
        assert!(worker.run_once(false, None).await.unwrap());
        let effect = outbox::get(&db.lock().unwrap(), "a").unwrap().unwrap();
        assert_eq!(
            (effect.status.as_str(), effect.attempt_count),
            ("failed", 2)
        );
        assert_eq!(executor.0.load(Ordering::SeqCst), 2);
    }
    struct Blocked(tokio::sync::Notify);
    impl EffectExecutor for Blocked {
        fn execute<'a>(&'a self, _: &'a Effect, _: bool) -> Execution<'a> {
            Box::pin(async move {
                self.0.notify_one();
                std::future::pending().await
            })
        }
    }
    #[tokio::test]
    async fn committed_cancellation_stops_in_flight_execution() {
        let (db, _) = fixture();
        let signals = Arc::new(Signals::default());
        let executor = Arc::new(Blocked(tokio::sync::Notify::new()));
        let worker = EffectWorker::new(
            db.clone(),
            signals.clone(),
            executor.clone(),
            "worker".into(),
            5,
        );
        let task = tokio::spawn(async move { worker.run_once(false, None).await });
        executor.0.notified().await;
        let ids = {
            let mut db = db.lock().unwrap();
            let tx = db.transaction().unwrap();
            let ids = outbox::cancel_unsettled(
                &tx,
                "thread",
                &["checkpoint.capture".into()],
                "stop",
                &now(),
            )
            .unwrap();
            tx.commit().unwrap();
            ids
        };
        signals.cancelled(&ids);
        assert!(task.await.unwrap().unwrap());
        assert_eq!(
            outbox::get(&db.lock().unwrap(), "a")
                .unwrap()
                .unwrap()
                .status,
            "cancelled"
        );
    }
}
