//! Muse Server Protocol transport: bounded newline-delimited JSON-RPC.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot, Mutex, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};

const FRAME_LIMIT: usize = 10_485_760;
const QUEUE_LIMIT: usize = 16 * 1024 * 1024;
type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
struct PendingGuard {
    pending: Pending,
    id: u64,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}
struct WriteGuard {
    child: Arc<Mutex<Child>>,
    closed: Arc<AtomicBool>,
    armed: bool,
    pgid: Option<i32>,
}
impl Drop for WriteGuard {
    fn drop(&mut self) {
        if self.armed {
            self.closed.store(true, Ordering::Release);
            let child = self.child.clone();
            let pgid = self.pgid;
            tokio::spawn(async move {
                let _ = super::pi_rpc::stop_child(&child, pgid).await;
            });
        }
    }
}

pub(crate) struct MuseMsp {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    closed: Arc<AtomicBool>,
    incoming: mpsc::Receiver<(Value, OwnedSemaphorePermit)>,
    reader: JoinHandle<()>,
    next_id: u64,
    pgid: Option<i32>,
}

impl MuseMsp {
    pub(crate) async fn launch(
        binary: &str,
        cwd: &Path,
        runtime_mode: &str,
        environment: &HashMap<String, String>,
    ) -> Result<Self, String> {
        if !cfg!(unix) { return Err("Muse process-tree isolation is unavailable on this platform".into()); }
        let mut command = Command::new(binary);
        command
            .arg("serve")
            .arg("--trust-workspace")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)] { use std::os::unix::process::CommandExt; command.as_std_mut().process_group(0); }
        #[cfg(target_os="linux")]
        unsafe {
            let parent=libc::getpid();
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG,libc::SIGTERM)!=0 {return Err(std::io::Error::last_os_error());}
                if libc::getppid()!=parent {return Err(std::io::Error::other("Muse parent exited during launch"));}
                Ok(())
            });
        }
        if runtime_mode == "full-access" {
            command.arg("--disable-sandbox");
        }
        command
            .env_remove("META_API_KEY")
            .env("MUSE_NO_AUTO_UPDATE", "1");
        command.envs(environment);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start Muse: {error}"))?;
        let pgid=child.id().and_then(|id|i32::try_from(id).ok());
        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("Missing Muse stdin")?));
        let stdout = child.stdout.take().ok_or("Missing Muse stdout")?;
        let child = Arc::new(Mutex::new(child));
        let reader_child = child.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let reader_closed = closed.clone();
        let pending = Arc::new(StdMutex::new(HashMap::<
            u64,
            oneshot::Sender<Result<Value, String>>,
        >::new()));
        let pending_reader = pending.clone();
        let reader_input = stdin.clone();
        let (sender, incoming) = mpsc::channel(256);
        let queue_budget = Arc::new(Semaphore::new(QUEUE_LIMIT.div_ceil(1024)));
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let size = match (&mut reader)
                    .take((FRAME_LIMIT + 1) as u64)
                    .read_until(b'\n', &mut line)
                    .await
                {
                    Ok(size) => size,
                    Err(_) => break,
                };
                if size == 0 || size > FRAME_LIMIT || line.last() != Some(&b'\n') {
                    break;
                }
                let Ok(frame) = serde_json::from_slice::<Value>(&line) else {
                    break;
                };
                if frame["jsonrpc"] != "2.0" {
                    break;
                }
                if frame.get("method").is_none() {
                    let Some(id) = frame["id"].as_u64() else {
                        break;
                    };
                    let waiter = pending_reader
                        .lock()
                        .ok()
                        .and_then(|mut pending| pending.remove(&id));
                    if let Some(waiter) = waiter {
                        let result = if let Some(error) = frame.get("error") {
                            Err(format!("Muse RPC error: {error}"))
                        } else if let Some(value) = frame.get("result") {
                            Ok(value.clone())
                        } else {
                            Err("Invalid Muse response".into())
                        };
                        let _ = waiter.send(result);
                    }
                } else if let Some(id) = frame.get("id") {
                    let response = if matches!(
                        frame["method"].as_str(),
                        Some("approval/request" | "userInput/request")
                    ) {
                        json!({"jsonrpc":"2.0","id":id,"result":{}})
                    } else {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found","data":{"kind":"methodNotFound","retryable":false}}})
                    };
                    let Ok(mut bytes) = serde_json::to_vec(&response) else {
                        break;
                    };
                    bytes.push(b'\n');
                    if !matches!(
                        tokio::time::timeout(Duration::from_secs(30), async {
                            reader_input.lock().await.write_all(&bytes).await
                        })
                        .await,
                        Ok(Ok(()))
                    ) {
                        break;
                    }
                } else {
                    let units = size.div_ceil(1024).max(1);
                    let Ok(permit) = queue_budget.clone().try_acquire_many_owned(units as u32)
                    else {
                        break;
                    };
                    if sender.try_send((frame, permit)).is_err() {
                        break;
                    }
                }
            }
            reader_closed.store(true, Ordering::Release);
            if let Ok(mut pending) = pending_reader.lock() {
                for (_, waiter) in pending.drain() {
                    let _ = waiter.send(Err("Muse connection closed".into()));
                }
            }
            let _ = super::pi_rpc::stop_child(&reader_child, pgid).await;
        });
        Ok(Self {
            child,
            stdin,
            pending,
            closed,
            incoming,
            reader,
            next_id: 1,
            pgid,
        })
    }

    async fn write(&self, frame: &Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(frame).map_err(|_| "Invalid Muse frame")?;
        if encoded.len() >= FRAME_LIMIT {
            return Err("Muse frame too large".into());
        }
        encoded.push(b'\n');
        tokio::time::timeout(Duration::from_secs(30), async {
            let mut stdin = self.stdin.lock().await;
            if self.closed.load(Ordering::Acquire) {
                return Err("Muse connection closed".to_owned());
            }
            let mut guard = WriteGuard {
                child: self.child.clone(),
                closed: self.closed.clone(),
                armed: true,
                pgid:self.pgid,
            };
            stdin
                .write_all(&encoded)
                .await
                .map_err(|_| "Muse input closed".to_owned())?;
            guard.armed = false;
            Ok(())
        })
        .await
        .map_err(|_| "Muse write timed out".to_owned())?
    }

    pub(crate) async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("Muse request ID exhausted")?;
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "Muse request lock failed")?;
            if self.closed.load(Ordering::Acquire) {
                return Err("Muse connection closed".into());
            }
            pending.insert(id, sender);
        }
        let _guard = PendingGuard {
            pending: self.pending.clone(),
            id,
        };
        match tokio::time::timeout(Duration::from_secs(30), async {
            self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .await?;
            receiver
                .await
                .map_err(|_| "Muse connection closed".to_owned())?
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err("Muse request timed out".into()),
        }
    }

    pub(crate) async fn command(
        &mut self,
        method: &str,
        mut params: Value,
        command_id: &str,
    ) -> Result<Value, String> {
        params
            .as_object_mut()
            .ok_or("Invalid Muse command")?
            .insert("commandId".into(), json!(command_id));
        let mut attempt = 0u32;
        let result = loop {
            attempt += 1;
            match self.request(method, params.clone()).await {
                Ok(result) => break result,
                Err(error) => {
                    let retryable = error
                        .strip_prefix("Muse RPC error: ")
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .is_some_and(|value| {
                            (value["code"] == -32001 && value["data"]["kind"] == "overloaded")
                                || (value["code"] == -32031
                                    && value["data"]["kind"] == "backpressured")
                        });
                    if method != "turn/start" || attempt >= 3 || !retryable {
                        return Err(error);
                    }
                    let mut random = [0u8; 2];
                    let _ = getrandom::fill(&mut random);
                    let ceiling = 50u64 * (1u64 << (attempt - 1));
                    tokio::time::sleep(Duration::from_millis(
                        u64::from(u16::from_le_bytes(random)) % (ceiling + 1),
                    ))
                    .await;
                }
            }
        };
        if result
            .get("commandId")
            .is_some_and(|value| value != command_id)
        {
            return Err("Muse acknowledged a different command".into());
        }
        Ok(result)
    }

    pub(crate) async fn initialize(&mut self) -> Result<Value, String> {
        let result = match tokio::time::timeout(Duration::from_secs(20), self.request("initialize", json!({"clientInfo":{"name":"t3_code","title":"T3 Code","version":"1"},"capabilities":{"requestedCapabilities":["sessionMcp"]}}))).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => { self.close().await; return Err(error); },
            Err(_) => { self.close().await; return Err("Muse initialization timed out".into()); },
        };
        if result["schema"]["version"] != 1 || result["schema"]["fingerprint"].as_str().is_none() {
            self.close().await;
            return Err("Unsupported Muse protocol schema".into());
        }
        self.write(&json!({"jsonrpc":"2.0","method":"initialized"}))
            .await?;
        Ok(result)
    }

    pub(crate) async fn next(&mut self) -> Option<Value> {
        self.incoming.recv().await.map(|(value, _permit)| value)
    }
    pub(crate) async fn reply(&self, id: &Value, result: Value) -> Result<(), String> {
        self.write(&json!({"jsonrpc":"2.0","id":id,"result":result}))
            .await
    }
    pub(crate) async fn close(&mut self) -> bool {
        let stopped = super::pi_rpc::stop_child(&self.child,self.pgid).await;
        self.reader.abort();
        stopped
    }
}
impl Drop for MuseMsp {
    fn drop(&mut self) {
        self.reader.abort();
        if let Ok(mut child)=self.child.try_lock() { super::pi_rpc::signal_group(&mut child); let _=child.start_kill(); }
        else if let Ok(handle)=tokio::runtime::Handle::try_current(){ let child=self.child.clone();let pgid=self.pgid;handle.spawn(async move {let _=super::pi_rpc::stop_child(&child,pgid).await;}); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn initializes_and_correlates_commands_with_interleaved_notifications() {
        let directory = std::env::temp_dir().join(format!("t3-muse-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let script = directory.join("muse");
        std::fs::write(
            &script,
            r##"#!/usr/bin/python3
import json,sys
for line in sys.stdin:
 frame=json.loads(line)
 if frame.get('method')=='initialized': continue
 if frame['method']=='initialize':
  result={'schema':{'version':1,'fingerprint':'fixture'},'grantedCapabilities':[]}
 else:
  print(json.dumps({'jsonrpc':'2.0','id':'callback','method':'approval/request','params':{}}),flush=True)
  callback=json.loads(sys.stdin.readline());assert callback['id']=='callback' and callback['result']=={}
  print(json.dumps({'jsonrpc':'2.0','method':'item/updated','params':{'itemId':'one'}}),flush=True)
  result={'commandId':frame['params']['commandId'],'session':{'sessionId':'test'}}
 print(json.dumps({'jsonrpc':'2.0','id':frame['id'],'result':result}),flush=True)
"##,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut host = MuseMsp::launch(
                script.to_str().unwrap(),
                &directory,
                "workspace-write",
                &HashMap::new(),
            )
            .await
            .unwrap();
            host.initialize().await.unwrap();
            let reply = host
                .command(
                    "session/start",
                    json!({"workspaceRoot":directory}),
                    "command-1",
                )
                .await
                .unwrap();
            assert_eq!(reply["session"]["sessionId"], "test");
            assert_eq!(host.next().await.unwrap()["method"], "item/updated");
            host.close().await;
        }
        let _ = std::fs::remove_dir_all(directory);
    }
    #[cfg(target_os="linux")]
    #[tokio::test]
    async fn close_stops_owned_descendant_processes() {
        use std::os::unix::fs::PermissionsExt;
        let dir=std::env::temp_dir().join(format!("t3-muse-group-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let script=dir.join("muse");let marker=dir.join("child.pid");
        std::fs::write(&script,format!("#!/bin/sh\nsleep 60 &\necho $! > '{}'\nwait\n",marker.display())).unwrap();
        std::fs::set_permissions(&script,std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut host=MuseMsp::launch(script.to_str().unwrap(),&dir,"approval-required",&HashMap::new()).await.unwrap();
        for _ in 0..100 {if marker.exists(){break;} tokio::time::sleep(Duration::from_millis(10)).await;}
        let pid=std::fs::read_to_string(&marker).unwrap();
        assert!(host.close().await,"Muse process group did not stop");
        let stat=std::fs::read_to_string(format!("/proc/{}/stat",pid.trim())).ok();
        assert!(stat.is_none_or(|value| value.rsplit_once(") ").is_some_and(|(_,rest)| matches!(rest.split_whitespace().next(),Some("Z"|"X")))));
        let _=std::fs::remove_dir_all(dir);
    }
}
