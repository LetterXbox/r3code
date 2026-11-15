//! Server configuration precedence. Input parsing and desktop bootstrap I/O are separate.
use crate::runtime::{resolve_base_dir, ServerPaths};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Web,
    Desktop,
}

/// Parsed values from a single source. `None` means unspecified, not false.
#[derive(Debug, Default, Clone)]
pub struct ConfigInput {
    pub mode: Option<Mode>,
    pub port: Option<u16>,
    pub host: Option<String>,
    pub base_dir: Option<String>,
    pub dev_url: Option<String>,
    pub no_browser: Option<bool>,
    pub auto_bootstrap: Option<bool>,
    pub log_websocket_events: Option<bool>,
    pub tailscale_serve: Option<bool>,
    pub tailscale_port: Option<u16>,
    pub lan: Option<bool>,
}

#[derive(Clone)]
pub struct ResolvedConfig {
    pub mode: Mode,
    /// None requires the web-mode available-port probe at bind time.
    pub port: Option<u16>,
    pub host: Option<String>,
    pub private_network_only: bool,
    pub paths: ServerPaths,
    pub dev_url: Option<String>,
    pub no_browser: bool,
    pub auto_bootstrap: bool,
    pub log_websocket_events: bool,
    pub tailscale_serve: bool,
    pub tailscale_port: u16,
    pub desktop_bootstrap_token: Option<String>,
    pub desktop_bootstrap_secret: Option<String>,
    pub desktop_telemetry_fd: Option<i32>,
    pub desktop_telemetry_control_fd: Option<i32>,
    pub desktop_otlp_traces_url: Option<String>,
}

/// Resolve CLI > environment > desktop bootstrap > defaults. The caller must
/// validate URLs and input types before invoking this function.
pub fn resolve(
    flags: &ConfigInput,
    env: &ConfigInput,
    bootstrap: &ConfigInput,
    home: &Path,
    cwd: &Path,
    headless: bool,
    service_managed: bool,
) -> Result<ResolvedConfig, &'static str> {
    let mode = flags
        .mode
        .or(env.mode)
        .or(bootstrap.mode)
        .unwrap_or(Mode::Web);
    let explicit_home = flags
        .base_dir
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| env.base_dir.as_deref().filter(|s| !s.trim().is_empty()));
    let selected_home = explicit_home.or_else(|| {
        bootstrap
            .base_dir
            .as_deref()
            .filter(|s| !s.trim().is_empty())
    });
    let dev_url = flags.dev_url.clone().or_else(|| env.dev_url.clone());
    let explicit_host = flags
        .host
        .clone()
        .or_else(|| env.host.clone())
        .or_else(|| bootstrap.host.clone());
    let lan = flags.lan.or(env.lan).unwrap_or(service_managed);
    let private_network_only = explicit_host.is_none() && mode == Mode::Web && lan;
    let host = explicit_host.or_else(|| {
        if private_network_only {
            Some("0.0.0.0".into())
        } else if mode == Mode::Desktop {
            Some("127.0.0.1".into())
        } else {
            None
        }
    });
    let port = flags
        .port
        .or(env.port)
        .or(bootstrap.port)
        .or(if mode == Mode::Desktop {
            Some(3773)
        } else {
            None
        });
    let tailscale_port = flags
        .tailscale_port
        .or(env.tailscale_port)
        .or(bootstrap.tailscale_port)
        .unwrap_or(443);
    if port == Some(0) || tailscale_port == 0 {
        return Err("port must be between 1 and 65535");
    }
    let paths = ServerPaths::new(
        resolve_base_dir(selected_home, home, cwd),
        dev_url.is_some(),
        explicit_home.is_some(),
        None::<PathBuf>,
    );
    Ok(ResolvedConfig {
        mode,
        port,
        host,
        private_network_only,
        paths,
        no_browser: headless
            || flags
                .no_browser
                .or(env.no_browser)
                .or(bootstrap.no_browser)
                .unwrap_or(mode == Mode::Desktop),
        auto_bootstrap: !headless
            && flags
                .auto_bootstrap
                .or(env.auto_bootstrap)
                .unwrap_or(mode == Mode::Web),
        log_websocket_events: flags
            .log_websocket_events
            .or(env.log_websocket_events)
            .unwrap_or(dev_url.is_some()),
        tailscale_serve: flags
            .tailscale_serve
            .or(env.tailscale_serve)
            .or(bootstrap.tailscale_serve)
            .unwrap_or(false),
        tailscale_port,
        desktop_bootstrap_token: None,
        desktop_bootstrap_secret: None,
        desktop_telemetry_fd: None,
        desktop_telemetry_control_fd: None,
        desktop_otlp_traces_url: None,
        dev_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn precedence_and_headless_behavior() {
        let flags = ConfigInput {
            port: Some(3333),
            base_dir: Some("  ".into()),
            auto_bootstrap: Some(true),
            ..Default::default()
        };
        let env = ConfigInput {
            port: Some(4444),
            base_dir: Some("env-home".into()),
            lan: Some(false),
            ..Default::default()
        };
        let bootstrap = ConfigInput {
            port: Some(5555),
            base_dir: Some("boot-home".into()),
            ..Default::default()
        };
        let c = resolve(
            &flags,
            &env,
            &bootstrap,
            Path::new("/home/a"),
            Path::new("/tmp"),
            true,
            true,
        )
        .unwrap();
        assert_eq!(c.port, Some(3333));
        assert_eq!(c.paths.state_dir, PathBuf::from("/tmp/env-home/userdata"));
        assert!(!c.private_network_only);
        assert!(c.no_browser);
        assert!(!c.auto_bootstrap);
    }
    #[test]
    fn defaults_and_private_bind() {
        let empty = ConfigInput::default();
        let web = resolve(
            &empty,
            &empty,
            &empty,
            Path::new("/h"),
            Path::new("/"),
            false,
            true,
        )
        .unwrap();
        assert_eq!(web.mode, Mode::Web);
        assert_eq!(web.port, None);
        assert_eq!(web.host.as_deref(), Some("0.0.0.0"));
        assert!(web.private_network_only);
        let desktop = ConfigInput {
            mode: Some(Mode::Desktop),
            ..Default::default()
        };
        let c = resolve(
            &desktop,
            &empty,
            &empty,
            Path::new("/h"),
            Path::new("/"),
            false,
            false,
        )
        .unwrap();
        assert_eq!(c.port, Some(3773));
        assert_eq!(c.host.as_deref(), Some("127.0.0.1"));
        assert!(c.no_browser);
        assert!(!c.auto_bootstrap);
    }
}
