//! Managed OpenCode server ownership and bounded readiness detection.
use super::opencode_http::{OpenCodeHttp, OpenCodeVersion};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::{oneshot, Mutex},
};

struct Owner {
    child: Mutex<Child>,
    url: String,
    version: OpenCodeVersion,
    identity: [u8; 32],
    cwd: String,
}
impl Drop for Owner {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Ok(child) = self.child.try_lock() {
            if let Some(id) = child.id() {
                unsafe {
                    libc::kill(-(id as i32), libc::SIGKILL);
                }
            }
        }
    }
}
struct StartupGuard {
    pid: Option<u32>,
    armed: bool,
}
impl Drop for StartupGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if self.armed {
            if let Some(id) = self.pid {
                unsafe {
                    libc::kill(-(id as i32), libc::SIGKILL);
                }
            }
        }
    }
}
static OWNERS: OnceLock<Mutex<HashMap<String, Arc<Owner>>>> = OnceLock::new();
fn owners() -> &'static Mutex<HashMap<String, Arc<Owner>>> {
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn force_endpoint(
    instance: &str,
    thread: &str,
) -> Result<Option<(String, OpenCodeVersion)>, String> {
    let mut registry = owners()
        .try_lock()
        .map_err(|_| "OpenCode owner registry is busy")?;
    for key in [format!("thread:{thread}"), format!("instance:{instance}")] {
        if let Some(owner) = registry.get(&key).cloned() {
            let mut child = owner
                .child
                .try_lock()
                .map_err(|_| "OpenCode owner is busy")?;
            let alive = child
                .try_wait()
                .map_err(|_| "Could not inspect OpenCode owner")?
                .is_none();
            drop(child);
            if alive {
                return Ok(Some((owner.url.clone(), owner.version)));
            }
            registry.remove(&key);
        }
    }
    Ok(None)
}

pub(crate) fn force_detach_thread(thread: &str) -> bool {
    match owners().try_lock() {
        Ok(mut registry) => {
            registry.remove(&format!("thread:{thread}"));
            true
        }
        Err(_) => false,
    }
}

pub(crate) async fn detach_thread(thread: &str) {
    owners().lock().await.remove(&format!("thread:{thread}"));
}

async fn drain<R: AsyncRead + Unpin>(mut reader: R, ready: Option<oneshot::Sender<String>>) {
    let mut ready = ready;
    let mut line = Vec::new();
    let mut bytes = [0u8; 4096];
    loop {
        let n = match reader.read(&mut bytes).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for byte in &bytes[..n] {
            if *byte == b'\n' {
                if let (Some(tx), Ok(text)) = (ready.take(), std::str::from_utf8(&line)) {
                    if let Some(index) = text.to_ascii_lowercase().find("server listening on ") {
                        let candidate = text[index + "server listening on ".len()..]
                            .trim()
                            .to_owned();
                        let _ = tx.send(candidate);
                    } else {
                        ready = Some(tx);
                    }
                }
                line.clear();
            } else if line.len() < 65536 {
                line.push(*byte);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn owned_listener(pid: u32, port: u16) -> bool {
    let Ok(tcp) = std::fs::read_to_string("/proc/net/tcp") else {
        return false;
    };
    let inodes: Vec<String> = tcp
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            let (host, number) = fields.get(1)?.split_once(':')?;
            if host != "0100007F"
                || u16::from_str_radix(number, 16).ok()? != port
                || *fields.get(3)? != "0A"
            {
                return None;
            }
            Some(format!("socket:[{}]", fields.get(9)?))
        })
        .collect();
    if inodes.is_empty() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(group_pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(rest) = stat.rsplit_once(')').map(|(_, rest)| rest) else {
            continue;
        };
        let Some(group) = rest
            .split_whitespace()
            .nth(2)
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if group != pid && group_pid != pid {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        if fds.flatten().any(|fd| {
            std::fs::read_link(fd.path()).ok().is_some_and(|target| {
                inodes
                    .iter()
                    .any(|inode| target.to_string_lossy() == *inode)
            })
        }) {
            return true;
        }
    }
    false
}
pub(crate) async fn connect(
    instance: &str,
    thread: &str,
    config: &Value,
    environment: &Value,
    cwd: &str,
    password: Option<&str>,
) -> Result<(String, OpenCodeVersion), String> {
    use sha2::{Digest, Sha256};
    let identity: [u8; 32] = Sha256::digest(
        serde_json::json!({"config":config,"environment":environment,"password":password})
            .to_string()
            .as_bytes(),
    )
    .into();
    let shared = format!("instance:{instance}");
    let per_thread = format!("thread:{thread}");
    let mut registry = owners().lock().await;
    for key in [&shared, &per_thread] {
        if let Some(owner) = registry.get(key) {
            let running = owner
                .child
                .lock()
                .await
                .try_wait()
                .map_err(|_| "Could not inspect OpenCode process")?
                .is_none();
            if running {
                if owner.identity != identity
                    || (owner.version == OpenCodeVersion::V1 && owner.cwd != cwd)
                {
                    return Err("OpenCode managed server settings changed; restart the server to apply them safely".into());
                }
                return Ok((owner.url.clone(), owner.version));
            }
        }
        registry.remove(key);
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Could not reserve OpenCode port")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not inspect OpenCode port")?
        .port();
    drop(listener);
    let binary = config["binaryPath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("opencode");
    let binary = if binary == "~" || binary.starts_with("~/") {
        super::instance::home_path(binary)?
    } else {
        PathBuf::from(binary)
    };
    let mut command = Command::new(binary);
    command
        .arg("serve")
        .arg("--hostname=127.0.0.1")
        .arg(format!("--port={port}"))
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(target_os = "linux")]
    unsafe {
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    if std::env::var_os("OPENCODE_CONFIG_CONTENT").is_none() {
        command.env("OPENCODE_CONFIG_CONTENT", "{}");
    }
    if let Some(values) = environment.as_array() {
        for value in values {
            if let (Some(name), Some(value)) = (value["name"].as_str(), value["value"].as_str()) {
                command.env(name, value);
            } else if !value["secret"].is_null() {
                return Err("Unresolved OpenCode environment secret".into());
            }
        }
    }
    if let Some(password) = password {
        command.env("OPENCODE_SERVER_PASSWORD", password);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start OpenCode server")?;
    let mut guard = StartupGuard {
        pid: child.id(),
        armed: true,
    };
    let stdout = child.stdout.take().ok_or("OpenCode stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("OpenCode stderr unavailable")?;
    let (tx, rx) = oneshot::channel();
    tokio::spawn(drain(stdout, Some(tx)));
    tokio::spawn(drain(stderr, None));
    let url = tokio::select! {
        value=rx => value.map_err(|_|"OpenCode server exited before readiness")?,
        _=child.wait() => return Err("OpenCode server exited before readiness".into()),
        _=tokio::time::sleep(Duration::from_secs(30)) => return Err("OpenCode server startup timed out".into()),
    };
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid OpenCode server readiness URL")?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port() != Some(port)
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Unexpected OpenCode server readiness URL".into());
    }
    #[cfg(target_os = "linux")]
    if !child.id().is_some_and(|pid| owned_listener(pid, port)) {
        return Err(
            "OpenCode readiness listener is not owned by the launched process group".into(),
        );
    }
    #[cfg(not(target_os = "linux"))]
    if password.is_some() {
        return Err("Managed OpenCode password authentication is unavailable without listener ownership verification".into());
    }
    let http = OpenCodeHttp::new(&url, password.map(str::to_owned))?;
    let version = http.probe().await?;
    let key = if version == OpenCodeVersion::V2 {
        shared
    } else {
        per_thread
    };
    let owner = Arc::new(Owner {
        child: Mutex::new(child),
        url: url.clone(),
        version,
        identity,
        cwd: cwd.to_owned(),
    });
    registry.insert(key, owner);
    guard.armed = false;
    Ok((url, version))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    #[cfg(target_os = "linux")]
    #[test]
    fn listener_must_belong_to_launched_process_group() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(owned_listener(std::process::id(), port));
        assert!(!owned_listener(u32::MAX, port));
    }
    #[tokio::test]
    async fn managed_server_starts_and_reuses_v2_process() {
        let root = std::env::temp_dir().join(format!("t3-opencode-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let bin = root.join("opencode");
        std::fs::write(&bin,r##"#!/usr/bin/env python3
import base64,json,os,sys
from http.server import BaseHTTPRequestHandler,HTTPServer
port=int(next(arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--port=')))
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  password=os.environ.get('OPENCODE_SERVER_PASSWORD','')
  if password and self.headers.get('Authorization')!='Basic '+base64.b64encode(('opencode:'+password).encode()).decode():self.send_response(401);self.end_headers();return
  body=json.dumps({'version':'2.0.18'}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
 def log_message(self,*args): pass
server=HTTPServer(('127.0.0.1',port),Handler)
print('server listening on http://127.0.0.1:'+str(port),flush=True)
server.serve_forever()
"##).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let instance = format!("owner-{}", uuid::Uuid::new_v4());
        let config = json!({"binaryPath":bin});
        let env = json!([{"name":"OPENCODE_SERVER_PASSWORD","value":"wrong"}]);
        let (first, version) = connect(
            &instance,
            "thread-1",
            &config,
            &env,
            root.to_str().unwrap(),
            Some("correct"),
        )
        .await
        .unwrap();
        assert_eq!(version, OpenCodeVersion::V2);
        let (second, _) = connect(
            &instance,
            "thread-2",
            &config,
            &env,
            root.to_str().unwrap(),
            Some("correct"),
        )
        .await
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(
            force_endpoint(&instance, "thread-1").unwrap(),
            Some((first.clone(), OpenCodeVersion::V2))
        );
        assert!(connect(
            &instance,
            "thread-2",
            &json!({"binaryPath":bin,"other":"changed"}),
            &env,
            root.to_str().unwrap(),
            Some("correct")
        )
        .await
        .is_err());
        owners()
            .lock()
            .await
            .remove(&format!("instance:{instance}"));
        assert_eq!(force_endpoint(&instance, "thread-1").unwrap(), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
