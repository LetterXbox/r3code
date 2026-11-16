//! Pi provider turn admission and supervisor.
use crate::{
    event_bus::EventBus,
    outbox::Effect,
    provider::{
        codex_events::{
            FailureClass, NormalizedEvent, ProviderFailure, RootTurn, ThreadDisposition, TurnStatus,
        },
        ingest, lifecycle,
        pi_events::{Decoder, PiUpdate},
        pi_launch,
        pi_projection::Projector,
        pi_session::PiSession,
        session_registry::SessionRegistry,
    },
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Notify};
struct Active {
    session: Arc<AsyncMutex<PiSession>>,
    cancelled: Arc<AtomicBool>,
    turn: String,
    thread: String,
    gate: Arc<AsyncMutex<()>>,
    rpc: Arc<super::pi_rpc::PiRpc>,
    provider_session: String,
}
static ACTIVE: OnceLock<Mutex<HashMap<String, Active>>> = OnceLock::new();
fn active() -> &'static Mutex<HashMap<String, Active>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}
struct Starting {
    cancelled: Arc<AtomicBool>,
    done: AtomicBool,
    notify: Notify,
    rpc: Mutex<Option<Arc<super::pi_rpc::PiRpc>>>,
    spawn_gate: AsyncMutex<()>,
    provider_session: String,
}
static STARTING: OnceLock<Mutex<HashMap<String, Arc<Starting>>>> = OnceLock::new();
fn starting() -> &'static Mutex<HashMap<String, Arc<Starting>>> {
    STARTING.get_or_init(|| Mutex::new(HashMap::new()))
}
struct StartGuard {
    thread: String,
    state: Arc<Starting>,
}
impl StartGuard {
    fn acquire(thread: &str, provider_session: &str) -> Result<Self, String> {
        let mut map = starting()
            .lock()
            .map_err(|_| "Pi start registry unavailable")?;
        if map.contains_key(thread) {
            return Err("Pi turn is already starting".into());
        }
        let state = Arc::new(Starting {
            cancelled: Arc::new(AtomicBool::new(false)),
            done: AtomicBool::new(false),
            notify: Notify::new(),
            rpc: Mutex::new(None),
            spawn_gate: AsyncMutex::new(()),
            provider_session: provider_session.into(),
        });
        map.insert(thread.into(), state.clone());
        Ok(Self {
            thread: thread.into(),
            state,
        })
    }
}
impl Drop for StartGuard {
    fn drop(&mut self) {
        self.state.done.store(true, Ordering::Release);
        self.state.notify.notify_one();
        if let Ok(mut map) = starting().lock() {
            if map
                .get(&self.thread)
                .is_some_and(|state| Arc::ptr_eq(state, &self.state))
            {
                map.remove(&self.thread);
            }
        }
    }
}
struct Admission {
    key: String,
    turn: String,
    armed: bool,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if self.armed {
            if let Ok(mut map) = active().lock() {
                if map
                    .get(&self.key)
                    .is_some_and(|entry| entry.turn == self.turn)
                {
                    map.remove(&self.key);
                }
            }
        }
    }
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn capabilities() -> Value {
    json!({
 "sessions":{"supportsMultipleProviderThreadsPerSession":false,"supportsModelSwitchInSession":true,"supportsProviderSwitchingViaHandoff":false,"supportsRuntimeModeSwitchInSession":false,"pendingRequestsSurviveRestart":false},
 "threads":{"canCreateEmptyThread":true,"canReadThreadSnapshot":false,"canRollbackThread":false,"canForkThread":false,"canForkFromTurn":false,"canForkFromSubagentThread":false,"exposesNativeThreadId":true},
 "turns":{"exposesNativeTurnId":false,"emitsTurnStarted":true,"emitsTurnCompleted":true,"supportsInterrupt":true,"supportsActiveSteering":false,"supportsSteeringByInterruptRestart":false,"supportsQueuedMessages":true,"terminalStatusQuality":"strong"},
 "streaming":{"streamsAssistantText":true,"streamsReasoning":true,"streamsToolOutput":true,"streamsPlanText":false,"emitsMessageCompleted":true},
 "tools":{"exposesToolItemIds":true,"emitsToolStarted":true,"emitsToolCompleted":true,"emitsToolOutput":true,"supportsMcpTools":true,"supportsDynamicToolCallbacks":false},
 "approvals":{"supportsCommandApproval":true,"supportsFileReadApproval":true,"supportsFileChangeApproval":true,"supportsApplyPatchApproval":true,"approvalsHaveNativeRequestIds":true,"approvalCallbacksAreLiveOnly":true,"approvalsCanOriginateFromSubagents":false},
 "planning":{"emitsPlanUpdated":false,"emitsProposedPlan":false,"emitsTodoList":false,"planDeltasHaveItemIds":false,"supportsStructuredQuestions":true},
 "subagents":{"canSpawn":false,"canClose":false,"canSendInput":false,"canResume":false,"exposesNativeAgentIds":false},
 "context":{"acceptsSystemContext":false,"acceptsDeveloperContext":false,"acceptsSyntheticUserContext":false,"canGenerateSummaries":false,"canConsumeHandoffSummaries":false,"supportsDeltaHandoff":false,"supportsFullThreadHandoff":false,"maxRecommendedHandoffChars":null},
 "checkpointing":{"appCanCheckpointFilesystem":true,"supportsNestedCheckpointScopes":false,"providerCanRollbackConversation":false,"providerRollbackReturnsSnapshot":false,"providerCanReadConversationSnapshot":false},
 "identity":{"nativeThreadIds":"strong","nativeTurnIds":"weak","nativeItemIds":"strong","nativeRequestIds":"strong"},"runtimePolicy":{"enforcement":"native"}})
}
pub(crate) async fn start(
    bus: EventBus,
    effect: &Effect,
    settings_path: &Path,
    attachments_dir: &Path,
    mcp: Option<(&str, &SessionRegistry)>,
) -> Result<(), String> {
    if effect.attempt_count > 1 {
        return Err("Cannot safely replay an uncertain Pi turn start".into());
    }
    if crate::managed_policy::has_provider_restrictions()? {
        return Err("Pi provider restrictions cannot yet be enforced".into());
    }
    let run_id = text(&effect.request, "runId")?.to_owned();
    let thread_id = effect.thread_id.clone();
    let data=bus.commit(|tx|{
  let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting'",params![run_id,thread_id],|r|r.get(0)).optional()?;
  let Some(raw)=raw else{return Ok((None,vec![]))};let run:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;
  let read=|sql:&str,id:&str|->rusqlite::Result<Value>{let raw:String=tx.query_row(sql,[id],|r|r.get(0))?;serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)};
  let pt=read("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1",run["providerThreadId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)?;
  let message=read("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1",run["userMessageId"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)?;
  let thread=read("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1",&thread_id)?;
  let cwd:Option<String>=tx.query_row("SELECT COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root) FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1",[&thread_id],|r|r.get(0)).optional()?;
  let ordinal:u64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1",[run["providerThreadId"].as_str()],|r|r.get(0))?;
  Ok((Some((run,pt,message,thread,cwd,ordinal)),vec![]))
 }).map_err(|e|e.to_string())?;
    let Some((run, pt, message, thread, cwd, ordinal)) = data else {
        return Ok(());
    };
    if pt["driver"] != "pi" {
        return Err("Unsupported provider driver".into());
    }
    let key = text(&pt, "id")?.to_owned();
    let instance = text(&pt, "providerInstanceId")?.to_owned();
    let provider_session = text(&pt, "providerSessionId")?.to_owned();
    let start_guard = StartGuard::acquire(&thread_id, &provider_session)?;
    let cancelled = start_guard.state.cancelled.clone();
    let gate = Arc::new(AsyncMutex::new(()));
    let workspace = thread["worktreePath"]
        .as_str()
        .filter(|v| !v.is_empty())
        .or(cwd.as_deref())
        .map(PathBuf::from);
    let worktree = thread["worktreePath"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let _workspace = if let Some(workspace) = workspace {
        Some(
            tokio::task::spawn_blocking(move || {
                let reservation = crate::workspace_safety::reserve(
                    workspace,
                    crate::workspace_safety::ReservationKind::TurnStart,
                );
                let lease = worktree.map(crate::workspace_safety::workspace_lease);
                (reservation, lease)
            })
            .await
            .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let still_starting=bus.commit(|tx|{let ok:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting')",params![run_id,thread_id],|r|r.get(0))?;Ok((ok,vec![]))}).map_err(|e|e.to_string())?;
    if !still_starting {
        return Ok(());
    }
    if cancelled.load(Ordering::Acquire) {
        return Ok(());
    }
    if active()
        .lock()
        .map_err(|_| "Pi registry unavailable")?
        .contains_key(&key)
    {
        return Err("Pi provider thread already has an active turn".into());
    }
    let session = {
        let mut settings =
            crate::provider::session_registry::read_provider_settings(Some(settings_path))?;
        crate::settings::materialize_secrets(settings_path, &mut settings)?;
        let entry = &settings["providerInstances"][&instance];
        if entry["enabled"] == false || entry["config"]["enabled"] == false {
            return Err("Pi provider instance is disabled".into());
        }
        let binary = entry["config"]["binaryPath"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("pi");
        let dir = settings_path
            .parent()
            .ok_or("Missing settings directory")?
            .join("provider-cache");
        let extension = pi_launch::materialize_extension(&dir)?;
        let launch = pi_launch::args(
            entry["config"]["launchArgs"].as_str().unwrap_or(""),
            &extension,
            None,
        )?;
        let mut env = Vec::new();
        for var in entry["environment"].as_array().into_iter().flatten() {
            let name = text(var, "name")?;
            if name.is_empty()
                || !name.chars().enumerate().all(|(i, c)| {
                    c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                })
            {
                return Err("Invalid Pi environment".into());
            }
            let value = if let Some(secret) = var.get("secret").filter(|v| !v.is_null()) {
                crate::mcp_secret::resolve_reference(&settings, secret)
                    .await
                    .ok_or("Pi provider contains an unresolved credential")?
            } else {
                var["value"]
                    .as_str()
                    .ok_or("Invalid Pi environment")?
                    .to_owned()
            };
            env.push((name.into(), value));
        }
        env.push((
            "T3_PI_MCP_EXTENSION_PATH".into(),
            extension.to_string_lossy().into_owned(),
        ));
        env.push((
            "T3_PI_RUNTIME_MODE".into(),
            thread["runtimeMode"]
                .as_str()
                .unwrap_or("approval-required")
                .into(),
        ));
        if let Some((endpoint, registry)) = mcp {
            let authorization = registry.prepare_mcp(&thread_id, &instance, false)?;
            env.push(("T3_MCP_URL".into(), endpoint.into()));
            env.push((
                "T3_MCP_BEARER_TOKEN".into(),
                authorization
                    .strip_prefix("Bearer ")
                    .unwrap_or(&authorization)
                    .into(),
            ));
        }
        let resume = pt["nativeThreadRef"]["nativeId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        let spawn_permit = start_guard.state.spawn_gate.lock().await;
        if cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        let rpc = Arc::new(
            super::pi_rpc::PiRpc::spawn(binary, &launch, cwd.as_deref().map(Path::new), &env)
                .await?,
        );
        *start_guard
            .state
            .rpc
            .lock()
            .map_err(|_| "Pi start registry unavailable")? = Some(rpc.clone());
        drop(spawn_permit);
        if cancelled.load(Ordering::Acquire) {
            rpc.terminate().await;
            return Ok(());
        }
        let setup = PiSession::connect(rpc.clone(), resume.as_deref()).await;
        let session = match setup {
            Ok(session) => session,
            Err(error) => {
                rpc.terminate().await;
                return Err(error);
            }
        };
        if cancelled.load(Ordering::Acquire) {
            rpc.terminate().await;
            return Ok(());
        }
        Arc::new(AsyncMutex::new(session))
    };
    let model = text(&run["modelSelection"], "model")?;
    let thinking = run["modelSelection"]["options"]["thinking"].as_str();
    {
        let mut session = session.lock().await;
        session.select(model, thinking).await?;
    }
    let native = session
        .lock()
        .await
        .session_file
        .to_string_lossy()
        .into_owned();
    let attempt = text(&run, "activeAttemptId")?;
    let native_turn = format!("{key}:attempt:{attempt}");
    let turn = RootTurn {
        driver: "pi".into(),
        native_thread_id: native,
        native_turn_id: native_turn.clone(),
        provider_thread_id: key.clone(),
        provider_turn_id: format!(
            "provider-turn:provider:pi:native-turn:{}",
            crate::message_commands::encode_id_part(&native_turn)
        ),
        thread_id: thread_id.clone(),
        run_id: Some(run_id),
        run_attempt_id: attempt.into(),
        root_node_id: text(&run, "rootNodeId")?.into(),
        provider_turn_ordinal: ordinal,
        run_ordinal: run["ordinal"].as_u64().ok_or("Missing run ordinal")?,
        started_at: now(),
    };
    let handoffs = bus.commit(|tx| Ok((crate::provider::executor::pending_handoffs(tx, run["providerThreadId"].as_str(), turn.run_id.as_deref().ok_or(rusqlite::Error::InvalidQuery)?)?, vec![]))).map_err(|e| e.to_string())?;
    let (text, side_chat) = if thread["lineage"]["sideChat"] == true { super::executor::prepare_inline_handoffs(handoffs, &message)? } else { (message["text"].as_str().unwrap_or("").to_owned(), vec![]) };
    let mut prompt_message = message.clone();
    prompt_message["text"] = json!(text);
    let (prompt, images) = build_prompt(&prompt_message, attachments_dir)?;
    let rpc = session.lock().await.rpc.clone();
    let permit = gate.lock().await;
    if cancelled.load(Ordering::Acquire) {
        return Ok(());
    }
    {
        let mut map = active().lock().map_err(|_| "Pi registry unavailable")?;
        if map.contains_key(&key) {
            return Err("Pi provider thread already has an active turn".into());
        }
        map.insert(
            key.clone(),
            Active {
                session: session.clone(),
                cancelled: cancelled.clone(),
                turn: turn.provider_turn_id.clone(),
                thread: thread_id,
                gate: gate.clone(),
                rpc: rpc.clone(),
                provider_session: provider_session.clone(),
            },
        );
    }
    let mut admission = Admission {
        key: key.clone(),
        turn: turn.provider_turn_id.clone(),
        armed: true,
    };
    lifecycle::start(&bus, &turn, pt, &run, cwd.as_deref(), capabilities())?;
    if cancelled.load(Ordering::Acquire) {
        return Err("Pi turn cancelled during startup".into());
    }
    session.lock().await.prompt(&prompt, &images).await?;
    admission.armed = false;
    drop(permit);
    tokio::spawn(async move {
        supervise(bus, turn, provider_session, key, session, rpc, cancelled, side_chat).await;
    });
    Ok(())
}

fn build_prompt(message: &Value, directory: &Path) -> Result<(String, Vec<Value>), String> {
    use base64::Engine;
    use std::io::Read;
    let (text, _) = super::opencode_attachments::build(
        message,
        directory,
        super::opencode_http::OpenCodeVersion::V2,
        true,
    )?;
    let mut images = Vec::new();
    for raw in message["attachments"].as_array().into_iter().flatten() {
        let attachment: crate::attachment_store::Attachment =
            serde_json::from_value(raw.clone()).map_err(|_| "Invalid Pi attachment")?;
        if !attachment.mime_type.starts_with("image/") {
            continue;
        }
        crate::attachment_paths::parse_id(&attachment.id).ok_or("Invalid Pi attachment id")?;
        let ext =
            crate::attachment_paths::image_extension(&attachment.mime_type, Some(&attachment.name));
        let file = std::fs::File::open(directory.join(format!("{}{ext}", attachment.id)))
            .map_err(|_| "Pi image unavailable")?;
        let mut bytes = Vec::new();
        file.take(10 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Pi image unavailable")?;
        if bytes.len() > 10 * 1024 * 1024 {
            return Err("Pi image is too large".into());
        }
        images.push(json!({"type":"image","data":base64::engine::general_purpose::STANDARD.encode(bytes),"mimeType":attachment.mime_type}));
    }
    Ok((text, images))
}

#[allow(clippy::too_many_arguments)]
async fn supervise(
    bus: EventBus,
    turn: RootTurn,
    provider_session: String,
    key: String,
    session: Arc<AsyncMutex<PiSession>>,
    rpc: Arc<super::pi_rpc::PiRpc>,
    cancelled: Arc<AtomicBool>,
    mut side_chat: Vec<Value>,
) {
    let mut decoder = Decoder::new(&turn.provider_turn_id);
    let mut projector = Projector::new(turn.clone());
    let pending = Arc::new(AtomicUsize::new(0));
    let notify = Arc::new(Notify::new());
    let mut candidate: Option<&'static str> = None;
    let mut acknowledged = false;
    let mut ordinal = turn
        .provider_turn_ordinal
        .saturating_mul(100)
        .saturating_add(20);
    let status = loop {
        tokio::select! {
         _=notify.notified(), if candidate.is_some()=>{},
         event=rpc.next_event()=>{
          let Some(event)=event else {break if cancelled.load(Ordering::Acquire){"interrupted"}else{"failed"}};
              let updates=match decoder.event(&event){Ok(value)=>value,Err(_)=>break "failed"};
          for update in updates {
           match update {
            PiUpdate::PromptResponse{success,..}=>{acknowledged=true;if !success{candidate=Some("failed");} else {
                for handoff in side_chat.drain(..) {
                    if let Err(error) = super::executor::record_side_chat_delivery(&bus, &turn, handoff) {
                        eprintln!("Warning: failed to record accepted Pi side-chat context delivery: {error}");
                    }
                }
            }},
            PiUpdate::SettledCandidate(status)=>{candidate=Some(status);},
            PiUpdate::Extension(value)=>{
             if value["type"]=="extension_ui_request" {
              if let Some(id)=value["id"].as_str().map(str::to_owned){
               match value["method"].as_str(){
                Some("confirm")=>{
                 let bus=bus.clone();let turn=turn.clone();let provider_session=provider_session.clone();let rpc=rpc.clone();let cancelled=cancelled.clone();let pending=pending.clone();let notify=notify.clone();let title=value["title"].as_str().unwrap_or("Pi approval").to_owned();let message=value["message"].as_str().unwrap_or(&title).to_owned();let item_ordinal=ordinal;ordinal=ordinal.saturating_add(1);pending.fetch_add(1,Ordering::AcqRel);
                 tokio::spawn(async move {
                  let native=id.clone();let flag=cancelled.clone();
                  let params=json!({"toolCall":{"toolCallId":native,"title":message,"kind":if title.to_ascii_lowercase().contains("read") {"read"}else if title.to_ascii_lowercase().contains("edit") {"edit"}else{"execute"}},"options":[{"kind":"allow_once","optionId":"yes"},{"kind":"allow_always","optionId":"always"},{"kind":"reject_once","optionId":"no"}]});
                  let result=tokio::task::spawn_blocking(move||super::acp_executor::request_approval(&bus,&turn,&provider_session,&json!(native),&params,item_ordinal,&flag)).await.ok().and_then(Result::ok);
                  if !cancelled.load(Ordering::Acquire){let confirmed=result.as_ref().and_then(|v|v["outcome"]["optionId"].as_str()).is_some_and(|option|option=="yes"||option=="always");let _=rpc.send(&json!({"type":"extension_ui_response","id":id,"confirmed":confirmed})).await;}
                  pending.fetch_sub(1,Ordering::AcqRel);notify.notify_one();
                 });
                }
                Some("select"|"input"|"editor")=>{
                 let item_ordinal=ordinal;ordinal=ordinal.saturating_add(1);
                 match super::pi_questions::project(&bus,&turn,&provider_session,&value,item_ordinal,&cancelled){
                  Ok((request_id,receiver))=>{
                   let bus=bus.clone();let turn=turn.clone();let rpc=rpc.clone();let cancelled=cancelled.clone();let pending=pending.clone();let notify=notify.clone();let timeout=value["timeout"].as_i64().filter(|v|*v!=0).map(|v|Duration::from_millis(v.max(0) as u64));pending.fetch_add(1,Ordering::AcqRel);
                   tokio::spawn(async move {
                    let answer=if let Some(timeout)=timeout {match tokio::time::timeout(timeout,receiver).await {Ok(result)=>result.ok().flatten(),Err(_)=>{super::pi_questions::expire(&bus,&turn,&request_id);None}}}else{receiver.await.ok().flatten()};
                    if !cancelled.load(Ordering::Acquire){let response=answer.as_ref().and_then(|value|value.get(&id)).and_then(Value::as_str).map(|answer|json!({"type":"extension_ui_response","id":id,"value":answer})).unwrap_or_else(||json!({"type":"extension_ui_response","id":id,"cancelled":true}));let _=rpc.send(&response).await;}
                    pending.fetch_sub(1,Ordering::AcqRel);notify.notify_one();
                   });
                  }
                  Err(_)=>{let _=rpc.send(&json!({"type":"extension_ui_response","id":id,"cancelled":true})).await;}
                 }
                }
                _=>{}
               }
              }
             }
            }
            value=>{match projector.project(value,&now()){Ok(events)=>{if ingest::ingest(&bus,&events).is_err(){candidate=Some("failed");}},Err(_)=>candidate=Some("failed")}}
           }
          }
         }
        }
        if let Some(status) = candidate {
            if acknowledged && pending.load(Ordering::Acquire) == 0 {
                let idle = tokio::time::timeout(Duration::from_secs(5), async {
                    session.lock().await.idle().await
                })
                .await;
                match idle {
                    Ok(Ok(true)) => {
                        break if cancelled.load(Ordering::Acquire) {
                            "interrupted"
                        } else {
                            status
                        }
                    }
                    Ok(Ok(false)) => {
                        candidate = None;
                    }
                    _ => break "failed",
                }
            }
        }
    };
    cancelled.store(true, Ordering::Release);
    super::acp_executor::cancel_approvals(&turn.thread_id);
    super::pi_questions::cancel_thread(&turn.thread_id);
    // Do not let checkpoint completion promote a queued run while this
    // generation's native process may still be executing.
    let stopped = rpc.terminate().await;
    let at = now();
    let terminal = match if stopped { status } else { "failed" } {
        "completed" => TurnStatus::Completed,
        "interrupted" => TurnStatus::Interrupted,
        _ => TurnStatus::Failed,
    };
    let failure = (terminal == TurnStatus::Failed).then(|| ProviderFailure {
        class: FailureClass::ProviderError,
        message: "Pi reported a model error.".into(),
        code: None,
        retryable: None,
        managed_usage_limit: false,
    });
    let events = [
        NormalizedEvent::ProviderTurnUpdated {
            turn: turn.clone(),
            status: terminal,
            completed_at: Some(at.clone()),
        },
        NormalizedEvent::TurnTerminal {
            turn: turn.clone(),
            status: terminal,
            failure,
            failure_item_ordinal: (terminal == TurnStatus::Failed).then_some(ordinal),
            thread_disposition: ThreadDisposition::Reusable,
        },
    ];
    let _ = ingest::ingest(&bus, &events);
    if stopped {
        if let Ok(mut map) = active().lock() {
            if map
                .get(&key)
                .is_some_and(|entry| entry.turn == turn.provider_turn_id)
            {
                map.remove(&key);
            }
        }
    }
}
type ActiveStop = (
    Arc<AtomicBool>,
    Arc<AsyncMutex<()>>,
    Arc<super::pi_rpc::PiRpc>,
);
static STOPPED: OnceLock<Mutex<std::collections::HashSet<(String, String, i64)>>> = OnceLock::new();
fn stopped() -> &'static Mutex<std::collections::HashSet<(String, String, i64)>> {
    STOPPED.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}
pub(crate) fn has_verified_stop(session: &str, thread: &str, ordinal: i64) -> bool {
    stopped()
        .lock()
        .is_ok_and(|set| set.contains(&(session.into(), thread.into(), ordinal)))
}
pub(crate) fn clear_verified_stop(session: &str, thread: &str, ordinal: i64) {
    if let Ok(mut set) = stopped().lock() {
        set.remove(&(session.into(), thread.into(), ordinal));
    }
}
pub(crate) struct ForceStopSnapshot {
    provider_session: String,
    starting: Option<Arc<Starting>>,
    active: Option<ActiveStop>,
}
pub(crate) fn force_stop_snapshot(
    provider_session: &str,
    thread: &str,
) -> Option<ForceStopSnapshot> {
    let starting = starting().lock().ok().and_then(|map| {
        map.get(thread)
            .filter(|state| state.provider_session == provider_session)
            .cloned()
    });
    let active = active().lock().ok().and_then(|map| {
        map.values()
            .find(|entry| entry.thread == thread && entry.provider_session == provider_session)
            .map(|entry| {
                (
                    entry.cancelled.clone(),
                    entry.gate.clone(),
                    entry.rpc.clone(),
                )
            })
    });
    if starting.is_none() && active.is_none() {
        None
    } else {
        Some(ForceStopSnapshot {
            provider_session: provider_session.into(),
            starting,
            active,
        })
    }
}
impl ForceStopSnapshot {
    pub(crate) fn process_group(&self) -> Option<i32> {
        self.active
            .as_ref()
            .and_then(|(_, _, rpc)| rpc.process_group())
            .or_else(|| {
                self.starting.as_ref().and_then(|start| {
                    start
                        .rpc
                        .lock()
                        .ok()
                        .and_then(|slot| slot.as_ref().and_then(|rpc| rpc.process_group()))
                })
            })
    }
    pub(crate) fn stop(&self, thread: &str, ordinal: i64) -> bool {
        if let Some(starting) = &self.starting {
            starting.cancelled.store(true, Ordering::Release);
        }
        if let Some((cancelled, _, _)) = &self.active {
            cancelled.store(true, Ordering::Release);
        }
        super::acp_executor::cancel_approvals(thread);
        super::pi_questions::cancel_thread(thread);
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return false;
        };
        let starting = self.starting.clone();
        let active = self.active.clone();
        let generation = active.as_ref().map(|(flag, _, _)| flag.clone());
        let thread = thread.to_owned();
        let provider_session = self.provider_session.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let outcome = Arc::new(AtomicU8::new(0));
        let worker_outcome = outcome.clone();
        handle.spawn(async move {
            let mut stopped = true;
            if let Some((_, gate, rpc)) = active {
                let _guard = gate.lock().await;
                stopped &= rpc.terminate().await;
            }
            if let Some(starting) = starting {
                let _spawn_permit = starting.spawn_gate.lock().await;
                let rpc = starting.rpc.lock().ok().and_then(|slot| slot.clone());
                if let Some(rpc) = rpc {
                    stopped &= rpc.terminate().await;
                }
                drop(_spawn_permit);
                while !starting.done.load(Ordering::Acquire) {
                    let notified = starting.notify.notified();
                    if starting.done.load(Ordering::Acquire) {
                        break;
                    }
                    notified.await;
                }
                let rpc = starting.rpc.lock().ok().and_then(|slot| slot.clone());
                if let Some(rpc) = rpc {
                    stopped &= rpc.terminate().await;
                }
            }
            if stopped {
                if let Some(generation) = generation {
                    match self::active().lock() {
                        Ok(mut map) => map.retain(|_, entry| {
                            entry.thread != thread || !Arc::ptr_eq(&entry.cancelled, &generation)
                        }),
                        Err(_) => stopped = false,
                    }
                }
            }
            let result = if stopped { 1 } else { 2 };
            if worker_outcome.compare_exchange(0, result, Ordering::AcqRel, Ordering::Acquire)
                == Err(3)
                && stopped
            {
                if let Ok(mut set) = self::stopped().lock() {
                    set.insert((provider_session, thread, ordinal));
                }
            }
            let _ = tx.send(stopped);
        });
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(result) => result,
            Err(_) => matches!(
                outcome.compare_exchange(0, 3, Ordering::AcqRel, Ordering::Acquire),
                Err(1)
            ),
        }
    }
}

pub(crate) async fn interrupt(thread: &str, turn: &str) -> Result<(), String> {
    let (session, cancelled, gate) = {
        let map = active().lock().map_err(|_| "Pi registry unavailable")?;
        let entry = map
            .values()
            .find(|entry| entry.thread == thread && entry.turn == turn)
            .ok_or("Pi turn is not active")?;
        (
            entry.session.clone(),
            entry.cancelled.clone(),
            entry.gate.clone(),
        )
    };
    let _permit = gate.lock().await;
    cancelled.store(true, Ordering::Release);
    super::acp_executor::cancel_approvals(thread);
    super::pi_questions::cancel_thread(thread);
    let result = session.lock().await.interrupt().await;
    result
}
pub(crate) fn is_active(provider_thread: &str) -> bool {
    active()
        .lock()
        .is_ok_and(|map| map.contains_key(provider_thread))
}
pub(crate) async fn detach(thread: &str) {
    let starting = starting()
        .lock()
        .ok()
        .and_then(|map| map.get(thread).cloned());
    if let Some(state) = starting {
        state.cancelled.store(true, Ordering::Release);
        let rpc = state.rpc.lock().ok().and_then(|slot| slot.clone());
        if let Some(rpc) = rpc {
            rpc.terminate().await;
        }
        while !state.done.load(Ordering::Acquire) {
            let notified = state.notify.notified();
            if state.done.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
        let rpc = state.rpc.lock().ok().and_then(|slot| slot.clone());
        if let Some(rpc) = rpc {
            rpc.terminate().await;
        }
    }
    let entries = {
        let mut map = match active().lock() {
            Ok(map) => map,
            Err(_) => return,
        };
        let keys = map
            .iter()
            .filter(|(_, entry)| entry.thread == thread)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| map.remove(&key))
            .collect::<Vec<_>>()
    };
    for entry in entries {
        entry.cancelled.store(true, Ordering::Release);
        super::acp_executor::cancel_approvals(thread);
        super::pi_questions::cancel_thread(thread);
        entry.session.lock().await.rpc.terminate().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        message_commands::{dispatch_first_message, DispatchMessage},
        thread_commands::{create_thread_ordered, CreateThread},
    };
    #[test]
    fn failed_side_chat_delivery_bookkeeping_keeps_handoff_undelivered() {
        let mut db=rusqlite::Connection::open_in_memory().unwrap(); crate::migrations::run_ported_migrations(&mut db).unwrap();
        let handoff=json!({"id":"side","threadId":"t","targetRunId":"r","toProviderThreadId":"old","strategy":"manual_context","transferId":"fork","summaryText":"digest"});
        db.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('side','t','r','old','manual_context','ready','now',?1)",[handoff.to_string()]).unwrap();
        db.execute_batch("CREATE TRIGGER fail_side_delivery BEFORE UPDATE ON orchestration_v2_projection_context_handoffs BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
        let bus=EventBus::new(db,16);
        let turn=RootTurn {driver:"pi".into(),native_thread_id:"native".into(),native_turn_id:"native-turn".into(),provider_thread_id:"new".into(),provider_turn_id:"turn".into(),thread_id:"t".into(),run_id:Some("r".into()),run_attempt_id:"attempt".into(),root_node_id:"node".into(),provider_turn_ordinal:1,run_ordinal:1,started_at:"now".into()};
        assert!(crate::provider::executor::record_side_chat_delivery(&bus,&turn,handoff.clone()).is_err());
        bus.commit(|tx| {let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id='side'",[],|r|r.get(0))?;assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(),handoff);Ok(((),vec![]))}).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn side_chat_digest_is_sent_to_pi_and_acknowledged() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("pi-side-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join("mock-pi"); let capture = dir.join("prompt.json"); let settings = dir.join("settings.json");
        let script = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/mock-pi")).unwrap().replace("    if command=='prompt':", "    if command=='prompt':\n        Path(os.environ['T3_SIDE_CAPTURE']).write_text(json.dumps(request))");
        std::fs::write(&binary,script).unwrap(); std::fs::set_permissions(&binary,std::fs::Permissions::from_mode(0o700)).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../t3code/apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_transcript.ndjson");
        std::fs::write(&settings,json!({"providerInstances":{"pi":{"driver":"pi","enabled":true,"environment":[{"name":"T3_SIDE_CAPTURE","value":capture},{"name":"T3_PI_FIXTURE","value":fixture}],"config":{"binaryPath":binary}}}}).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap(); crate::migrations::run_ported_migrations(&mut db).unwrap(); let bus = EventBus::new(db,32);
        let selection=json!({"instanceId":"pi","model":"openrouter/deepseek/deepseek-v4-flash"}); let source=json!("web");
        create_thread_ordered(&bus,CreateThread {command_id:"create",thread_id:"pi-side",project_id:"project",title:"Pi",model_selection:&selection,runtime_mode:"full-access",interaction_mode:"default",branch:None,worktree_path:None,created_by:"user",creation_source:&source,link_origin:None,delegated_from:None},"e","2026-01-01T00:00:00Z").unwrap();
        dispatch_first_message(&bus,DispatchMessage {context:None,command_id:"send",thread_id:"pi-side",message_id:"message",text:"hello",attachments:&[],creation_source:"web",cwd:"/tmp",driver:"pi"},"2026-01-01T00:00:01Z").unwrap();
        let effect=bus.commit(|tx| {tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.sideChat',json('true')) WHERE thread_id='pi-side'",[])?;let provider:String=tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_runs WHERE thread_id='pi-side'",[],|r|r.get(0))?;let h=json!({"id":"side","threadId":"pi-side","targetRunId":"run:thread:pi-side:ordinal:1","toProviderThreadId":provider,"strategy":"manual_context","transferId":"fork","summaryText":"parent digest"});tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('side','pi-side','run:thread:pi-side:ordinal:1',?1,'manual_context','ready','now',?2)",params![provider,h.to_string()])?;let history=json!({"id":"history","threadId":"pi-side","targetRunId":"run:thread:pi-side:ordinal:1","toProviderThreadId":provider,"strategy":"full_thread_summary","history":{"coverage":"prior context","messages":[{"itemId":"old-item","role":"user","kind":"user_message","text":"previous parent activity"}],"omittedItems":0,"omittedItemIds":[]}});tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('history','pi-side','run:thread:pi-side:ordinal:1',?1,'full_thread_summary','ready','now',?2)",params![provider,history.to_string()])?;Ok((crate::outbox::get(tx,"effect:send:provider-turn.start:run:thread:pi-side:ordinal:1")?.unwrap(),vec![]))}).unwrap();
        start(bus.clone(),&effect,&settings,&dir,None).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5),async {loop {let delivered=bus.commit(|tx| {let value:Option<String>=tx.query_row("SELECT json_extract(payload_json,'$.delivery.status') FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id='side'",[],|r|r.get(0))?;Ok((value,vec![]))}).unwrap();if delivered.as_deref()==Some("inline"){break;}tokio::time::sleep(Duration::from_millis(10)).await;}}).await.unwrap();
        let sent:Value=serde_json::from_str(&std::fs::read_to_string(&capture).unwrap()).unwrap(); let text=sent["message"].as_str().unwrap(); assert!(text.contains("previous parent activity")); assert!(text.contains("parent digest\n\nUser message:\nhello"));
        bus.commit(|tx| {let value:String=tx.query_row("SELECT json_extract(payload_json,'$.delivery.itemIds[0]') FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id='history'",[],|r|r.get(0))?;assert_eq!(value,"old-item");Ok(((),vec![]))}).unwrap();
        detach("pi-side").await; let _=std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timed_out_pre_spawn_stop_records_generation_scoped_completion() {
        let thread = format!("pi-latch-{}", uuid::Uuid::new_v4());
        let session = format!("session-{thread}");
        let guard = StartGuard::acquire(&thread, &session).unwrap();
        let state = guard.state.clone();
        let permit = state.spawn_gate.lock().await;
        let snapshot = force_stop_snapshot(&session, &thread).unwrap();
        let stop_thread = thread.clone();
        assert!(
            !tokio::task::spawn_blocking(move || snapshot.stop(&stop_thread, 7))
                .await
                .unwrap()
        );
        drop(guard);
        drop(permit);
        let recorded = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if has_verified_stop(&session, &thread, 7) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(recorded);
        clear_verified_stop(&session, &thread, 7);
        assert!(!has_verified_stop(&session, &thread, 7));
        assert!(!has_verified_stop(&session, &thread, 8));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn force_stop_waits_for_inflight_start_process() {
        let dir = std::env::temp_dir().join(format!("t3-pi-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        let ready = dir.join("ready");
        let binary = Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/mock-pi");
        std::fs::write(&settings,json!({"providerInstances":{"pi":{"driver":"pi","enabled":true,"environment":[{"name":"T3_MOCK_PI_HANG","value":"1"},{"name":"T3_MOCK_PI_READY","value":ready}],"config":{"binaryPath":binary}}}}).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"pi","model":"openrouter/deepseek/deepseek-v4-flash"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "pi-stop-test",
                project_id: "project",
                title: "Pi",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "pi-stop-test",
                message_id: "message",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "pi",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let (effect,session)=bus.commit(|tx|Ok(((crate::outbox::get(tx,"effect:send:provider-turn.start:run:thread:pi-stop-test:ordinal:1")?.unwrap(),tx.query_row("SELECT provider_session_id FROM orchestration_v2_projection_provider_threads WHERE thread_id='pi-stop-test'",[],|r|r.get::<_,String>(0))?),vec![]))).unwrap();
        let task_bus = bus.clone();
        let task_settings = settings.clone();
        let task_dir = dir.clone();
        let task =
            tokio::spawn(
                async move { start(task_bus, &effect, &task_settings, &task_dir, None).await },
            );
        tokio::time::timeout(Duration::from_secs(5), async {
            while !ready.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let snapshot = force_stop_snapshot(&session, "pi-stop-test").expect("starting Pi snapshot");
        assert!(
            tokio::task::spawn_blocking(move || snapshot.stop("pi-stop-test", 1))
                .await
                .unwrap()
        );
        let _ = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        let count=bus.commit(|tx|Ok((tx.query_row("SELECT COUNT(*) FROM orchestration_v2_projection_provider_turns WHERE thread_id='pi-stop-test'",[],|r|r.get::<_,u64>(0))?,vec![]))).unwrap();
        assert_eq!(count, 0);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn recorded_pi_turn_admits_projects_and_completes() {
        let dir = std::env::temp_dir().join(format!("t3-pi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        let binary = Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/mock-pi");
        std::fs::write(&settings,json!({"providerInstances":{"pi":{"driver":"pi","enabled":true,"environment":[{"name":"T3_MOCK_PI_APPROVAL","value":"1"},{"name":"T3_MOCK_PI_QUESTION","value":"1"}],"config":{"binaryPath":binary,"launchArgs":"--provider openrouter --model deepseek/deepseek-v4-flash --no-extensions --no-skills --no-prompt-templates --no-context-files --approve"}}}}).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 32);
        let selection = json!({"instanceId":"pi","model":"openrouter/deepseek/deepseek-v4-flash"});
        let source = json!("web");
        create_thread_ordered(
            &bus,
            CreateThread {
                command_id: "create",
                thread_id: "pi-test",
                project_id: "project",
                title: "Pi",
                model_selection: &selection,
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &source,
                link_origin: None,
                delegated_from: None,
            },
            "e",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        dispatch_first_message(
            &bus,
            DispatchMessage {
                context: None,
                command_id: "send",
                thread_id: "pi-test",
                message_id: "message",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: "/tmp",
                driver: "pi",
            },
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                Ok((
                    crate::outbox::get(
                        tx,
                        "effect:send:provider-turn.start:run:thread:pi-test:ordinal:1",
                    )?
                    .unwrap(),
                    vec![],
                ))
            })
            .unwrap();
        start(bus.clone(), &effect, &settings, &dir, None)
            .await
            .unwrap();
        async fn wait_request(bus: &EventBus, kind: &str) -> String {
            tokio::time::timeout(Duration::from_secs(5),async {loop {
                let id=bus.commit(|tx|Ok((tx.query_row("SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE thread_id='pi-test' AND kind=?1 AND status='pending'",[kind],|row|row.get::<_,String>(0)).optional()?,vec![]))).unwrap();
                if let Some(id)=id{return id;}tokio::time::sleep(Duration::from_millis(10)).await;
            }}).await.unwrap()
        }
        let approval = wait_request(&bus, "command").await;
        super::super::acp_executor::deliver_approval(&approval, Some("accept")).unwrap();
        let question = wait_request(&bus, "user_input").await;
        super::super::pi_questions::deliver(&question, Some(&json!({"pi-question":"Blue"})))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10),async {loop {let status=bus.commit(|tx|Ok((tx.query_row("SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='pi-test'",[],|r|r.get::<_,String>(0))?,vec![]))).unwrap();if status=="completed"||status=="waiting"{let complete=bus.commit(|tx|Ok((tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE thread_id='pi-test' AND status='completed')",[],|r|r.get::<_,bool>(0))?,vec![]))).unwrap();if complete{break;}}assert_ne!(status,"failed");tokio::time::sleep(Duration::from_millis(20)).await;}}).await.unwrap();
        let result=bus.commit(|tx|Ok((tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE thread_id='pi-test' AND role='assistant'",[],|r|r.get::<_,String>(0))?,vec![]))).unwrap();
        assert_eq!(result, "fixture simple ok");
        let _ = std::fs::remove_dir_all(dir);
    }
}
