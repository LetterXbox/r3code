//! Single-owner Muse session supervisor. Commands are serialized with native notifications.
use super::{muse_events::MuseEvents, muse_session::MuseSession};
use serde_json::Value;
use std::sync::Arc;
use tokio::{
    sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};

type ResultSender = oneshot::Sender<Result<(), String>>;
type QueuedUpdate = (Result<Value, String>, OwnedSemaphorePermit);
fn enqueue(
    sender: &mpsc::Sender<QueuedUpdate>,
    budget: &Arc<Semaphore>,
    value: Result<Value, String>,
) -> Result<(), ()> {
    let size = match &value {
        Ok(value) => serde_json::to_vec(value).map_err(|_| ())?.len(),
        Err(error) => error.len(),
    };
    let units = size.div_ceil(1024).max(1);
    let permit = budget
        .clone()
        .try_acquire_many_owned(u32::try_from(units).map_err(|_| ())?)
        .map_err(|_| ())?;
    sender.try_send((value, permit)).map_err(|_| ())
}
pub(crate) enum Command {
    Start {
        id: String,
        input: Value,
        display: String,
        cwd: String,
        effort: Option<String>,
        result: ResultSender,
    },
    Interrupt {
        id: String,
        result: ResultSender,
    },
    Approval {
        approval: Value,
        decision: String,
        result: ResultSender,
    },
    Question {
        request: Value,
        answers: Value,
        result: ResultSender,
    },
    Close,
}
pub(crate) struct Runtime {
    pub(crate) commands: mpsc::Sender<Command>,
    updates: mpsc::Receiver<QueuedUpdate>,
    task: JoinHandle<()>,
}
impl Runtime {
    pub(crate) fn spawn(mut session: MuseSession) -> Self {
        let (commands, mut inbox) = mpsc::channel(64);
        let (outbox, updates) = mpsc::channel(256);
        let budget = Arc::new(Semaphore::new(16 * 1024));
        let task = tokio::spawn(async move {
            let mut current: Option<MuseEvents> = None;
            let mut active = false;
            loop {
                tokio::select! {
                    command = inbox.recv() => match command {
                        Some(Command::Start { id, input, display, cwd, effort, result }) => {
                            if active { let _ = result.send(Err("Muse turn is already active".into())); continue; }
                            let outcome = session.start_turn(&id, input, &display, &cwd, effort.as_deref()).await;
                            if outcome.is_ok() { active = true; current = Some(MuseEvents::new(session.id.clone(), id)); }
                            let _ = result.send(outcome);
                        }
                        Some(Command::Interrupt { id, result }) => { let _ = result.send(session.interrupt(&id).await); }
                        Some(Command::Approval { approval, decision, result }) => { let _ = result.send(session.decide_approval(&approval, &decision).await); }
                        Some(Command::Question { request, answers, result }) => { let _ = result.send(session.answer_questions(&request, &answers).await); }
                        Some(Command::Close) | None => break,
                    },
                    frame = session.host.next() => {
                        let Some(frame) = frame else { let _ = enqueue(&outbox, &budget, Err("Muse connection closed".into())); break; };
                        if let Some(events) = current.as_mut() {
                            match events.ingest(&frame) {
                                Ok(Some(update)) => {
                                    if frame["method"] == "turn/completed" {
                                        if !session.host.close().await { let _=enqueue(&outbox,&budget,Err("Muse process shutdown could not be verified".into())); break; }
                                        active = false;
                                    }
                                    if enqueue(&outbox, &budget, Ok(update)).is_err() { break; }
                                },
                                Ok(None) => {},
                                Err(error) => { let _ = enqueue(&outbox, &budget, Err(error)); break; }
                            }
                        }
                        if frame["params"]["sessionId"].as_str().is_none_or(|id| id == session.id) && matches!(frame["method"].as_str(),Some("approval/requested"|"approval/updated"|"approval/resolved"|"userInput/requested"|"userInput/settled"|"session/tokenUsage"|"usage/changed"|"session/todoListChanged"|"turn/retryScheduled"|"turn/modelRetryScheduled")) && enqueue(&outbox, &budget, Ok(frame)).is_err() { break; }
                    }
                }
            }
            session.host.close().await;
        });
        Self {
            commands,
            updates,
            task,
        }
    }
    pub(crate) async fn next(&mut self) -> Option<Result<Value, String>> {
        self.updates.recv().await.map(|(value, _permit)| value)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::provider::muse_msp::MuseMsp;
    use serde_json::json;
    use std::{collections::HashMap, os::unix::fs::PermissionsExt, time::Duration};
    #[tokio::test]
    async fn supervisor_retains_early_item_and_stops_at_terminal() {
        let directory =
            std::env::temp_dir().join(format!("t3-muse-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let script = directory.join("muse");
        std::fs::write(&script, r##"#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 v=json.loads(line);method=v['method']
 if method=='initialized':continue
 p=v['params']
 if method=='initialize':r={'schema':{'version':1,'fingerprint':'x'},'grantedCapabilities':[]}
 elif method=='session/start':r={'session':{'sessionId':p['sessionId']}}
 elif method=='turn/start':
  print(json.dumps({'jsonrpc':'2.0','method':'item/completed','params':{'sessionId':p['sessionId'],'item':{'itemId':'a','turnId':p['commandId'],'kind':'agentMessage','status':'completed','revision':1,'text':'hello'}}}),flush=True)
  r={'turnId':p['commandId']}
 else:r={}
 print(json.dumps({'jsonrpc':'2.0','id':v['id'],'result':r}),flush=True)
 if method=='turn/start':print(json.dumps({'jsonrpc':'2.0','method':'turn/completed','params':{'sessionId':p['sessionId'],'turnId':p['commandId'],'terminal':'completed'}}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let host = MuseMsp::launch(
            script.to_str().unwrap(),
            &directory,
            "workspace-write",
            &HashMap::new(),
        )
        .await
        .unwrap();
        let session = MuseSession::open(
            host,
            "s",
            directory.to_str().unwrap(),
            "workspace-write",
            None,
            false,
            None,
        )
        .await
        .unwrap();
        let mut runtime = Runtime::spawn(session);
        let (tx, rx) = oneshot::channel();
        runtime
            .commands
            .send(Command::Start {
                id: "t".into(),
                input: json!([]),
                display: "hello".into(),
                cwd: directory.to_string_lossy().into_owned(),
                effort: None,
                result: tx,
            })
            .await
            .unwrap();
        rx.await.unwrap().unwrap();
        let item = tokio::time::timeout(Duration::from_secs(2), runtime.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(item["text"], "hello");
        let terminal = tokio::time::timeout(Duration::from_secs(2), runtime.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(terminal["terminal"], "completed");
        let _ = runtime.commands.send(Command::Close).await;
        drop(runtime);
        let _ = std::fs::remove_dir_all(directory);
    }
}
