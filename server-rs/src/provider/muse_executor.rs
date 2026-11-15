//! Muse turn admission. Execution remains isolated until lifecycle integration is complete.
use crate::{
    event_bus::EventBus,
    outbox::Effect,
    provider::{
        codex_events::RootTurn,
        muse_msp::MuseMsp,
        muse_session::{self, MuseSession},
        session_registry,
    },
};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,Ordering}},
};
struct ActiveTurn { thread:String, turn:String, native:String, commands:tokio::sync::mpsc::Sender<super::muse_runtime::Command>, gate:Arc<tokio::sync::Mutex<()>>, cancelled:Arc<AtomicBool> }
static ACTIVE:OnceLock<Mutex<HashMap<String,ActiveTurn>>> = OnceLock::new();
static STARTING:OnceLock<Mutex<HashMap<String,Arc<AtomicBool>>>> = OnceLock::new();
fn active()->&'static Mutex<HashMap<String,ActiveTurn>> { ACTIVE.get_or_init(||Mutex::new(HashMap::new())) }
fn starting()->&'static Mutex<HashMap<String,Arc<AtomicBool>>> { STARTING.get_or_init(||Mutex::new(HashMap::new())) }
struct StartGuard { thread:String, cancelled:Arc<AtomicBool> }
impl StartGuard {
    fn acquire(thread:&str)->Result<Self,String> { let mut map=starting().lock().map_err(|_|"Muse start registry unavailable")?; if map.contains_key(thread){return Err("Muse turn is already starting".into());} let cancelled=Arc::new(AtomicBool::new(false));map.insert(thread.to_owned(),cancelled.clone());Ok(Self{thread:thread.to_owned(),cancelled}) }
}
impl Drop for StartGuard { fn drop(&mut self){if let Ok(mut map)=starting().lock(){if map.get(&self.thread).is_some_and(|value|Arc::ptr_eq(value,&self.cancelled)){map.remove(&self.thread);}}} }
struct ActiveGuard { key:String, turn:String }
impl Drop for ActiveGuard {fn drop(&mut self){if let Ok(mut map)=active().lock(){if map.get(&self.key).is_some_and(|entry|entry.turn==self.turn){map.remove(&self.key);}}}}

pub(crate) fn execute<'a>(bus:&'a EventBus,effect:&'a Effect,settings_path:Option<&'a Path>,mcp:Option<(&'a str,&'a Arc<session_registry::SessionRegistry>)>) -> crate::effect_worker::Execution<'a> {
    Box::pin(async move {
        match effect.request["type"].as_str() {
            Some("provider-turn.start") => {
                let guard=StartGuard::acquire(&effect.thread_id)?;
                let bus=bus.clone();let effect=effect.clone();let settings=settings_path.map(Path::to_owned);
                let mcp=mcp.map(|(endpoint,registry)|(endpoint.to_owned(),registry.clone()));
                let (tx,rx)=tokio::sync::oneshot::channel();
                tokio::spawn(async move {
                    let mut ready=Some(tx);
                    let result=async {
                        let config=if let Some((endpoint,registry))=mcp { let instance=bus.commit(|db|{let id:String=db.query_row("SELECT json_extract(p.payload_json,'$.providerInstanceId') FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=r.provider_thread_id WHERE r.run_id=?1 AND r.thread_id=?2",params![effect.request["runId"].as_str(),effect.thread_id],|row|row.get(0))?;Ok((id,vec![]))}).map_err(|e|e.to_string())?;let authorization=registry.prepare_mcp(&effect.thread_id,&instance,false)?;Some(serde_json::json!({"mcpServers":{"t3-code":{"transport":"streamableHttp","mode":"optional","url":endpoint,"headers":{"Authorization":authorization}}}}))} else {None};
                        let Some(admitted)=admit(&bus,&effect,settings.as_deref(),config.as_ref()).await? else{return Ok(())};
                        if guard.cancelled.load(Ordering::Acquire){return Ok(());}
                        drive_inner(&bus,admitted,guard.cancelled.clone(),&mut ready).await
                    }.await;
                    if let Some(tx)=ready.take(){let _=tx.send(result);} else if let Err(error)=result {eprintln!("Muse supervisor failed: {error}");}
                    drop(guard);
                });
                rx.await.map_err(|_|"Muse supervisor stopped before admission".to_owned())?
            }
            Some("provider-turn.interrupt") => {
                let turn=effect.request["providerTurnId"].as_str().ok_or("Missing Muse provider turn")?;
                let selected=active().lock().map_err(|_|"Muse registry unavailable")?.values().find(|entry|entry.thread==effect.thread_id && entry.turn==turn).map(|entry|(entry.commands.clone(),entry.gate.clone(),entry.cancelled.clone(),entry.native.clone()));
                if let Some((commands,gate,cancelled,native))=selected {let _permit=gate.lock().await;cancelled.store(true,Ordering::Release);super::muse_requests::cancel_thread(&effect.thread_id);let (result,reply)=tokio::sync::oneshot::channel();commands.send(super::muse_runtime::Command::Interrupt{id:native,result}).await.map_err(|_|"Muse supervisor stopped")?;reply.await.map_err(|_|"Muse interrupt stopped".to_owned())?}
                else if let Some(flag)=starting().lock().map_err(|_|"Muse start registry unavailable")?.get(&effect.thread_id).cloned(){flag.store(true,Ordering::Release);Ok(())} else {Err("Muse turn is not active".into())}
            }
            _ => Err("Muse operation is not supported".into()),
        }
    })
}

pub(crate) struct AdmittedTurn {
    pub(crate) session: MuseSession,
    pub(crate) turn: RootTurn,
    pub(crate) run: Value,
    pub(crate) provider_thread: Value,
    pub(crate) message: Value,
    pub(crate) cwd: String,
    pub(crate) workspace: (
        crate::workspace_safety::Reservation,
        Option<crate::workspace_safety::WorkspaceLease>,
    ),
}

pub(crate) async fn admit(
    bus: &EventBus,
    effect: &Effect,
    settings_path: Option<&Path>,
    mcp: Option<&Value>,
) -> Result<Option<AdmittedTurn>, String> {
    if effect.attempt_count > 1 {
        return Err("Cannot safely replay an uncertain Muse turn start".into());
    }
    if crate::managed_policy::has_provider_restrictions()? {
        return Err("Muse launch is unavailable under managed provider restrictions".into());
    }
    let run_id = effect.request["runId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Missing run ID")?
        .to_owned();
    let selected = bus.commit(|tx| {
        let raw: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting'", params![run_id,effect.thread_id], |row| row.get(0)).optional()?;
        let Some(raw) = raw else { return Ok((None, vec![])); };
        let parse = |raw: String| serde_json::from_str::<Value>(&raw).map_err(|_| rusqlite::Error::InvalidQuery);
        let run = parse(raw)?;
        let pt = parse(tx.query_row("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1", [run["providerThreadId"].as_str()], |row| row.get(0))?)?;
        let message = parse(tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1", [run["userMessageId"].as_str()], |row| row.get(0))?)?;
        let thread = parse(tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?1", [&effect.thread_id], |row| row.get(0))?)?;
        let cwd: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.cwd') FROM orchestration_v2_projection_checkpoint_scopes WHERE run_id=?1 AND kind='root_run'", [&run_id], |row| row.get(0)).optional()?.flatten();
        let ordinal: u64 = tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id=?1", [run["providerThreadId"].as_str()], |row| row.get(0))?;
        Ok((Some((run,pt,message,thread,cwd,ordinal)),vec![]))
    }).map_err(|error| error.to_string())?;
    let Some((run, pt, message, thread, cwd, ordinal)) = selected else {
        return Ok(None);
    };
    if pt["driver"] != "muse" {
        return Err("Invalid Muse provider thread".into());
    }
    if thread["interactionMode"] == "plan" {
        return Err("Muse Code does not support dedicated Plan mode".into());
    }
    let mode = thread["runtimeMode"]
        .as_str()
        .unwrap_or("approval-required");
    crate::managed_policy::check_runtime_mode(mode)?;
    let cwd = cwd
        .or_else(|| thread["worktreePath"].as_str().map(str::to_owned))
        .ok_or("Muse workspace is unavailable")?;
    let canonical = std::fs::canonicalize(&cwd).map_err(|_| "Muse workspace is unavailable")?;
    if !canonical.is_dir() {
        return Err("Muse workspace is unavailable".into());
    }
    let cwd = canonical.to_string_lossy().into_owned();
    let workspace_path = canonical.clone();
    let worktree = thread["worktreePath"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let workspace = tokio::task::spawn_blocking(move || {
        let reservation = crate::workspace_safety::reserve(
            workspace_path,
            crate::workspace_safety::ReservationKind::TurnStart,
        );
        let lease = worktree.map(crate::workspace_safety::workspace_lease);
        (reservation, lease)
    })
    .await
    .map_err(|error| error.to_string())?;
    let still_starting = bus.commit(|tx| { let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id=?1 AND thread_id=?2 AND status='starting')", params![run_id,effect.thread_id], |row| row.get(0))?; Ok((active,vec![])) }).map_err(|error| error.to_string())?;
    if !still_starting {
        return Ok(None);
    }
    let instance = pt["providerInstanceId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Missing Muse instance")?;
    let settings = session_registry::read_provider_settings(settings_path)?;
    let entry = &settings["providerInstances"][instance];
    if entry["driver"] != "muse"
        || entry["enabled"]
            .as_bool()
            .or_else(|| entry["config"]["enabled"].as_bool())
            != Some(true)
    {
        return Err("Muse Code is disabled".into());
    }
    let binary = entry["config"]["binaryPath"]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("muse");
    let binary = if let Some(rest) = binary.strip_prefix("~/") {
        PathBuf::from(std::env::var_os("HOME").ok_or("Muse home is unavailable")?)
            .join(rest)
            .to_string_lossy()
            .into_owned()
    } else {
        binary.to_owned()
    };
    let mut environment = HashMap::new();
    if let Some(values) = entry["environment"].as_array() {
        for value in values {
            let name = value["name"]
                .as_str()
                .filter(|name| {
                    !name.is_empty()
                        && name.chars().enumerate().all(|(i, c)| {
                            c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                        })
                })
                .ok_or("Invalid Muse environment")?;
            let resolved =
                if let Some(secret) = value.get("secret").filter(|value| !value.is_null()) {
                    crate::mcp_secret::resolve_reference(&settings, secret)
                        .await
                        .ok_or("Unresolved Muse credential")?
                } else {
                    value["value"]
                        .as_str()
                        .ok_or("Invalid Muse environment")?
                        .to_owned()
                };
            environment.insert(name.to_owned(), resolved);
        }
    }
    let existing = pt["nativeThreadRef"]["nativeId"]
        .as_str()
        .filter(|id| !id.is_empty());
    let native_session = existing
        .map(str::to_owned)
        .unwrap_or(muse_session::command_id()?);
    let native_turn = muse_session::command_id()?;
    let host = MuseMsp::launch(&binary, &canonical, mode, &environment).await?;
    let model = run["modelSelection"]["model"]
        .as_str()
        .filter(|model| *model != "default");
    let session = MuseSession::open(
        host,
        &native_session,
        &cwd,
        mode,
        model,
        existing.is_some(),
        mcp,
    )
    .await?;
    let turn = RootTurn {
        driver: "muse".into(),
        native_thread_id: native_session,
        native_turn_id: native_turn.clone(),
        provider_thread_id: pt["id"]
            .as_str()
            .ok_or("Missing Muse provider thread")?
            .into(),
        provider_turn_id: format!(
            "provider-turn:provider:muse:native-turn:{}",
            crate::message_commands::encode_id_part(&native_turn)
        ),
        thread_id: effect.thread_id.clone(),
        run_id: Some(run_id),
        run_attempt_id: run["activeAttemptId"]
            .as_str()
            .ok_or("Missing attempt")?
            .into(),
        root_node_id: run["rootNodeId"]
            .as_str()
            .ok_or("Missing root node")?
            .into(),
        provider_turn_ordinal: ordinal,
        run_ordinal: run["ordinal"].as_u64().unwrap_or(1),
        started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    Ok(Some(AdmittedTurn {
        session,
        turn,
        run,
        provider_thread: pt,
        message,
        cwd,
        workspace,
    }))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    async fn exercise_turn(approval: bool) {
        let root = std::env::temp_dir().join(format!("t3-muse-admit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/mock-muse");
        let settings = root.join("settings.json");
        std::fs::write(&settings, json!({"providerInstances":{"muse":{"driver":"muse","enabled":true,"config":{"binaryPath":script},"environment":[{"name":"MOCK_MUSE_APPROVAL","value":if approval {"1"} else {"0"}},{"name":"MOCK_MUSE_EXPECT_CONTEXT","value":"parent digest"}]}}}).to_string()).unwrap();
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let thread_id = if approval {
            "t-muse-approval"
        } else {
            "t-muse"
        };
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "create",
                thread_id,
                project_id: "p",
                title: "T",
                model_selection: &json!({"instanceId":"muse","model":"default"}),
                runtime_mode: "approval-required",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &json!("web"),
                link_origin: None,
                delegated_from: None,
            },
            "event",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        crate::message_commands::dispatch_first_message(
            &bus,
            crate::message_commands::DispatchMessage {
                context: None,
                command_id: "send",
                thread_id,
                message_id: "m-muse",
                text: "hello",
                attachments: &[],
                creation_source: "web",
                cwd: root.to_str().unwrap(),
                driver: "muse",
            },
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap();
        let effect = bus
            .commit(|tx| {
                tx.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.sideChat',json('true')) WHERE thread_id=?1", [thread_id])?;
                let provider: String = tx.query_row("SELECT provider_thread_id FROM orchestration_v2_projection_runs WHERE thread_id=?1", [thread_id], |r| r.get(0))?;
                let run: String = tx.query_row("SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=?1", [thread_id], |r| r.get(0))?;
                let handoff = json!({"id":"side-digest","threadId":thread_id,"targetRunId":run,"toProviderThreadId":provider,"strategy":"manual_context","transferId":"fork","summaryText":"parent digest"});
                tx.execute("INSERT INTO orchestration_v2_projection_context_handoffs(context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json) VALUES('side-digest',?1,?2,?3,'manual_context','ready','now',?4)", rusqlite::params![thread_id,run,provider,handoff.to_string()])?;
                let effect = crate::outbox::list_by_command_id(tx, "send")?
                    .into_iter()
                    .find(|effect| effect.request["type"] == "provider-turn.start")
                    .unwrap();
                Ok((effect, vec![]))
            })
            .unwrap();
        let admitted = admit(&bus, &effect, Some(&settings), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(admitted.turn.driver, "muse");
        assert_eq!(admitted.message["text"], "hello");
        assert_eq!(
            uuid::Uuid::parse_str(&admitted.turn.native_turn_id)
                .unwrap()
                .get_version_num(),
            7
        );
        if approval {
            let task_bus = bus.clone();
            let task = tokio::spawn(async move { drive(&task_bus, admitted).await });
            let mut request_id = None;
            for _ in 0..100 {
                request_id=bus.commit(|tx| { let id:Option<String>=tx.query_row("SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE thread_id=?1 AND status='pending'",[thread_id],|row|row.get(0)).optional()?; Ok((id,vec![])) }).unwrap();
                if request_id.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            let request_id=request_id.as_deref().expect("Muse approval projected");
            let rejected=super::super::codex_requests::respond_command(&bus,"invalid-answer",thread_id,request_id,Some("acceptAlways"),None,"2026-01-01T00:00:02.000Z").unwrap();
            assert_eq!(rejected.receipt.status,"rejected");
            let accepted=super::super::codex_requests::respond_command(&bus,"answer",thread_id,request_id,Some("accept"),None,"2026-01-01T00:00:03.000Z").unwrap();
            assert_eq!(accepted.receipt.status,"accepted");
            super::super::muse_requests::deliver(request_id,"accept").unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        } else {
            drive(&bus, admitted).await.unwrap();
        }
        bus.commit(|tx| {
            let text:String=tx.query_row("SELECT json_extract(payload_json,'$.text') FROM orchestration_v2_projection_messages WHERE thread_id=?1 AND role='assistant'",[thread_id],|row|row.get(0))?;
            assert_eq!(text,"hello from muse");
            let status: String = tx.query_row("SELECT json_extract(payload_json,'$.delivery.status') FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id='side-digest'", [], |r| r.get(0))?;
            assert_eq!(status,"inline");
            Ok(((),vec![]))
        }).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn admission_uses_owned_run_and_opens_native_session() {
        exercise_turn(false).await;
    }
    #[tokio::test]
    async fn live_approval_is_projected_and_delivered() {
        exercise_turn(true).await;
    }
}

/// Drive an admitted turn. This helper is deliberately not routed until all
/// approval, workflow and cancellation branches are implemented and compared.
#[cfg(test)]
pub(crate) async fn drive(bus: &EventBus, admitted: AdmittedTurn) -> Result<(), String> {
    drive_inner(bus,admitted,Arc::new(AtomicBool::new(false)),&mut None).await
}
async fn drive_inner(bus: &EventBus, admitted: AdmittedTurn, cancelled:Arc<AtomicBool>, ready:&mut Option<tokio::sync::oneshot::Sender<Result<(),String>>>) -> Result<(), String> {
    use super::{
        ingest, lifecycle,
        muse_projection::MuseProjection,
        muse_runtime::{Command, Runtime},
    };
    if admitted.message["attachments"]
        .as_array()
        .is_some_and(|values| !values.is_empty())
    {
        return Err("Muse attachments are not yet supported".into());
    }
    let AdmittedTurn {
        session,
        turn,
        run,
        provider_thread,
        message,
        cwd,
        workspace: _workspace,
    } = admitted;
    let provider_session = provider_thread["providerSessionId"]
        .as_str()
        .ok_or("Missing Muse provider session")?
        .to_owned();
    let mut runtime = Runtime::spawn(session);
    let gate=Arc::new(tokio::sync::Mutex::new(()));
    let permit=gate.lock().await;
    if cancelled.load(Ordering::Acquire){return Ok(());}
    {
        let mut map=active().lock().map_err(|_|"Muse registry unavailable")?;
        if map.contains_key(&turn.provider_thread_id){return Err("Muse provider thread already has an active turn".into());}
        map.insert(turn.provider_thread_id.clone(),ActiveTurn {thread:turn.thread_id.clone(),turn:turn.provider_turn_id.clone(),native:turn.native_turn_id.clone(),commands:runtime.commands.clone(),gate:gate.clone(),cancelled:cancelled.clone()});
    }
    let _active_guard=ActiveGuard{key:turn.provider_thread_id.clone(),turn:turn.provider_turn_id.clone()};
    let side_chat = if !crate::context_handoff::defers_handoff_context(&message) {
        bus.commit(|tx| {
            let side: bool = tx.query_row("SELECT COALESCE(json_extract(payload_json,'$.lineage.sideChat'),0) FROM orchestration_v2_projection_threads WHERE thread_id=?1", [&turn.thread_id], |r| r.get(0))?;
            let pending = super::executor::pending_handoffs(tx, Some(&turn.provider_thread_id), turn.run_id.as_deref().ok_or(rusqlite::Error::InvalidQuery)?)?;
            Ok((crate::context_handoff::split_side_chat_handoff(pending, side).1, vec![]))
        }).map_err(|e| e.to_string())?
    } else { None };
    let prompt_text = crate::context_handoff::with_side_chat_context("", side_chat.as_ref(), message["text"].as_str().unwrap_or(""));
    let prompt = crate::composer_context::project(&prompt_text, message.get("context"));
    let (reply, acknowledged) = tokio::sync::oneshot::channel();
    lifecycle::start(
        bus,
        &turn,
        provider_thread,
        &run,
        Some(&cwd),
        serde_json::json!({"runtimePolicy":{"enforcement":"native"},"turns":{"supportsInterrupt":true},"streaming":{"streamsAssistantText":true,"streamsReasoning":true}}),
    )?;
    let mut projection = MuseProjection::new(turn.clone());
    let _approval_guard = ApprovalGuard {
        thread: turn.thread_id.clone(),
        cancelled: cancelled.clone(),
    };
    let (approval_errors, mut approval_results) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut approval_ordinal = turn
        .run_ordinal
        .saturating_mul(1_000_000)
        .saturating_add(700_000);
    let mut usage = serde_json::json!({});
    if cancelled.load(Ordering::Acquire){return fail_drive(bus,&mut projection,"Muse turn cancelled during startup");}
    if runtime
        .commands
        .send(Command::Start {
            id: turn.native_turn_id.clone(),
            input: serde_json::json!([{"type":"text","text":prompt}]),
            display: message["text"].as_str().unwrap_or("").to_owned(),
            cwd,
            effort: None,
            result: reply,
        })
        .await
        .is_err()
    {
        return fail_drive(bus, &mut projection, "Muse supervisor stopped");
    }
    let result = match acknowledged.await {
        Ok(result) => result,
        Err(_) => return fail_drive(bus, &mut projection, "Muse turn admission stopped"),
    };
    drop(permit);
    if let Err(error) = result {
        let terminal = serde_json::json!({"terminal":"failed","error":{"message":error}});
        let updates = projection.terminal(
            &terminal,
            false,
            &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )?;
        ingest::ingest(bus, &updates).map_err(|error| error.to_string())?;
        if let Some(ready)=ready.take(){let _=ready.send(Ok(()));}
        return Ok(());
    }
    if let Some(handoff) = side_chat {
        if let Err(error) = super::executor::record_side_chat_delivery(bus, &turn, handoff) {
            eprintln!("Warning: failed to record accepted Muse side-chat context delivery: {error}");
        }
    }
    if let Some(ready)=ready.take(){let _=ready.send(Ok(()));}
    loop {
        let update =
            match tokio::time::timeout(std::time::Duration::from_secs(600), async { tokio::select! { update = runtime.next() => update, error = approval_results.recv() => error.map(Err) } }).await {
                Ok(Some(Ok(value))) => value,
                Ok(Some(Err(error))) => return fail_drive(bus, &mut projection, &error),
                Ok(None) => return fail_drive(bus, &mut projection, "Muse supervisor stopped"),
                Err(_) => return fail_drive(bus, &mut projection, "Muse turn timed out"),
            };
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        if update["method"] == "approval/requested" {
            let approval = update["params"].clone();
            if !approval["subagentOrigin"].is_null() {
                return fail_drive(
                    bus,
                    &mut projection,
                    "Muse child approvals are not yet supported",
                );
            }
            let receiver = match super::muse_requests::project(
                bus,
                &turn,
                &provider_session,
                &approval,
                approval_ordinal,
                &cancelled,
            ) {
                Ok(receiver) => receiver,
                Err(error) => return fail_drive(bus, &mut projection, &error),
            };
            approval_ordinal = approval_ordinal.saturating_add(1);
            let commands = runtime.commands.clone();
            let feedback = approval_errors.clone();
            let cancelled = cancelled.clone();
            tokio::spawn(async move {
                let decision = match tokio::time::timeout(
                    std::time::Duration::from_secs(1800),
                    receiver,
                )
                .await
                {
                    Ok(Ok(decision)) => decision,
                    Ok(Err(_)) => return,
                    Err(_) => {
                        let _ = feedback.send("Muse approval expired".into());
                        return;
                    }
                };
                if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                let (result, reply) = tokio::sync::oneshot::channel();
                if commands
                    .send(Command::Approval {
                        approval,
                        decision,
                        result,
                    })
                    .await
                    .is_err()
                    || !matches!(reply.await, Ok(Ok(())))
                {
                    let _ = feedback.send("Muse approval delivery failed".into());
                }
            });
            continue;
        }
        if update["method"] == "approval/resolved" {
            if let Some(native) = update["params"]["approvalId"].as_str() {
                super::muse_requests::cancel_native(bus, &turn, native);
            }
            continue;
        }
        if update["method"] == "session/tokenUsage" {
            usage = match super::muse_events::merge_token_usage(
                &usage,
                &update["params"],
                false,
                false,
            ) {
                Ok(value) => value,
                Err(error) => return fail_drive(bus, &mut projection, &error),
            };
            let event = super::codex_events::NormalizedEvent::TokenUsageUpdated {
                turn: turn.clone(),
                usage: usage.clone(),
                at: at.clone(),
            };
            ingest::ingest(bus, &[event]).map_err(|error| error.to_string())?;
            continue;
        }
        let (terminal, events) = if update.get("itemId").is_some() {
            let events = match projection.item(&update, &at) {
                Ok(events) => events,
                Err(error) => return fail_drive(bus, &mut projection, &error),
            };
            (false, events)
        } else if update.get("terminal").is_some() {
            if update.get("usage").is_some() {
                let final_usage =
                    match super::muse_events::merge_token_usage(&usage, &update, true, false) {
                        Ok(value) => value,
                        Err(error) => return fail_drive(bus, &mut projection, &error),
                    };
                let event = super::codex_events::NormalizedEvent::TokenUsageUpdated {
                    turn: turn.clone(),
                    usage: final_usage,
                    at: at.clone(),
                };
                ingest::ingest(bus, &[event]).map_err(|error| error.to_string())?;
            }
            (true, projection.terminal(&update, cancelled.load(Ordering::Acquire), &at)?)
        } else {
            return fail_drive(
                bus,
                &mut projection,
                "Muse runtime request or background event is not yet supported",
            );
        };
        ingest::ingest(bus, &events).map_err(|error| error.to_string())?;
        if terminal {
            let _ = runtime.commands.send(Command::Close).await;
            return Ok(());
        }
    }
}

struct ApprovalGuard {
    thread: String,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Drop for ApprovalGuard {
    fn drop(&mut self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::Release);
        super::muse_requests::cancel_thread(&self.thread);
    }
}

fn fail_drive(
    bus: &EventBus,
    projection: &mut super::muse_projection::MuseProjection,
    error: &str,
) -> Result<(), String> {
    let terminal = serde_json::json!({"terminal":"failed","error":{"message":error}});
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let updates = projection.terminal(&terminal, false, &at)?;
    super::ingest::ingest(bus, &updates).map_err(|error| error.to_string())?;
    Ok(())
}
