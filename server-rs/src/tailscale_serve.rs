//! Manage the server's optional Tailscale Serve root route conservatively.
use serde_json::Value;
use std::{net::IpAddr, time::Duration};
use tokio::{net::TcpStream, process::Command};

#[derive(Debug, PartialEq)]
enum Holder {
    Ours,
    Loopback(String, u16),
    Other,
}

fn proxy_target(proxy: &str) -> Option<(String, u16)> {
    if proxy.starts_with("unix:") {
        return None;
    }
    let expanded = if proxy.bytes().all(|b| b.is_ascii_digit()) && !proxy.is_empty() {
        format!("http://127.0.0.1:{proxy}")
    } else if let Some(rest) = proxy.strip_prefix("https+insecure://") {
        format!("https://{rest}")
    } else if proxy.contains("://") {
        proxy.to_string()
    } else {
        format!("http://{proxy}")
    };
    let url = url::Url::parse(&expanded).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some((
        url.host_str()?.trim_matches(['[', ']']).to_lowercase(),
        url.port_or_known_default()?,
    ))
}

fn matches_target(host: &str, port: u16, target_host: &str, target_port: u16) -> bool {
    if port != target_port {
        return false;
    }
    let norm = |s: &str| {
        s.parse::<IpAddr>().ok().map(|ip| match ip {
            IpAddr::V6(v6) => v6
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(v6)),
            other => other,
        })
    };
    match (norm(host), norm(target_host)) {
        (Some(a), Some(b)) => a == b || (a.is_unspecified() && b.is_loopback()),
        _ => host.eq_ignore_ascii_case(target_host),
    }
}

fn root_holders(
    status: &Value,
    serve_port: u16,
    target_host: &str,
    target_port: u16,
) -> Option<Vec<Holder>> {
    if status.is_null() {
        return Some(vec![]);
    }
    let obj = status.as_object()?;
    let mut holders = Vec::new();
    if let Some(tcp) = obj.get("TCP") {
        for (port, entry) in tcp.as_object()? {
            let entry = entry.as_object()?;
            if port.parse::<u16>().ok() == Some(serve_port) && entry.contains_key("TCPForward") {
                holders.push(Holder::Other);
            }
        }
    }
    if let Some(web) = obj.get("Web") {
        for (host_port, site) in web.as_object()? {
            let site = site.as_object()?;
            let handlers = match site.get("Handlers") {
                Some(v) => v.as_object()?,
                None => continue,
            };
            let Some(root) = handlers.get("/") else {
                continue;
            };
            let root = root.as_object()?;
            if host_port
                .rsplit_once(':')
                .and_then(|(_, p)| p.parse::<u16>().ok())
                != Some(serve_port)
            {
                continue;
            }
            let proxy = match root.get("Proxy") {
                Some(v) => v.as_str()?,
                None => {
                    holders.push(Holder::Other);
                    continue;
                }
            };
            match proxy_target(proxy) {
                Some((host, port)) if matches_target(&host, port, target_host, target_port) => {
                    holders.push(Holder::Ours)
                }
                Some((host, port))
                    if host == "localhost"
                        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()) =>
                {
                    holders.push(Holder::Loopback(host, port))
                }
                _ => holders.push(Holder::Other),
            }
        }
    }
    Some(holders)
}

fn executable() -> std::path::PathBuf {
    if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    }
    .into()
}

async fn command(cli: &std::path::Path, args: &[String]) -> Result<String, ()> {
    let mut command = Command::new(cli);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    if !output.status.success() {
        return Err(());
    }
    String::from_utf8(output.stdout).map_err(|_| ())
}
async fn status(cli: &std::path::Path) -> Result<Value, ()> {
    let raw = command(cli, &["serve".into(), "status".into(), "--json".into()]).await?;
    serde_json::from_str(&raw).map_err(|_| ())
}
async fn holder_available(
    value: &Value,
    serve_port: u16,
    host: &str,
    port: u16,
) -> Result<bool, ()> {
    let holders = root_holders(value, serve_port, host, port).ok_or(())?;
    for holder in holders {
        match holder {
            Holder::Other => return Ok(false),
            Holder::Loopback(host, port) => {
                // Uncertainty means another service may own the route.
                if !matches!(
                    tokio::time::timeout(
                        Duration::from_secs(2),
                        TcpStream::connect((host.as_str(), port))
                    )
                    .await,
                    Ok(Err(ref error)) if error.kind() == std::io::ErrorKind::ConnectionRefused
                ) {
                    return Ok(false);
                }
            }
            Holder::Ours => {}
        }
    }
    Ok(true)
}
async fn configure(
    cli: &std::path::Path,
    host: &str,
    port: u16,
    serve_port: u16,
) -> Result<(), ()> {
    let url_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    command(
        cli,
        &[
            "serve".into(),
            "--bg".into(),
            format!("--https={serve_port}"),
            format!("http://{url_host}:{port}"),
        ],
    )
    .await
    .map(|_| ())
}

/// Start an owned background route when its root is free, and repair stale routes.
pub async fn start(
    host: String,
    port: u16,
    serve_port: u16,
) -> Option<tokio::task::JoinHandle<()>> {
    start_with_cli(executable(), host, port, serve_port).await
}

async fn start_with_cli(
    cli: std::path::PathBuf,
    host: String,
    port: u16,
    serve_port: u16,
) -> Option<tokio::task::JoinHandle<()>> {
    let initial = status(&cli).await;
    match initial {
        Ok(value) if holder_available(&value, serve_port, &host, port).await == Ok(true) => {
            if configure(&cli, &host, port, serve_port).await.is_err() {
                eprintln!("Warning: failed to configure Tailscale Serve");
                return None;
            }
        }
        _ => {
            eprintln!("Warning: Tailscale Serve root is occupied or its status is unavailable");
            return None;
        }
    }
    Some(tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if let Ok(value) = status(&cli).await {
                if holder_available(&value, serve_port, &host, port).await == Ok(true)
                    && !root_holders(&value, serve_port, &host, port)
                        .is_some_and(|h| h.contains(&Holder::Ours))
                {
                    let _ = configure(&cli, &host, port, serve_port).await;
                }
            }
        }
    }))
}

/// Remove only an exact root proxy under the machine's current MagicDNS name.
pub async fn stop(host: &str, port: u16, serve_port: u16) {
    stop_with_cli(&executable(), host, port, serve_port).await
}

#[derive(Debug)]
struct PolicyRoute {
    port: u16,
    mount: Option<String>,
    host: Option<String>,
    owned: bool,
    ambiguous: bool,
}

fn policy_routes(value: &Value, host: &str, port: u16) -> Result<Vec<PolicyRoute>, ()> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let root = value.as_object().ok_or(())?;
    let mut routes = Vec::new();
    let mut scan = |config: &Value, owned: bool| -> Result<(), ()> {
        let config = config.as_object().ok_or(())?;
        let reaches = |target: &str, tcp: bool| -> Option<bool> {
            if target.starts_with("unix:") {
                return None;
            }
            let expanded = if tcp {
                format!("http://{target}")
            } else {
                target.to_owned()
            };
            let (target_host, target_port) = proxy_target(&expanded)?;
            if target_port != port {
                return None;
            }
            // URL parsing canonicalizes shorthand IPv4 such as 127.1. Go's
            // Tailscale parser treats that as a hostname, which is ambiguous.
            let raw = target.split_once("://").map_or(target, |(_, rest)| rest);
            let authority = raw
                .split(['/', '?', '#'])
                .next()
                .unwrap_or("")
                .rsplit('@')
                .next()
                .unwrap_or("");
            let raw_host = if let Some(bracketed) = authority.strip_prefix('[') {
                bracketed.split(']').next().unwrap_or("")
            } else {
                authority
                    .rsplit_once(':')
                    .map_or(authority, |(host, _)| host)
            };
            let numeric_port = !tcp && target.bytes().all(|byte| byte.is_ascii_digit());
            if !numeric_port && raw_host.parse::<IpAddr>().is_err() {
                return Some(true);
            }
            if let Ok(ip) = target_host.parse::<IpAddr>() {
                if ip.is_unspecified() && ip.is_ipv6() {
                    return Some(true);
                }
                if matches_target(&target_host, target_port, host, port) {
                    return Some(false);
                }
                if ip.is_unspecified() {
                    return Some(true);
                }
                None
            } else {
                Some(true)
            }
        };
        if let Some(web) = config.get("Web") {
            for (host_port, site) in web.as_object().ok_or(())? {
                let (name, serve_port) = host_port.rsplit_once(':').ok_or(())?;
                let serve_port = serve_port.parse::<u16>().map_err(|_| ())?;
                if let Some(handlers) = site.get("Handlers") {
                    for (mount, handler) in handlers.as_object().ok_or(())? {
                        if let Some(target) = handler.get("Proxy") {
                            if let Some(ambiguous) = reaches(target.as_str().ok_or(())?, false) {
                                routes.push(PolicyRoute {
                                    port: serve_port,
                                    mount: Some(mount.clone()),
                                    host: Some(name.to_owned()),
                                    owned,
                                    ambiguous,
                                });
                            }
                        }
                    }
                }
            }
        }
        if let Some(tcp) = config.get("TCP") {
            for (serve_port, handler) in tcp.as_object().ok_or(())? {
                if let Some(target) = handler.get("TCPForward") {
                    if let Some(ambiguous) = reaches(target.as_str().ok_or(())?, true) {
                        routes.push(PolicyRoute {
                            port: serve_port.parse().map_err(|_| ())?,
                            mount: None,
                            host: None,
                            owned,
                            ambiguous,
                        });
                    }
                }
            }
        }
        Ok(())
    };
    scan(value, true)?;
    for group in ["Services", "Foreground"] {
        if let Some(entries) = root.get(group) {
            for config in entries.as_object().ok_or(())?.values() {
                scan(config, false)?;
            }
        }
    }
    Ok(routes)
}

/// Remove only unambiguous routes owned by this machine, then verify that
/// no remaining Tailscale route can reach a policy-restricted listener.
pub async fn enforce_local_only(host: &str, port: u16) -> Result<(), String> {
    let cli = executable();
    let read = || async {
        let output = match tokio::time::timeout(
            Duration::from_secs(10),
            Command::new(&cli)
                .args(["serve", "status", "--json"])
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            Ok(Ok(output)) => output,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            _ => return Err("Cannot verify Tailscale Serve routes".to_owned()),
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let down = regex::Regex::new(r"(?i)not logged in|logged out|needs? login|doesn't appear to be running|tailscaled\.service not running|tailscale is stopped|tailscaled: the system cannot find the file specified|failed to connect to local tailscale[\s\S]*(connection refused|no such file or directory|cannot find the file)").map_err(|_| "Cannot verify Tailscale Serve routes")?;
            if down.is_match(&stderr) {
                return Ok(None);
            }
            return Err("Cannot verify Tailscale Serve routes".into());
        }
        let value = serde_json::from_slice::<Value>(&output.stdout)
            .map_err(|_| "Invalid Tailscale Serve status".to_owned())?;
        Ok(Some(value))
    };
    let Some(initial) = read().await? else {
        return Ok(());
    };
    let routes =
        policy_routes(&initial, host, port).map_err(|_| "Invalid Tailscale Serve status")?;
    if routes.is_empty() {
        return Ok(());
    }
    let name = if routes
        .iter()
        .any(|route| route.mount.is_some() && route.owned && !route.ambiguous)
    {
        let raw = command(&cli, &["status".into(), "--json".into()])
            .await
            .map_err(|_| "Cannot verify Tailscale machine name")?;
        serde_json::from_str::<Value>(&raw).ok().and_then(|value| {
            value
                .pointer("/Self/DNSName")
                .and_then(Value::as_str)
                .map(|name| name.trim_end_matches('.').to_owned())
        })
    } else {
        None
    };
    for route in &routes {
        if !route.owned || route.ambiguous {
            continue;
        }
        let args = if let Some(mount) = &route.mount {
            if name
                .as_deref()
                .zip(route.host.as_deref())
                .is_none_or(|(current, host)| {
                    !current.eq_ignore_ascii_case(host.trim_end_matches('.'))
                })
            {
                continue;
            }
            vec![
                "serve".into(),
                format!("--https={}", route.port),
                format!("--set-path={mount}"),
                "off".into(),
            ]
        } else {
            vec![
                "serve".into(),
                format!("--tcp={}", route.port),
                "off".into(),
            ]
        };
        let _ = command(&cli, &args).await;
    }
    let Some(final_status) = read().await? else {
        return Err("Cannot verify Tailscale Serve routes".into());
    };
    if !policy_routes(&final_status, host, port)
        .map_err(|_| "Invalid Tailscale Serve status")?
        .is_empty()
    {
        return Err(
            "Remote clients are disabled, but Tailscale Serve still forwards to this server".into(),
        );
    }
    Ok(())
}

async fn stop_with_cli(cli: &std::path::Path, host: &str, port: u16, serve_port: u16) {
    let Ok(value) = status(cli).await else { return };
    let Ok(raw) = command(cli, &["status".into(), "--json".into()]).await else {
        return;
    };
    let Ok(node) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(name) = node
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|s| s.trim_end_matches('.'))
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let Some(web) = value.get("Web").and_then(Value::as_object) else {
        return;
    };
    let key = format!("{name}:{serve_port}");
    let ours = web
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(&key))
        .and_then(|(_, v)| v.pointer("/Handlers/~1/Proxy"))
        .and_then(Value::as_str)
        .and_then(proxy_target)
        .is_some_and(|(h, p)| matches_target(&h, p, host, port));
    if ours
        && command(
            cli,
            &[
                "serve".into(),
                format!("--https={serve_port}"),
                "--set-path=/".into(),
                "off".into(),
            ],
        )
        .await
        .is_err()
    {
        eprintln!("Warning: failed to disable Tailscale Serve");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn policy_routes_detect_nested_and_ambiguous_targets() {
        let status = json!({"Web":{"fixture.tail:8443":{"Handlers":{"/app":{"Proxy":"http://127.0.0.1:3773"},"/other":{"Proxy":"http://127.0.0.1:9000"}}}},"TCP":{"9443":{"TCPForward":"127.0.0.1:3773"}},"Foreground":{"one":{"Web":{"fixture.tail:10443":{"Handlers":{"/":{"Proxy":"http://localhost:3773"}}}}}}});
        let routes = policy_routes(&status, "127.0.0.1", 3773).unwrap();
        assert_eq!(routes.len(), 3);
        assert!(routes
            .iter()
            .any(|route| route.mount.as_deref() == Some("/app")
                && route.owned
                && !route.ambiguous));
        assert!(routes
            .iter()
            .any(|route| route.mount.is_none() && route.owned && !route.ambiguous));
        assert!(routes.iter().any(|route| !route.owned && route.ambiguous));
        let shorthand =
            json!({"Web":{"fixture.tail:8443":{"Handlers":{"/":{"Proxy":"http://127.1:3773"}}}}});
        assert!(policy_routes(&shorthand, "127.0.0.1", 3773).unwrap()[0].ambiguous);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn fake_cli_creates_and_removes_only_owned_root() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("t3-tailscale-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let cli = dir.join("tailscale");
        std::fs::write(&cli, r##"#!/bin/sh
set -eu
dir=$(dirname "$0")
printf '%s\n' "$*" >> "$dir/log"
case "$*" in
  'serve status --json') cat "$dir/status" ;;
  'status --json') printf '%s\n' '{"Self":{"DNSName":"node.ts.net."}}' ;;
  'serve --bg --https=8443 http://127.0.0.1:3773')
    printf '%s\n' '{"Web":{"node.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3773"},"/other":{"Proxy":"3000"}}}}}' > "$dir/status" ;;
  'serve --https=8443 --set-path=/ off')
    printf '%s\n' '{"Web":{"node.ts.net:8443":{"Handlers":{"/other":{"Proxy":"3000"}}}}}' > "$dir/status" ;;
  *) exit 1 ;;
esac
"##).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let state = dir.join("status");
        std::fs::write(&state, "null").unwrap();

        let task = start_with_cli(cli.clone(), "127.0.0.1".into(), 3773, 8443)
            .await
            .unwrap();
        let configured: Value = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
        assert_eq!(
            configured.pointer("/Web/node.ts.net:8443/Handlers/~1/Proxy"),
            Some(&json!("http://127.0.0.1:3773"))
        );
        task.abort();
        let _ = task.await;
        stop_with_cli(&cli, "127.0.0.1", 3773, 8443).await;
        let cleared: Value = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
        assert!(cleared
            .pointer("/Web/node.ts.net:8443/Handlers/~1")
            .is_none());
        assert_eq!(
            cleared.pointer("/Web/node.ts.net:8443/Handlers/~1other/Proxy"),
            Some(&json!("3000"))
        );
        let log = std::fs::read_to_string(dir.join("log")).unwrap();
        assert_eq!(
            log.lines().collect::<Vec<_>>(),
            [
                "serve status --json",
                "serve --bg --https=8443 http://127.0.0.1:3773",
                "serve status --json",
                "status --json",
                "serve --https=8443 --set-path=/ off"
            ]
        );

        // A replacement route belongs to someone else and must survive shutdown.
        let other = json!({"Web":{"node.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://other.example:9999"}}}}}).to_string();
        std::fs::write(&state, &other).unwrap();
        assert!(start_with_cli(cli.clone(), "127.0.0.1".into(), 3773, 8443)
            .await
            .is_none());
        stop_with_cli(&cli, "127.0.0.1", 3773, 8443).await;
        assert_eq!(std::fs::read_to_string(&state).unwrap(), other);
        assert_eq!(
            std::fs::read_to_string(dir.join("log"))
                .unwrap()
                .lines()
                .filter(|line| line.ends_with(" off"))
                .count(),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checks_root_ownership_and_malformed_status() {
        assert_eq!(
            root_holders(&Value::Null, 443, "127.0.0.1", 3773),
            Some(vec![])
        );
        let status = json!({"Web":{"node.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3773"},"/other":{"Proxy":"3000"}}}}});
        assert_eq!(
            root_holders(&status, 443, "127.0.0.1", 3773),
            Some(vec![Holder::Ours])
        );
        assert_eq!(
            root_holders(&status, 443, "127.0.0.1", 4000),
            Some(vec![Holder::Loopback("127.0.0.1".into(), 3773)])
        );
        assert_eq!(
            root_holders(
                &json!({"TCP":{"443":{"TCPForward":"example:80"}}}),
                443,
                "127.0.0.1",
                3773
            ),
            Some(vec![Holder::Other])
        );
        assert_eq!(
            root_holders(&json!({"Web":[]}), 443, "127.0.0.1", 3773),
            None
        );
    }
    #[tokio::test]
    async fn live_and_ambiguous_routes_are_preserved_and_dead_loopback_can_be_reclaimed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let route = |proxy: String| json!({"Web":{"node:443":{"Handlers":{"/":{"Proxy":proxy}}}}});
        let live = route(format!("http://127.0.0.1:{port}"));
        assert_eq!(
            holder_available(&live, 443, "127.0.0.1", 1234).await,
            Ok(false)
        );
        drop(listener);
        // Another concurrent test can acquire an ephemeral port immediately after
        // it is released. Retry with fresh candidates if that happens.
        let mut reclaimed = holder_available(&live, 443, "127.0.0.1", 1234).await == Ok(true);
        for _ in 0..10 {
            if reclaimed {
                break;
            }
            let candidate = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = candidate.local_addr().unwrap().port();
            drop(candidate);
            reclaimed = holder_available(
                &route(format!("http://127.0.0.1:{port}")),
                443,
                "127.0.0.1",
                1234,
            )
            .await
                == Ok(true);
        }
        assert!(reclaimed);
        let remote = route("http://other.example:3000".into());
        assert_eq!(
            holder_available(&remote, 443, "127.0.0.1", 1234).await,
            Ok(false)
        );
    }

    #[test]
    fn parses_proxy_targets() {
        assert_eq!(proxy_target("3773"), Some(("127.0.0.1".into(), 3773)));
        assert_eq!(
            proxy_target("https+insecure://[::1]:1234"),
            Some(("::1".into(), 1234))
        );
        assert!(matches_target("::ffff:127.0.0.1", 3773, "127.0.0.1", 3773));
        assert_eq!(proxy_target("unix:/tmp/socket"), None);
    }
}
