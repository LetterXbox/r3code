#![cfg(unix)]
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::fd::FromRawFd,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn desktop_process_accepts_credential_from_bootstrap_pipe() {
    let root = std::env::temp_dir().join(format!("t3-desktop-{}", uuid::Uuid::new_v4()));
    let port = TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut fds = [0; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let mut writer = unsafe { std::fs::File::from_raw_fd(fds[1]) };
    let mut server = Server(
        Command::new(env!("CARGO_BIN_EXE_t3code"))
            .args([
                "--bootstrap-fd",
                &fds[0].to_string(),
                "--base-dir",
                root.to_str().unwrap(),
            ])
            .env_remove("T3CODE_MODE")
            .env_remove("T3CODE_PORT")
            .env_remove("T3CODE_HOST")
            .env_remove("T3CODE_NO_BROWSER")
            .env_remove("VITE_DEV_SERVER_URL")
            .env_remove("T3CODE_TAILSCALE_SERVE")
            .env_remove("T3CODE_BOOTSTRAP_FD")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    unsafe {
        libc::close(fds[0]);
    }
    writeln!(writer, "{}", serde_json::json!({"mode":"desktop","noBrowser":true,"port":port,"host":"127.0.0.1","desktopBootstrapToken":"desktop-test-credential","tailscaleServeEnabled":false,"tailscaleServePort":443})).unwrap();
    drop(writer);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut stream = loop {
        if let Ok(stream) = TcpStream::connect(("127.0.0.1", port)) {
            break stream;
        }
        assert!(
            Instant::now() < deadline && server.0.try_wait().unwrap().is_none(),
            "desktop server failed to start"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let body = r#"{"credential":"desktop-test-credential"}"#;
    write!(stream, "POST /api/auth/browser-session HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response
        .to_ascii_lowercase()
        .contains("set-cookie: t3_session_"));
    drop(server);
    std::fs::remove_dir_all(root).unwrap();
}
