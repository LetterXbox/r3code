//! Desktop launcher bootstrap, read from an inherited descriptor without logging secrets.
use crate::config::{ConfigInput, Mode};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    mode: String,
    no_browser: bool,
    port: u16,
    t3_home: Option<String>,
    host: String,
    desktop_bootstrap_token: String,
    desktop_bootstrap_secret: Option<String>,
    tailscale_serve_enabled: bool,
    tailscale_serve_port: u16,
    desktop_telemetry_fd: Option<i32>,
    desktop_telemetry_control_fd: Option<i32>,
    otlp_traces_url: Option<String>,
}

pub struct Bootstrap {
    pub config: ConfigInput,
    pub token: String,
    pub secret: Option<String>,
    pub telemetry_fd: Option<i32>,
    pub telemetry_control_fd: Option<i32>,
    pub otlp_traces_url: Option<String>,
}

fn decode(line: &[u8]) -> Result<Bootstrap, &'static str> {
    let e: Envelope =
        serde_json::from_slice(line).map_err(|_| "Invalid desktop bootstrap envelope")?;
    if e.mode != "desktop" || e.port == 0 || e.tailscale_serve_port == 0 {
        return Err("Invalid desktop bootstrap envelope");
    }
    Ok(Bootstrap {
        config: ConfigInput {
            mode: Some(Mode::Desktop),
            no_browser: Some(e.no_browser),
            port: Some(e.port),
            base_dir: e.t3_home,
            host: Some(e.host),
            tailscale_serve: Some(e.tailscale_serve_enabled),
            tailscale_port: Some(e.tailscale_serve_port),
            ..Default::default()
        },
        token: e.desktop_bootstrap_token,
        secret: e.desktop_bootstrap_secret,
        telemetry_fd: e.desktop_telemetry_fd.filter(|fd| *fd > 0),
        telemetry_control_fd: e.desktop_telemetry_control_fd.filter(|fd| *fd > 0),
        otlp_traces_url: e.otlp_traces_url,
    })
}

#[cfg(unix)]
pub fn read(fd: i32) -> Result<Option<Bootstrap>, &'static str> {
    use std::io::Read;
    use std::os::fd::FromRawFd;
    use std::time::{Duration, Instant};
    // Duplicate so this reader never takes ownership of the launcher's descriptor.
    let duplicate = unsafe { libc::dup(fd) };
    if duplicate < 0 {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF) {
            Ok(None)
        } else {
            Err("Failed to open desktop bootstrap descriptor")
        };
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(duplicate) };
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut line = Vec::new();
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Ok(None);
        };
        let mut pfd = libc::pollfd {
            fd: duplicate,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut pfd, 1, remaining.as_millis().max(1) as i32) };
        if ready == 0 {
            return Ok(None);
        }
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err("Failed to read desktop bootstrap descriptor");
        }
        let mut byte = [0];
        match file.read(&mut byte) {
            Ok(0) => return Ok(None),
            Ok(_) if byte[0] == b'\n' => return decode(&line).map(Some),
            Ok(_) => line.push(byte[0]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Failed to read desktop bootstrap descriptor"),
        }
        if line.len() > 1024 * 1024 {
            return Err("Invalid desktop bootstrap envelope");
        }
    }
}

#[cfg(not(unix))]
pub fn read(_fd: i32) -> Result<Option<Bootstrap>, &'static str> {
    Err("Desktop bootstrap descriptors are not supported on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_envelope_and_maps_configuration() {
        let b = decode(br#"{"mode":"desktop","noBrowser":true,"port":3773,"host":"127.0.0.1","desktopBootstrapToken":"credential","tailscaleServeEnabled":false,"tailscaleServePort":443}"#).unwrap();
        assert_eq!(b.config.mode, Some(Mode::Desktop));
        assert_eq!(b.token, "credential");
        assert!(decode(br#"{"mode":"web"}"#).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_single_envelope_from_an_inherited_pipe() {
        use std::io::Write;
        use std::os::fd::FromRawFd;
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let mut writer = unsafe { std::fs::File::from_raw_fd(fds[1]) };
        writeln!(writer, "{{\"mode\":\"desktop\",\"noBrowser\":true,\"port\":3773,\"host\":\"127.0.0.1\",\"desktopBootstrapToken\":\"credential\",\"tailscaleServeEnabled\":false,\"tailscaleServePort\":443}}").unwrap();
        let bootstrap = read(fds[0]).unwrap().unwrap();
        assert_eq!(bootstrap.token, "credential");
        unsafe {
            libc::close(fds[0]);
        }
        assert!(read(-1).unwrap().is_none());
    }
}
