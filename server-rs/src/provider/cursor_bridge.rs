//! Optional process boundary around the separately installed Cursor Agent SDK.
//! No credentials are passed on the command line or included in errors.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

const SCRIPT: &str = include_str!("cursor_bridge.cjs");
const MAX_FRAME: u64 = 4 * 1024 * 1024;
pub(crate) fn group_quiescent(group: Option<i32>) -> bool {
    #[cfg(unix)] { super::pi_rpc::group_quiescent(group) }
    #[cfg(not(unix))] { let _ = group; false }
}

pub(crate) struct CursorBridge {
    child: Arc<Mutex<ChildState>>,
    input: Arc<Mutex<ChildStdin>>,
    incoming: mpsc::Receiver<Result<Value, String>>,
    next_id: u64,
}
struct ChildState { child: Child, signaled: bool }

impl CursorBridge {
    pub(crate) fn spawn(node: &str, sdk_path: Option<&str>) -> Result<Self, String> {
        let mut command = Command::new(node);
        command
            .args(["-e", SCRIPT])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(path) = sdk_path {
            command.env("T3CODE_CURSOR_SDK_PATH", path);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Cursor SDK runtime is unavailable".to_owned())?;
        let input = Arc::new(Mutex::new(
            child.stdin.take().ok_or("Cursor SDK input unavailable")?,
        ));
        let output = child.stdout.take().ok_or("Cursor SDK output unavailable")?;
        let (tx, incoming) = mpsc::channel();
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let mut bytes = Vec::new();
                match (&mut output)
                    .take(MAX_FRAME + 1)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) => break,
                    Ok(_) if bytes.len() as u64 > MAX_FRAME => {
                        let _ = tx.send(Err("Cursor SDK frame exceeded its limit".into()));
                        break;
                    }
                    Ok(_) => match serde_json::from_slice(&bytes) {
                        Ok(value) => {
                            if tx.send(Ok(value)).is_err() {
                                break;
                            }
                        }
                        Err(_) => {
                            let _ = tx.send(Err("Invalid Cursor SDK frame".into()));
                            break;
                        }
                    },
                    Err(_) => {
                        let _ = tx.send(Err("Cursor SDK stream failed".into()));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child: Arc::new(Mutex::new(ChildState { child, signaled: false })),
            input,
            incoming,
            next_id: 1,
        })
    }

    pub(crate) fn cancel_handle(&self) -> CursorCancel {
        CursorCancel {
            input: self.input.clone(),
            child: self.child.clone(),
        }
    }

    pub(crate) fn request<F>(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
        event: F,
    ) -> Result<Value, String>
    where
        F: FnMut(Value),
    {
        self.request_inner(method, params, timeout, None, event)
    }
    pub(crate) fn request_admitted<F>(&mut self, method:&str, params:Value, timeout:Duration, gate:&Mutex<()>, cancelled:&AtomicBool, event:F) -> Result<Value,String>
    where F:FnMut(Value) {
        self.request_inner(method, params, timeout, Some((gate,cancelled)), event)
    }
    fn request_inner<F>(&mut self, method:&str, params:Value, timeout:Duration, admission:Option<(&Mutex<()>,&AtomicBool)>, mut event:F) -> Result<Value,String>
    where F:FnMut(Value) {
        let permit = admission.map(|(gate,_)|gate.lock().map_err(|_|"Cursor start unavailable")).transpose()?;
        if admission.is_some_and(|(_,cancelled)|cancelled.load(Ordering::Acquire)) { return Err("Cursor start cancelled".into()); }
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("Cursor SDK request ID exhausted")?;
        let frame = json!({"id":id,"method":method,"params":params});
        let mut input = self
            .input
            .lock()
            .map_err(|_| "Cursor SDK input unavailable")?;
        serde_json::to_writer(&mut *input, &frame).map_err(|_| "Cursor SDK input failed")?;
        input
            .write_all(b"\n")
            .and_then(|_| input.flush())
            .map_err(|_| "Cursor SDK input failed")?;
        drop(input);
        drop(permit);
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline
                .checked_duration_since(Instant::now())
                .ok_or("Cursor SDK request timed out")?;
            let value = self
                .incoming
                .recv_timeout(left)
                .map_err(|_| "Cursor SDK request ended unexpectedly")??;
            if value["id"] == id {
                if value.get("error").is_some() {
                    return Err("Cursor SDK operation failed".into());
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            if value.get("method").is_some() {
                event(value);
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct CursorCancel {
    input: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<ChildState>>,
}
impl CursorCancel {
    fn send(&self, method: &str) -> Result<(), String> {
        let mut input = self
            .input
            .lock()
            .map_err(|_| "Cursor SDK input unavailable")?;
        serde_json::to_writer(&mut *input, &json!({"id":0,"method":method}))
            .map_err(|_| "Cursor SDK input failed")?;
        input
            .write_all(b"\n")
            .and_then(|_| input.flush())
            .map_err(|_| "Cursor SDK input failed".into())
    }
    pub(crate) fn same_process(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.child, &other.child)
    }
    pub(crate) fn cancel(&self) -> Result<(), String> {
        self.send("cancel")
    }
    pub(crate) fn cancel_login(&self) -> Result<(), String> {
        self.send("cancelLogin")
    }
    pub(crate) fn process_group(&self) -> Option<i32> {
        #[cfg(unix)]
        { self.child.lock().ok().and_then(|state| i32::try_from(state.child.id()).ok()) }
        #[cfg(not(unix))]
        { None }
    }
    pub(crate) fn terminate(&self) -> bool {
        if let Ok(mut child) = self.child.lock() {
            return terminate_child(&mut child);
        }
        false
    }
}

fn terminate_child(state: &mut ChildState) -> bool {
    let child = &mut state.child;
    #[cfg(unix)]
    {
        let group = i32::try_from(child.id()).ok();
        // Signal before reaping the leader: otherwise its process-group ID may
        // be reused while descendants still need to be stopped.
        if !state.signaled {
            if let Some(group) = group.filter(|id| *id > 1) {
                unsafe { libc::kill(-group, libc::SIGKILL); }
            }
            let _ = child.kill();
            state.signaled = true;
        }
        for _ in 0..25 {
            let _ = child.try_wait();
            if group_quiescent(group) { return true; }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    #[cfg(not(unix))]
    { let _ = child.kill(); }
    false
}

impl Drop for CursorBridge {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = terminate_child(&mut child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn parent_loss_fixture() {
        let Ok(dir) = std::env::var("T3_TEST_CURSOR_PARENT_LOSS") else { return };
        let path = std::path::Path::new(&dir);
        let mut bridge = CursorBridge::spawn("node", Some(path.join("sdk.cjs").to_str().unwrap())).unwrap();
        bridge.request("open", json!({"options":{}}), Duration::from_secs(10), |_| {}).unwrap();
        std::fs::write(path.join("group"), bridge.cancel_handle().process_group().unwrap().to_string()).unwrap();
        loop { std::thread::park(); }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn sdk_process_group_exits_when_supervisor_is_killed() {
        if Command::new("node").arg("--version").stdout(Stdio::null()).status().is_err() { return; }
        let dir = std::env::temp_dir().join(format!("cursor-parent-loss-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("sdk.cjs"), r#"const {spawn}=require('node:child_process');module.exports={Agent:{create:async()=>{spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});return {agentId:'fake'};}}};"#).unwrap();
        let mut supervisor = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "provider::cursor_bridge::tests::parent_loss_fixture", "--nocapture"])
            .env("T3_TEST_CURSOR_PARENT_LOSS", &dir).stdout(Stdio::null()).spawn().unwrap();
        let group_path = dir.join("group");
        for _ in 0..200 {
            if group_path.exists() { break; }
            if supervisor.try_wait().unwrap().is_some() { panic!("fixture supervisor exited before startup"); }
            std::thread::sleep(Duration::from_millis(20));
        }
        let group: i32 = std::fs::read_to_string(&group_path).expect("SDK startup timed out").parse().unwrap();
        assert!(!group_quiescent(Some(group)));
        supervisor.kill().unwrap();
        supervisor.wait().unwrap();
        let mut stopped = false;
        for _ in 0..200 {
            if group_quiescent(Some(group)) { stopped = true; break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !stopped { unsafe { libc::kill(-group, libc::SIGKILL); } }
        let _ = std::fs::remove_dir_all(dir);
        assert!(stopped, "SDK process group survived supervisor death");
    }

    #[test]
    fn termination_unblocks_a_hung_sdk_request() {
        if Command::new("node").arg("--version").stdout(Stdio::null()).status().is_err() { return; }
        let path = std::env::temp_dir().join(format!("t3-cursor-hung-{}.cjs", uuid::Uuid::new_v4()));
        std::fs::write(&path, "module.exports={Agent:{create:async()=>new Promise(()=>{})}};").unwrap();
        let mut bridge = CursorBridge::spawn("node", Some(path.to_str().unwrap())).unwrap();
        let cancel = bridge.cancel_handle();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || { let _ = tx.send(bridge.request("open", json!({"options":{}}), Duration::from_secs(10), |_| {})); });
        cancel.terminate();
        assert!(rx.recv_timeout(Duration::from_secs(3)).unwrap().is_err());
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn bridge_runs_fake_sdk_and_returns_only_requested_events() {
        if Command::new("node")
            .arg("--version")
            .stdout(Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        let path = std::env::temp_dir().join(format!("t3-cursor-sdk-{}.cjs", uuid::Uuid::new_v4()));
        std::fs::write(&path, r#"
const agent = {agentId:'cursor-agent', send:async (message, options)=>{
  await options.onDelta({update:{type:'text-delta',text:'hello'}});
  return {id:'cursor-run',wait:async()=>({status:'completed'}),cancel:async()=>{}};
}, close:async()=>{}};
module.exports={Agent:{create:async()=>agent,resume:async()=>agent},Cursor:{auth:{login:async ({store,onLoginUrl})=>{onLoginUrl('https://example.test/login');await store.save({version:1,backendUrl:'https://example.test',apiKey:'test-private-key',createdAtMs:1});}}}};
"#).unwrap();
        let mut bridge = CursorBridge::spawn("node", Some(path.to_str().unwrap())).unwrap();
        let mut events = Vec::new();
        let opened = bridge
            .request(
                "open",
                json!({"options":{}}),
                Duration::from_secs(5),
                |_| {},
            )
            .unwrap();
        assert_eq!(opened["agentId"], "cursor-agent");
        let result = bridge
            .request(
                "send",
                json!({"message":"hello"}),
                Duration::from_secs(5),
                |event| events.push(event),
            )
            .unwrap();
        assert_eq!(result["status"], "completed");
        assert!(events
            .iter()
            .any(|event| event["method"] == "update" && event["params"]["text"] == "hello"));
        assert!(events
            .iter()
            .any(|event| event["method"] == "run.started"
                && event["params"]["runId"] == "cursor-run"));
        let mut login_events = Vec::new();
        let login = bridge
            .request(
                "login",
                json!({"apiKeyName":"fixture"}),
                Duration::from_secs(5),
                |event| login_events.push(event),
            )
            .unwrap();
        assert_eq!(login["credentials"]["apiKey"], "test-private-key");
        assert_eq!(login_events[0]["method"], "login.url");
        assert!(!serde_json::to_string(&login_events)
            .unwrap()
            .contains("test-private-key"));
        bridge
            .request("close", json!({}), Duration::from_secs(5), |_| {})
            .unwrap();
        let _ = std::fs::remove_file(path);
    }
}
