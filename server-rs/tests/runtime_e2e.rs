#![cfg(unix)]

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
    time::Duration,
};
use t3code_server::{
    application::Application,
    auth,
    auth_http::AuthHttpState,
    database,
    effect_worker::{EffectWorker, RuntimeExecutor, Signals},
    event_bus::EventBus,
    http_server,
    provider::{executor::CodexTurnExecutor, session_registry::SessionRegistry, CodexLaunch},
    runtime::ServerPaths,
    runtime_bootstrap,
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paired_websocket_drives_a_mock_codex_turn() {
    let root = std::env::temp_dir().join(format!("t3-e2e-{}", uuid::Uuid::new_v4()));
    let paths = ServerPaths::new(root.clone(), false, true, None);
    paths.ensure_directories(&root).unwrap();
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status()
        .unwrap()
        .success());
    std::fs::write(repo.join("file"), "first").unwrap();
    assert!(std::process::Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "add",
            "."
        ])
        .current_dir(&repo)
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-q",
            "-m",
            "initial"
        ])
        .current_dir(&repo)
        .status()
        .unwrap()
        .success());
    let binary = root.join("mock-codex");
    std::fs::write(&binary, r##"#!/usr/bin/env python3
import json,sys
turns=0
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method is None:
  assert m['id']==99 and m['result']['decision']=='accept'
  print(json.dumps({'method':'item/agentMessage/delta','params':{'threadId':'native-thread','turnId':'native-turn','itemId':'answer','delta':'hello from codex'}}),flush=True)
  print(json.dumps({'method':'item/completed','params':{'threadId':'native-thread','turnId':'native-turn','item':{'id':'app-1','type':'mcpToolCall','server':'weather','tool':'forecast','arguments':{},'result':{'content':[{'type':'text','text':'sunny'}]},'error':None,'mcpAppUi':{'resourceUri':'ui://weather/view'}}}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':'native-turn','status':'completed'}}}),flush=True)
  continue
 if method=='initialized': continue
 if method=='initialize': result={}
 elif method=='config/read': result={'config':{}}
 elif method in ('thread/start','thread/resume'): result={'thread':{'id':'native-thread'}}
 elif method=='turn/start':
  turns+=1
  assert m['params']['input'][0]['text'] in ('hello from client','second turn')
  result={'turn':{'id':'native-turn' if turns==1 else 'native-turn-2'}}
 elif method=='turn/interrupt':
  assert m['params']=={'threadId':'native-thread','turnId':'native-turn-2'}
  result={}
 elif method=='mcpServer/resource/read':
  assert m['params']=={'threadId':'native-thread','server':'weather','uri':'ui://weather/view'}
  if turns==2:
   open(sys.argv[0]+'.capture-pending','w').close()
   continue
  result={'contents':[{'uri':'ui://weather/view','mimeType':'text/html;profile=mcp-app','text':'<p>Forecast</p>'}]}
 elif method=='thread/read': result={'thread':{'id':'native-thread','historyMode':'paginated','status':{'type':'idle'}}}
 elif method=='thread/turns/list': result={'data':[{'id':'native-turn-2'}],'nextCursor':None}
 elif method=='thread/revert':
  assert m['params']=={'threadId':'native-thread','beforeTurnId':'native-turn-2'}
  result={'thread':{'id':'native-thread'}}
 else: raise Exception(method)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
 if method=='turn/interrupt':
  print(json.dumps({'method':'turn/completed','params':{'threadId':'native-thread','turn':{'id':'native-turn-2','status':'interrupted'}}}),flush=True)
 if method=='turn/start' and turns==1:
  print(json.dumps({'id':99,'method':'item/commandExecution/requestApproval','params':{'threadId':'native-thread','turnId':'native-turn','itemId':'command','command':'echo hello'}}),flush=True)
 if method=='turn/start' and turns==2:
  print(json.dumps({'method':'item/completed','params':{'threadId':'native-thread','turnId':'native-turn-2','item':{'id':'app-2','type':'mcpToolCall','server':'weather','tool':'forecast','arguments':{},'result':{'content':[{'type':'text','text':'sunny'}]},'error':None,'mcpAppUi':{'resourceUri':'ui://weather/view'}}}}),flush=True)
"##).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut persistence = runtime_bootstrap::initialize_persistence(&paths).unwrap();
    let now = chrono::Utc::now();
    let pairing = auth::issue_startup_pairing_credential(
        &mut persistence.db,
        now.timestamp_millis(),
        &now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        false,
    )
    .unwrap();
    let auth = Arc::new(AuthHttpState {
        replay_dir: std::env::temp_dir().join(format!("t3-dpop-test-{}", uuid::Uuid::new_v4())),
        environment_descriptor: std::sync::OnceLock::new(),
        cloud_action_lock: tokio::sync::Mutex::new(()),
        cloud_generation: std::sync::atomic::AtomicU64::new(0),
        cloud_connector: t3code_server::cloud_connector::Connector::default(),
        listen_address: std::sync::OnceLock::new(),
        lifecycle: Default::default(),
        db: Mutex::new(persistence.db),
        signing_key: persistence.signing_key,
        descriptor: json!({"sessionCookieName":"t3_test"}),
        trusted_origins: vec![],
        accept_legacy_cookie: true,
        desktop_bootstrap: None,
    });
    let bus = EventBus::new(database::open_writer(&paths.db_path).unwrap(), 256);
    let signals = Arc::new(Signals::default());
    bus.set_effect_signals(signals.clone());
    let sessions = Arc::new(SessionRegistry::default());
    let mut provider = CodexTurnExecutor::new(bus.clone(), sessions.clone());
    provider.attachments_dir = paths.attachments_dir.clone();
    let pending_capture = binary.with_extension("capture-pending");
    provider.launch = Arc::new(move || CodexLaunch {
        binary: Some(binary.clone()),
        ..Default::default()
    });
    let executor = RuntimeExecutor {
        terminals: Arc::new(t3code_server::terminal::TerminalManager::default()),
        bus: bus.clone(),
        worktrees_dir: paths.worktrees_dir.clone(),
        settings_path: paths.settings_path.clone(),
        provider,
    };
    let worker = EffectWorker::new(
        Arc::new(Mutex::new(database::open_writer(&paths.db_path).unwrap())),
        signals,
        Arc::new(executor),
        "e2e-worker".into(),
        5,
    )
    .with_supported_types(&[
        "provider-turn.start",
        "provider-turn.interrupt",
        "checkpoint.capture",
        "runtime-request.respond",
        "provider-thread.rollback",
    ]);
    let worker_task =
        tokio::spawn(async move { worker.run_daemon(4, Duration::from_millis(50)).await });
    let app = Arc::new(
        Application::new(auth.clone(), persistence.environment_id, "Test".into())
            .with_runtime_paths(&root, &paths)
            .with_event_bus(bus.clone())
            .with_session_registry(sessions),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(http_server::serve_with_auth(listener, app, auth, async {
        let _ = stopped.await;
    }));
    let body = json!({"credential":pairing.credential}).to_string();
    let response = tokio::task::spawn_blocking(move || {
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        write!(stream, "POST /api/auth/browser-session HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        let mut response = String::new(); stream.read_to_string(&mut response).unwrap(); response
    }).await.unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let cookie = response
        .lines()
        .find_map(|line| line.strip_prefix("set-cookie: "))
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let mut request = format!("ws://{addr}/ws?orchestrationProtocol=2")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("cookie", cookie.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let commands = [
        json!({"type":"project.create","commandId":"project-command","projectId":"project","title":"Project","workspaceRoot":repo}),
        json!({"type":"thread.create","commandId":"thread-command","threadId":"thread","projectId":"project","title":"Thread","createdBy":"user","creationSource":"web","modelSelection":{"instanceId":"codex","model":"gpt"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":repo}),
        json!({"type":"message.dispatch","commandId":"message-command","threadId":"thread","messageId":"message","text":"hello from client","attachments":[],"createdBy":"user","creationSource":"web","dispatchMode":{"type":"start_immediately"}}),
    ];
    for (id, command) in commands.into_iter().enumerate() {
        socket.send(Message::Text(json!({"_tag":"Request","id":id+1,"tag":if id == 0 {"projects.mutate"} else {"orchestration.dispatchCommand"},"payload":command,"headers":[]}).to_string().into())).await.unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["exit"]["_tag"], "Success", "{reply}");
    }
    // Subscribe from sequence zero so the same public-protocol workload can be
    // run against a separately launched implementation without inspecting its DB.
    let mut request = format!("ws://{addr}/ws?orchestrationProtocol=2")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("cookie", cookie.parse().unwrap());
    let (mut events, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    events.send(Message::Text(json!({"_tag":"Request","id":"thread-stream","tag":"orchestration.subscribeThread","payload":{"threadId":"thread","afterSequence":0},"headers":[]}).to_string().into())).await.unwrap();
    let request_id = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame: Value =
                serde_json::from_str(&events.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(frame["_tag"], "Chunk", "{frame}");
            events
                .send(Message::Text(
                    json!({"_tag":"Ack","requestId":"thread-stream"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            for item in frame["values"].as_array().unwrap() {
                if item["event"]["type"] == "runtime-request.updated"
                    && item["event"]["payload"]["status"] == "pending"
                {
                    return item["event"]["payload"]["id"].as_str().unwrap().to_owned();
                }
            }
        }
    })
    .await
    .expect("approval request did not arrive on thread stream");
    socket.send(Message::Text(json!({"_tag":"Request","id":4,"tag":"orchestration.dispatchCommand","payload":{"type":"runtime-request.respond","commandId":"approval-command","threadId":"thread","requestId":request_id,"decision":"accept"},"headers":[]}).to_string().into())).await.unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_text()
        .unwrap();
    let reply: Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["exit"]["_tag"], "Success", "{reply}");
    let mut observed_checkpoint = None;
    let mut app_attachment = None;
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut completed = false;
        let mut assistant = false;
        while !completed || !assistant {
            let frame: Value =
                serde_json::from_str(&events.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(frame["_tag"], "Chunk", "{frame}");
            events
                .send(Message::Text(
                    json!({"_tag":"Ack","requestId":"thread-stream"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            for item in frame["values"].as_array().unwrap() {
                let event = &item["event"];
                if let Some(app) = event.pointer("/payload/output/t3McpApp") {
                    app_attachment = app["attachmentId"].as_str().map(str::to_owned);
                }
                if event["type"] == "checkpoint.captured"
                    && event["payload"]["appRunOrdinal"] == 1
                    && event["payload"]["status"] == "ready"
                {
                    observed_checkpoint = Some(event["payload"].clone());
                }
                completed |=
                    event["type"] == "run.updated" && event["payload"]["status"] == "completed";
                if completed {
                    assert!(
                        app_attachment.is_some(),
                        "turn settled before MCP capture: {event}"
                    );
                }
                assistant |= event["type"] == "message.updated"
                    && event["payload"]["role"] == "assistant"
                    && event["payload"]["text"] == "hello from codex";
            }
        }
    })
    .await
    .expect("provider completion did not arrive on thread stream");
    let html = std::fs::read_to_string(
        paths
            .attachments_dir
            .join(format!("{}.html", app_attachment.unwrap())),
    )
    .unwrap();
    assert!(html.contains("<p>Forecast</p>"));
    assert!(html.contains("Content-Security-Policy"));
    // Wait for the first checkpoint before changing the working tree.
    let checkpoint = tokio::time::timeout(Duration::from_secs(10), async {
        if let Some(checkpoint) = observed_checkpoint {
            return checkpoint;
        }
        loop {
            let frame: Value =
                serde_json::from_str(&events.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            events
                .send(Message::Text(
                    json!({"_tag":"Ack","requestId":"thread-stream"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            for item in frame["values"].as_array().unwrap() {
                let e = &item["event"];
                if e["type"] == "checkpoint.captured"
                    && e["payload"]["appRunOrdinal"] == 1
                    && e["payload"]["status"] == "ready"
                {
                    return e["payload"].clone();
                }
            }
        }
    })
    .await
    .expect("first checkpoint did not arrive");
    std::fs::write(repo.join("file"), "second").unwrap();
    socket.send(Message::Text(json!({"_tag":"Request","id":5,"tag":"orchestration.dispatchCommand","payload":{"type":"message.dispatch","commandId":"second-command","threadId":"thread","messageId":"message-2","text":"second turn","attachments":[],"createdBy":"user","creationSource":"web","dispatchMode":{"type":"start_immediately"}},"headers":[]}).to_string().into())).await.unwrap();
    let reply: Value =
        serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(reply["exit"]["_tag"], "Success", "{reply}");
    let run_id = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame: Value =
                serde_json::from_str(&events.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            events
                .send(Message::Text(
                    json!({"_tag":"Ack","requestId":"thread-stream"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            for item in frame["values"].as_array().unwrap() {
                let event = &item["event"];
                if event["type"] == "run.updated"
                    && event["payload"]["ordinal"] == 2
                    && event["payload"]["status"] == "running"
                {
                    return event["payload"]["id"].as_str().unwrap().to_owned();
                }
            }
        }
    })
    .await
    .expect("second run did not start");
    tokio::time::timeout(Duration::from_secs(10), async {
        while !pending_capture.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("second MCP capture did not start");
    socket.send(Message::Text(json!({"_tag":"Request","id":"stop","tag":"orchestration.dispatchCommand","payload":{"type":"run.interrupt","commandId":"stop-command","threadId":"thread","runId":run_id},"headers":[]}).to_string().into())).await.unwrap();
    let reply: Value =
        serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(reply["exit"]["_tag"], "Success", "{reply}");
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut interrupted = false;
        let mut checkpointed = false;
        let mut uncaptured_item = false;
        while !interrupted || !checkpointed {
            let frame: Value =
                serde_json::from_str(&events.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            events
                .send(Message::Text(
                    json!({"_tag":"Ack","requestId":"thread-stream"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            for item in frame["values"].as_array().unwrap() {
                let event = &item["event"];
                if event["type"] == "turn-item.updated"
                    && event["payload"]["nativeItemRef"]["nativeId"] == "app-2"
                {
                    assert!(event.pointer("/payload/output/t3McpApp").is_none());
                    uncaptured_item = true;
                }
                interrupted |= event["type"] == "run.updated"
                    && event["payload"]["id"] == run_id
                    && event["payload"]["status"] == "interrupted";
                checkpointed |= event["type"] == "checkpoint.captured"
                    && event["payload"]["appRunOrdinal"] == 2
                    && event["payload"]["status"] == "ready";
            }
        }
        assert!(
            uncaptured_item,
            "interruption dropped the original MCP tool result"
        );
    })
    .await
    .expect("interrupted run or its checkpoint did not arrive");
    assert_eq!(
        std::fs::read_dir(&paths.attachments_dir).unwrap().count(),
        1
    );
    socket.send(Message::Text(json!({"_tag":"Request","id":6,"tag":"orchestration.dispatchCommand","payload":{"type":"checkpoint.rollback","commandId":"rewind","threadId":"thread","checkpointId":checkpoint["id"],"scopeId":checkpoint["scopeId"]},"headers":[]}).to_string().into())).await.unwrap();
    let reply: Value =
        serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(reply["exit"]["_tag"], "Success", "{reply}");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame: Value =
                serde_json::from_str(&events.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            events
                .send(Message::Text(
                    json!({"_tag":"Ack","requestId":"thread-stream"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            if frame["values"].as_array().unwrap().iter().any(|item| {
                item["event"]["type"] == "run.updated"
                    && item["event"]["payload"]["status"] == "rolled_back"
            }) {
                break;
            }
        }
    })
    .await
    .expect("rollback did not complete");
    assert_eq!(std::fs::read_to_string(repo.join("file")).unwrap(), "first");
    events.close(None).await.unwrap();
    socket.close(None).await.unwrap();
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    worker_task.abort();
    let _ = worker_task.await;
    drop(bus);
    std::fs::remove_dir_all(root).unwrap();
}
