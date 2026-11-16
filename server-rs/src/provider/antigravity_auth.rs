//! Antigravity sign-in.
//!
//! Spawns the agent's own ACP server (`agy acp`) and drives its
//! `authenticate` RPC to completion, capturing the Google OAuth URL it
//! prints to stderr when it cannot open a real browser (this is a headless
//! spawn, so its `webbrowser.open()` call has nothing to open). Mirrors the
//! reference server's apps/server/src/provider/{AntigravityAuth,
//! antigravityAuthSupport,antigravityCallback}.ts: a loopback redirect URL
//! is shown to the user, and pasting Google's callback back forwards it to
//! the agent's own local listener.
//!
//! The "already signed in" check instead mirrors
//! /Users/jkneen/Documents/GitHub/zuse's
//! crates/providers/src/acp/mod.rs (`antigravity_saved_auth_method`,
//! `configured_auth_method_in`): Antigravity's own ACP server records every
//! successful `authenticate` in `<GEMINI_HOME>/antigravity-acp/settings.json`,
//! so a plain file read is the cheapest reliable signal -- no process spawn
//! needed just to report "Signed in".
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tokio::sync::watch;

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(330);

pub const AUTH_METHODS: &[(&str, &str)] = &[
    ("oauth-personal", "Google account"),
    ("oauth-business", "Gemini Enterprise"),
    ("gemini-api-key", "Gemini API key"),
    ("agent-platform", "Agent Platform"),
];
fn method_catalog() -> Vec<Value> {
    AUTH_METHODS
        .iter()
        .map(|(id, name)| json!({"id": id, "name": name}))
        .collect()
}

/// Mirrors `acp_executor.rs`'s per-instance profile path, so a sign-in here
/// and a later turn launch share the same `GEMINI_HOME` and see the same
/// token.
pub fn profile_dir(settings_path: &Path, instance: &str) -> Option<PathBuf> {
    let state = settings_path.parent()?;
    let digest = Sha256::digest(instance.as_bytes());
    let key = digest.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Some(state.join("providers").join("antigravity").join(key))
}

/// The cheapest reliable "already signed in" signal (see module docs).
pub fn saved_auth_method(profile: &Path) -> Option<String> {
    let text =
        std::fs::read_to_string(profile.join("antigravity-acp").join("settings.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value["auth"]["method"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn binary_for(entry: &Value) -> String {
    entry["config"]["binaryPath"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("agy")
        .to_owned()
}

fn idle_state() -> Value {
    json!({"phase":"idle","flowId":null,"authorizationUrl":null,"interaction":null,"methods":method_catalog(),"message":null,"expiresAt":null})
}
fn signed_in_state() -> Value {
    json!({"phase":"succeeded","flowId":null,"authorizationUrl":null,"interaction":null,"methods":method_catalog(),"message":null,"expiresAt":null})
}
fn failed_state(message: &str) -> Value {
    json!({"phase":"failed","flowId":null,"authorizationUrl":null,"interaction":null,"methods":method_catalog(),"message":message,"expiresAt":null})
}
fn error(detail: &str) -> Value {
    json!({"_tag":"ProviderSetupError","detail":detail})
}

/// The first `http(s)://...` url in a line, trimmed of trailing punctuation:
/// the same heuristic zuse's `sign_in_url` uses (Antigravity prints nothing
/// else on this stream once asked to authenticate).
fn sign_in_url(line: &str) -> Option<String> {
    let start = ["https://", "http://"]
        .iter()
        .filter_map(|prefix| line.find(prefix))
        .min()?;
    let candidate = line[start..]
        .split_whitespace()
        .next()?
        .trim_end_matches(['.', ',', ';', ')', ']', '}']);
    url::Url::parse(candidate).ok().map(|_| candidate.to_owned())
}

/// Validates the shape of Google's authorization url and returns
/// `(redirect_uri, state)`, mirroring `parseAntigravityAuthorizationUrl`.
fn parse_authorization_url(raw: &str) -> Option<(String, String)> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("accounts.google.com")
        || url.path() != "/o/oauth2/v2/auth"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let get_all = |key: &str| -> Vec<String> {
        url.query_pairs()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .collect()
    };
    let state = get_all("state");
    let redirect = get_all("redirect_uri");
    let response_type = get_all("response_type");
    if state.len() != 1 || redirect.len() != 1 || response_type.len() != 1 || response_type[0] != "code"
    {
        return None;
    }
    let (state, redirect_uri) = (state[0].clone(), redirect[0].clone());
    if state.is_empty() || state.len() > 512 || state.chars().any(char::is_whitespace) {
        return None;
    }
    let redirect_parsed = url::Url::parse(&redirect_uri).ok()?;
    if redirect_parsed.scheme() != "http"
        || redirect_parsed.host_str() != Some("127.0.0.1")
        || redirect_parsed.path() != "/"
        || redirect_parsed.port()? < 1024
    {
        return None;
    }
    Some((redirect_uri, state))
}

#[derive(Clone)]
struct Pending {
    redirect_uri: String,
    state: String,
}

/// Validates a pasted callback url against the pending sign-in, mirroring
/// `validateAntigravityCallbackUrl`.
fn validate_callback(callback_url: &str, pending: &Pending) -> Result<(), ()> {
    let url = url::Url::parse(callback_url).map_err(|_| ())?;
    let expected = url::Url::parse(&pending.redirect_uri).map_err(|_| ())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != expected.port()
        || url.path() != expected.path()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(());
    }
    let states: Vec<_> = url
        .query_pairs()
        .filter(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .collect();
    if states.len() != 1 || states[0] != pending.state {
        return Err(());
    }
    let codes: Vec<_> = url.query_pairs().filter(|(k, _)| k == "code").collect();
    let errors: Vec<_> = url.query_pairs().filter(|(k, _)| k == "error").collect();
    let ok = (codes.len() == 1 && !codes[0].1.is_empty() && errors.is_empty())
        || (errors.len() == 1 && !errors[0].1.is_empty() && codes.is_empty());
    if ok {
        Ok(())
    } else {
        Err(())
    }
}

/// Delivers a validated callback to Antigravity's own local listener, the
/// way `forwardAntigravityCallback` does with a plain GET: best effort, no
/// redirects, no proxy.
fn forward_callback(callback_url: &str) {
    let Ok(url) = url::Url::parse(callback_url) else {
        return;
    };
    let Some(host) = url.host_str() else { return };
    let port = url.port().unwrap_or(80);
    let path = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    };
    if let Ok(mut stream) = std::net::TcpStream::connect((host, port)) {
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let request = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_ok() {
            let mut buf = [0u8; 256];
            let _ = stream.read(&mut buf);
        }
    }
}

fn kill(child: &Arc<Mutex<Option<Child>>>) {
    if let Some(mut child) = child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn run_flow(
    profile: PathBuf,
    binary: String,
    method: String,
    flow_id: String,
    state: watch::Sender<Value>,
    child_handle: Arc<Mutex<Option<Child>>>,
    pending: Arc<Mutex<Option<Pending>>>,
    callback_rx: mpsc::Receiver<String>,
) {
    let mut cmd = Command::new(&binary);
    cmd.args([
        "acp",
        "--gemini-dir",
        &profile.to_string_lossy(),
        "--app-data-dir",
        "antigravity-acp",
    ]);
    cmd.env("GEMINI_HOME", &profile);
    cmd.env("AGY_ACP_FORCE_FILE_STORAGE", "1");
    cmd.env("PYTHONUNBUFFERED", "1");
    cmd.env("ELECTRON_RUN_AS_NODE", "1");
    // Force Python's webbrowser.open() to fail so Antigravity falls back to
    // printing the url: macOS's `open` "succeeds" even headless and would
    // silently swallow it otherwise (see zuse's sign-in tests, which force
    // the same fallback the same way).
    #[cfg(unix)]
    cmd.env("BROWSER", "/bin/false");
    for key in [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_CLOUD_QUOTA_PROJECT",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GCLOUD_PROJECT",
        "CLOUDSDK_CORE_PROJECT",
        "AGY_ACP_CCPA_PROJECT",
        "AGY_ACP_ENABLE_OAUTH",
        "ANTIGRAVITY_HARNESS_PATH",
    ] {
        cmd.env_remove(key);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = state.send(failed_state(&format!("Could not start Antigravity: {error}")));
            return;
        }
    };
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    *child_handle.lock().unwrap() = Some(child);

    let (url_tx, url_rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(url) = sign_in_url(&line) {
                let _ = url_tx.send(url);
            }
        }
    });
    let (line_tx, line_rx) = mpsc::channel::<Value>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut bytes = Vec::new();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                        if line_tx.send(value).is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let send_request = |stdin: &mut ChildStdin, id: u64, method: &str, params: Value| {
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .and_then(|_| stdin.flush())
    };
    let init = json!({"protocolVersion":2,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"session":{"notices":{},"compaction":{}}},"clientInfo":{"name":"t3-code","version":"0.0.0"}});
    if send_request(&mut stdin, 1, "initialize", init).is_err() {
        let _ = state.send(failed_state("Could not talk to Antigravity."));
        kill(&child_handle);
        return;
    }
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    let mut saw_init = false;
    while Instant::now() < deadline {
        match line_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(frame) if frame.get("id") == Some(&json!(1)) => {
                saw_init = true;
                break;
            }
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if !saw_init {
        let _ = state.send(failed_state("Antigravity did not respond to initialize."));
        kill(&child_handle);
        return;
    }
    if send_request(&mut stdin, 2, "authenticate", json!({"methodId": method})).is_err() {
        let _ = state.send(failed_state("Could not start Antigravity sign-in."));
        kill(&child_handle);
        return;
    }
    let _ = state.send(json!({"phase":"waiting","flowId":flow_id,"authorizationUrl":null,"interaction":null,"methods":method_catalog(),"message":"Waiting for Antigravity to open a sign-in link.","expiresAt":null}));

    let mut announced = false;
    loop {
        if Instant::now() >= deadline {
            let _ = state.send(failed_state("Antigravity sign-in timed out. Start sign-in again."));
            kill(&child_handle);
            return;
        }
        if let Ok(frame) = line_rx.try_recv() {
            if frame.get("id") == Some(&json!(2)) {
                if let Some(error) = frame.get("error") {
                    let message = error["message"].as_str().unwrap_or("Antigravity sign-in failed.");
                    let _ = state.send(failed_state(message));
                } else {
                    let _ = state.send(signed_in_state());
                }
                kill(&child_handle);
                return;
            }
        }
        if !announced {
            if let Ok(url) = url_rx.try_recv() {
                if let Some((redirect_uri, oauth_state)) = parse_authorization_url(&url) {
                    *pending.lock().unwrap() = Some(Pending {
                        redirect_uri,
                        state: oauth_state,
                    });
                    announced = true;
                    let _ = state.send(json!({"phase":"waiting","flowId":flow_id,"authorizationUrl":url,"interaction":{"type":"browser","id":"authorize","url":url,"requiresConsent":false,"acceptsCallback":true},"methods":method_catalog(),"message":null,"expiresAt":null}));
                }
            }
        }
        if let Ok(callback_url) = callback_rx.try_recv() {
            let matches = pending
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|pending| validate_callback(&callback_url, pending).is_ok());
            if matches {
                forward_callback(&callback_url);
            }
        }
        thread::sleep(Duration::from_millis(150));
    }
}

struct Flow {
    tx: watch::Sender<Value>,
    child: Arc<Mutex<Option<Child>>>,
    pending: Arc<Mutex<Option<Pending>>>,
    callback: mpsc::Sender<String>,
}

#[derive(Default)]
pub struct AntigravityAuthFlows {
    flows: Mutex<HashMap<String, Flow>>,
}

impl AntigravityAuthFlows {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The initial state a subscriber sees before any sign-in flow has run
    /// this process lifetime: "succeeded" when Antigravity already recorded
    /// a successful sign-in on disk (so the Account row shows "Signed in"
    /// without ever running the flow), otherwise "idle".
    pub fn subscribe(&self, instance: &str, settings_path: &Path) -> watch::Receiver<Value> {
        let mut flows = self.flows.lock().unwrap();
        if let Some(flow) = flows.get(instance) {
            return flow.tx.subscribe();
        }
        let initial = profile_dir(settings_path, instance)
            .and_then(|profile| saved_auth_method(&profile))
            .map(|_| signed_in_state())
            .unwrap_or_else(idle_state);
        let (tx, rx) = watch::channel(initial);
        flows.insert(
            instance.to_owned(),
            Flow {
                tx,
                child: Arc::new(Mutex::new(None)),
                pending: Arc::new(Mutex::new(None)),
                callback: mpsc::channel().0,
            },
        );
        rx
    }

    pub fn start(
        &self,
        instance: &str,
        entry: &Value,
        settings_path: &Path,
        method_id: Option<&str>,
    ) -> Result<Value, Value> {
        let profile = profile_dir(settings_path, instance)
            .ok_or_else(|| error("Could not resolve this instance's profile directory."))?;
        std::fs::create_dir_all(&profile)
            .map_err(|_| error("Could not prepare the Antigravity profile."))?;
        let binary = binary_for(entry);
        let method = method_id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or("oauth-personal")
            .to_owned();
        let flow_id = uuid::Uuid::new_v4().to_string();
        let initial = json!({"phase":"starting","flowId":flow_id,"authorizationUrl":null,"interaction":null,"methods":method_catalog(),"message":"Starting Antigravity sign-in.","expiresAt":null});
        let (callback_tx, callback_rx) = mpsc::channel::<String>();
        let child_handle = Arc::new(Mutex::new(None));
        let pending = Arc::new(Mutex::new(None));
        // Reuse an existing subscriber's sender when one is already
        // registered (the normal case: the UI always subscribes before it
        // can show a "Sign in" button), so `start()` never orphans it with
        // a `RecvError` the way creating a fresh channel here would.
        let tx = {
            let mut flows = self.flows.lock().unwrap();
            let tx = flows
                .get(instance)
                .map(|flow| flow.tx.clone())
                .unwrap_or_else(|| watch::channel(initial.clone()).0);
            flows.insert(
                instance.to_owned(),
                Flow {
                    tx: tx.clone(),
                    child: child_handle.clone(),
                    pending: pending.clone(),
                    callback: callback_tx,
                },
            );
            tx
        };
        let _ = tx.send(initial.clone());
        thread::spawn(move || {
            run_flow(
                profile,
                binary,
                method,
                flow_id,
                tx,
                child_handle,
                pending,
                callback_rx,
            );
        });
        Ok(initial)
    }

    pub fn cancel(&self, instance: &str, flow_id: &str) -> Result<Value, Value> {
        let flows = self.flows.lock().unwrap();
        let flow = flows
            .get(instance)
            .ok_or_else(|| error("This provider instance is no longer available."))?;
        if flow.tx.borrow()["flowId"] != flow_id {
            return Err(error(
                "This sign-in is no longer current. Refresh its status before cancelling.",
            ));
        }
        kill(&flow.child);
        let cancelled = json!({"phase":"cancelled","flowId":null,"authorizationUrl":null,"interaction":null,"methods":method_catalog(),"message":"Sign-in cancelled.","expiresAt":null});
        let _ = flow.tx.send(cancelled.clone());
        Ok(cancelled)
    }

    pub fn respond(&self, instance: &str, flow_id: &str, response: &Value) -> Result<Value, Value> {
        {
            let flows = self.flows.lock().unwrap();
            let flow = flows
                .get(instance)
                .ok_or_else(|| error("This provider instance is no longer available."))?;
            if flow.tx.borrow()["flowId"] != flow_id {
                return Err(error(
                    "This sign-in is no longer current. Refresh its status before responding.",
                ));
            }
            if !(response["type"] == "browser" && response["action"] == "decline") {
                return Ok(flow.tx.borrow().clone());
            }
        }
        self.cancel(instance, flow_id)
    }

    pub fn complete(&self, instance: &str, flow_id: &str, callback_url: &str) -> Result<Value, Value> {
        let pending = {
            let flows = self.flows.lock().unwrap();
            let flow = flows
                .get(instance)
                .ok_or_else(|| error("This provider instance is no longer available."))?;
            if flow.tx.borrow()["flowId"] != flow_id {
                return Err(error("This sign-in is no longer current. Start sign-in again."));
            }
            let pending = flow.pending.lock().unwrap().clone();
            let pending =
                pending.ok_or_else(|| error("Open the sign-in link before pasting its redirect."))?;
            if validate_callback(callback_url, &pending).is_err() {
                return Err(error(
                    "Paste the complete redirect URL from the Google sign-in page.",
                ));
            }
            let _ = flow.callback.send(callback_url.to_owned());
            pending
        };
        let _ = pending;
        // Give the background flow a moment to react before reporting back;
        // its own subscription keeps streaming the eventual success/failure.
        thread::sleep(Duration::from_millis(400));
        let flows = self.flows.lock().unwrap();
        Ok(flows
            .get(instance)
            .map(|flow| flow.tx.borrow().clone())
            .unwrap_or_else(idle_state))
    }

    pub fn logout(&self, instance: &str, settings_path: &Path) -> Result<Value, Value> {
        if let Some(profile) = profile_dir(settings_path, instance) {
            let _ = std::fs::remove_dir_all(profile.join("antigravity-acp"));
        }
        let idle = idle_state();
        let mut flows = self.flows.lock().unwrap();
        if let Some(flow) = flows.get_mut(instance) {
            kill(&flow.child);
            let _ = flow.tx.send(idle.clone());
        }
        Ok(idle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_validates_the_google_authorization_url() {
        let line = "Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?state=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A51000%2F&response_type=code&client_id=x\n";
        let url = sign_in_url(line).unwrap();
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth"));
        let (redirect, state) = parse_authorization_url(&url).unwrap();
        assert_eq!(state, "abc123");
        assert_eq!(redirect, "http://127.0.0.1:51000/");
        // A non-Google url, or one missing the required parameters, is rejected.
        assert!(parse_authorization_url("https://example.com/").is_none());
        assert!(parse_authorization_url(
            "https://accounts.google.com/o/oauth2/v2/auth?state=a&response_type=code"
        )
        .is_none());
    }

    #[test]
    fn validates_pasted_callback_against_the_pending_sign_in() {
        let pending = Pending {
            redirect_uri: "http://127.0.0.1:51000/".into(),
            state: "abc123".into(),
        };
        assert!(validate_callback(
            "http://127.0.0.1:51000/?code=xyz&state=abc123",
            &pending
        )
        .is_ok());
        assert!(validate_callback(
            "http://127.0.0.1:51000/?code=xyz&state=wrong",
            &pending
        )
        .is_err());
        assert!(validate_callback("http://127.0.0.1:9999/?code=xyz&state=abc123", &pending).is_err());
        assert!(validate_callback(
            "http://127.0.0.1:51000/?error=access_denied&state=abc123",
            &pending
        )
        .is_ok());
    }

    #[test]
    fn saved_auth_method_reads_what_antigravity_itself_recorded() {
        let dir = std::env::temp_dir().join(format!("agy-auth-{}", uuid::Uuid::new_v4()));
        let acp_dir = dir.join("antigravity-acp");
        std::fs::create_dir_all(&acp_dir).unwrap();
        assert!(saved_auth_method(&dir).is_none());
        std::fs::write(
            acp_dir.join("settings.json"),
            r#"{"auth":{"method":"oauth-personal"}}"#,
        )
        .unwrap();
        assert_eq!(saved_auth_method(&dir).unwrap(), "oauth-personal");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A fake `agy acp`: replies to `initialize`, then on `authenticate`
    /// prints a (fake) Google url to stderr and waits for a marker file
    /// (standing in for its own loopback listener actually being hit)
    /// before replying success. `forward_callback`'s real network GET is
    /// exercised too, against nothing in particular -- it is best effort
    /// and ignored either way, so the fake does not need to listen on the
    /// redirect port itself.
    #[cfg(unix)]
    fn fake_agy(dir: &Path, done_marker: &Path) -> PathBuf {
        let script = dir.join("agy");
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":2,"authMethods":[{{"id":"oauth-personal","name":"Log in with Google"}}]}}}}\n'
      ;;
    *'"method":"authenticate"'*)
      printf 'Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?state=teststate&redirect_uri=http%%3A%%2F%%2F127.0.0.1%%3A51999%%2F&response_type=code&client_id=x\n' 1>&2
      while [ ! -f "{done}" ]; do sleep 0.05; done
      printf '{{"jsonrpc":"2.0","id":2,"result":{{}}}}\n'
      ;;
  esac
done
"#,
                done = done_marker.to_string_lossy()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn start_reports_the_authorization_url_then_succeeds_after_the_callback_is_delivered() {
        let dir = std::env::temp_dir().join(format!("agy-flow-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        std::fs::write(&settings, "{}").unwrap();
        let done_marker = dir.join("done");
        let script = fake_agy(&dir, &done_marker);
        let entry = json!({"driver":"antigravity","config":{"binaryPath":script.to_string_lossy()}});
        let flows = AntigravityAuthFlows::new();
        let mut updates = flows.subscribe("antigravity", &settings);
        assert_eq!(updates.borrow_and_update()["phase"], "idle");
        let started = flows.start("antigravity", &entry, &settings, None).unwrap();
        assert_eq!(started["phase"], "starting");
        let flow_id = started["flowId"].as_str().unwrap().to_owned();
        // Wait for the authorization url to be announced.
        let url = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                updates.changed().await.unwrap();
                let state = updates.borrow_and_update().clone();
                if state["interaction"]["type"] == "browser" {
                    return state["authorizationUrl"].as_str().unwrap().to_owned();
                }
            }
        })
        .await
        .expect("authorization url was never announced");
        assert!(url.contains("accounts.google.com"));
        // Deliver the (fake) Google redirect the way the client's pasted-url
        // fallback does.
        let callback = "http://127.0.0.1:51999/?code=abc&state=teststate";
        let after_complete = flows.complete("antigravity", &flow_id, callback).unwrap();
        assert_ne!(after_complete["phase"], "failed");
        std::fs::write(&done_marker, "").unwrap();
        let final_state = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let state = updates.borrow().clone();
                if state["phase"] == "succeeded" || state["phase"] == "failed" {
                    return state;
                }
                updates.changed().await.unwrap();
            }
        })
        .await
        .expect("sign-in never resolved");
        assert_eq!(final_state["phase"], "succeeded");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
