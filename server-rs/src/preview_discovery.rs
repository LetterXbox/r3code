//! Bounded loopback-only configured preview URL discovery.
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};

pub fn configured(input: &Value) -> Option<Vec<url::Url>> {
    let Some(value) = input.get("configuredUrls") else {
        return Some(Vec::new());
    };
    let values = value.as_array()?;
    if values.len() > 32 {
        return None;
    }
    let mut urls = Vec::new();
    for value in values {
        let raw = value.as_str()?.trim();
        if raw.is_empty() || raw.chars().count() > 2048 {
            return None;
        }
        let Ok(mut url) = url::Url::parse(raw) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            continue;
        }
        match url.host_str() {
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1") => (),
            Some("0.0.0.0") => {
                if url.set_host(Some("localhost")).is_err() {
                    continue;
                }
            }
            _ => continue,
        }
        if !urls.iter().any(|u: &url::Url| u == &url) {
            urls.push(url);
        }
    }
    Some(urls)
}
#[derive(Default)]
pub struct ProbeCache {
    checked: Option<std::time::Instant>,
    servers: BTreeMap<u16, Value>,
}
pub async fn scan(
    urls: &[url::Url],
    terminals: &crate::terminal::TerminalManager,
    cache: &mut ProbeCache,
) -> Vec<Value> {
    let roots = terminals.discovery_processes();
    let owned = tokio::task::spawn_blocking(move || owned_listeners(&roots))
        .await
        .unwrap_or_default();
    if cache
        .checked
        .is_none_or(|at| at.elapsed() >= Duration::from_secs(15))
    {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(1))
            .build()
            .ok();
        let mut probes = Vec::new();
        if let Some(client) = client {
            for url in urls {
                let client = client.clone();
                probes.push(async move {
            let response=client.get(url.clone()).send().await.ok()?;
            let status=response.status().as_u16(); let redirect=matches!(status,301|302|303|307|308) && response.headers().get(reqwest::header::LOCATION).is_some_and(|v|!v.as_bytes().is_empty());
            let html=(200..300).contains(&status) && status!=204 && status!=205 && response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v|v.to_str().ok()).and_then(|v|v.split(';').next()).is_some_and(|v|matches!(v.trim().to_ascii_lowercase().as_str(),"text/html"|"application/xhtml+xml"));
            if !redirect && !html {return None;}
            let host=url.host_str()?.to_owned();let port=url.port_or_known_default()?;
            Some((port,json!({"host":host,"port":port,"url":url.as_str(),"processName":null,"pid":null,"terminal":null})))
        });
            }
        }
        cache.servers.clear();
        for (port, server) in futures_util::future::join_all(probes)
            .await
            .into_iter()
            .flatten()
        {
            cache.servers.entry(port).or_insert(server);
        }
        let ports = cache.servers.keys().copied().collect::<Vec<_>>();
        let metadata = tokio::task::spawn_blocking(move || listener_metadata(&ports))
            .await
            .unwrap_or_default();
        for (port, (pid, name)) in metadata {
            if let Some(server) = cache.servers.get_mut(&port) {
                server["host"] = json!("localhost");
                server["pid"] = json!(pid);
                server["processName"] = json!(name);
                server["agent"] = Value::Null;
            }
        }
        cache.checked = Some(std::time::Instant::now());
    }
    let mut by_port = BTreeMap::new();
    for mut server in owned {
        let Some(port) = server["port"].as_u64() else {
            continue;
        };
        if let Some(configured) = urls
            .iter()
            .find(|url| url.port_or_known_default() == Some(port as u16))
        {
            server["url"] = json!(configured.as_str());
        }
        by_port.insert(port as u16, server);
    }
    for (port, server) in &cache.servers {
        by_port.entry(*port).or_insert_with(|| server.clone());
    }
    by_port.into_values().collect()
}

#[cfg(target_os = "linux")]
fn listener_metadata(ports: &[u16]) -> BTreeMap<u16, (u32, Option<String>)> {
    use std::{
        collections::{HashMap, HashSet},
        fs,
    };
    let wanted: HashSet<_> = ports.iter().copied().collect();
    let mut inodes = HashMap::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(table) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 10 || fields[3] != "0A" {
                continue;
            }
            let Some((address, port)) = fields[1].split_once(':') else {
                continue;
            };
            let local = address == "00000000"
                || address == "0100007F"
                || address == "00000000000000000000000000000000"
                || address == "00000000000000000000000001000000"
                || address.starts_with("0000000000000000FFFF0000")
                    && matches!(&address[24..], "00000000" | "0100007F");
            let Ok(port) = u16::from_str_radix(port, 16) else {
                continue;
            };
            if local && wanted.contains(&port) {
                inodes.insert(fields[9].to_owned(), port);
            }
        }
    }
    if inodes.is_empty() {
        return BTreeMap::new();
    }
    let Ok(entries) = fs::read_dir("/proc") else {
        return BTreeMap::new();
    };
    let mut pids: Vec<_> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().parse::<u32>().ok())
        .collect();
    pids.sort_unstable();
    let mut remaining = 16_384usize;
    let mut result = BTreeMap::new();
    for pid in pids {
        if remaining == 0 || result.len() >= wanted.len() {
            break;
        }
        let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            if remaining == 0 {
                break;
            }
            remaining -= 1;
            let Ok(path) = fs::read_link(fd.path()) else {
                continue;
            };
            let text = path.to_string_lossy();
            let Some(inode) = text
                .strip_prefix("socket:[")
                .and_then(|s| s.strip_suffix(']'))
            else {
                continue;
            };
            if let Some(port) = inodes.get(inode) {
                let name = fs::read_to_string(format!("/proc/{pid}/comm"))
                    .ok()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty());
                result.entry(*port).or_insert((pid, name));
            }
        }
    }
    result
}
#[cfg(not(target_os = "linux"))]
fn listener_metadata(_ports: &[u16]) -> BTreeMap<u16, (u32, Option<String>)> {
    BTreeMap::new()
}

#[cfg(target_os = "linux")]
fn owned_listeners(roots: &[(u32, String, String)]) -> Vec<Value> {
    use std::{collections::HashMap, fs};
    if roots.is_empty() {
        return Vec::new();
    }
    let mut owners = HashMap::new();
    let mut pending = roots.to_vec();
    while let Some((pid, thread, terminal)) = pending.pop() {
        if owners.len() >= 4096 || owners.contains_key(&pid) {
            continue;
        }
        owners.insert(pid, (thread.clone(), terminal.clone()));
        let path = format!("/proc/{pid}/task/{pid}/children");
        if let Ok(children) = fs::read_to_string(path) {
            for child in children
                .split_whitespace()
                .filter_map(|s| s.parse::<u32>().ok())
            {
                pending.push((child, thread.clone(), terminal.clone()));
            }
        }
    }
    let mut sockets = HashMap::new();
    let mut budget = 16_384usize;
    for (pid, owner) in &owners {
        let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for entry in entries.flatten() {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let Ok(target) = fs::read_link(entry.path()) else {
                continue;
            };
            let text = target.to_string_lossy();
            if let Some(inode) = text
                .strip_prefix("socket:[")
                .and_then(|s| s.strip_suffix(']'))
            {
                sockets.insert(inode.to_owned(), (*pid, owner.clone()));
            }
        }
    }
    let mut result = BTreeMap::<u16, Option<Value>>::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(table) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 10 || fields[3] != "0A" {
                continue;
            }
            let Some((address, port)) = fields[1].split_once(':') else {
                continue;
            };
            let local = address == "00000000"
                || address == "0100007F"
                || address == "00000000000000000000000000000000"
                || address == "00000000000000000000000001000000"
                || address.starts_with("0000000000000000FFFF0000")
                    && matches!(&address[24..], "00000000" | "0100007F");
            if !local {
                continue;
            }
            let Ok(port) = u16::from_str_radix(port, 16) else {
                continue;
            };
            if port == 0 {
                continue;
            }
            let candidate = sockets.get(fields[9]).map(|(pid,(thread,terminal))| {
                let name=fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s|s.trim().to_owned()).filter(|s|!s.is_empty());
                json!({"host":"localhost","port":port,"url":format!("http://localhost:{port}"),"processName":name,"pid":pid,"terminal":{"threadId":thread,"terminalId":terminal},"agent":null})
            });
            match result.entry(port) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(candidate);
                }
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    if candidate.is_none() {
                        entry.insert(None);
                    }
                }
            }
        }
    }
    result.into_values().flatten().collect()
}
#[cfg(not(target_os = "linux"))]
fn owned_listeners(_roots: &[(u32, String, String)]) -> Vec<Value> {
    Vec::new()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessRow {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: u32,
}

pub fn parse_process_table(raw: &str) -> BTreeMap<u32, ProcessRow> {
    let mut rows = BTreeMap::new();
    for line in raw.lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(pgid), None) = (
            fields.next().and_then(|s| s.parse::<u32>().ok()),
            fields.next().and_then(|s| s.parse::<u32>().ok()),
            fields.next().and_then(|s| s.parse::<u32>().ok()),
            fields.next(),
        ) else {
            continue;
        };
        rows.insert(pid, ProcessRow { pid, ppid, pgid });
    }
    rows
}

/// The process group stopping `pid` signals. Returns `None` when the group also holds this
/// server, a direct child of it (agent CLIs and terminal shells), or one of its ancestors.
pub fn stoppable_process_group(
    table: &BTreeMap<u32, ProcessRow>,
    pid: u32,
    server_pid: u32,
) -> Option<u32> {
    let group = table.get(&pid)?.pgid;
    if group <= 1 {
        return None;
    }
    let mut guarded = std::collections::HashSet::from([server_pid]);
    let mut parent = table.get(&server_pid).map(|r| r.ppid);
    while let Some(p) = parent.filter(|&p| p > 1) {
        if !guarded.insert(p) {
            break;
        }
        parent = table.get(&p).map(|r| r.ppid);
    }
    if table
        .values()
        .any(|row| row.pgid == group && (guarded.contains(&row.pid) || row.ppid == server_pid))
    {
        return None;
    }
    Some(group)
}

fn stop_error(reason: &str) -> Value {
    let message = match reason {
        "not-found" => "This server is no longer running.",
        "shared-group" => "This server shares a process group with T3 Code, an agent, or a terminal shell, so it can't be stopped on its own.",
        "unsupported" => "Stopping servers is not supported on this environment's platform.",
        _ => "The server's processes could not be signaled.",
    };
    json!({
        "_tag": "PreviewStopLocalServerError",
        "reason": reason,
        "message": message,
    })
}

fn is_owned_server(server: &Value) -> bool {
    !server["terminal"].is_null() || !server["agent"].is_null()
}

#[cfg(unix)]
async fn read_process_table() -> Result<BTreeMap<u32, ProcessRow>, Value> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("ps")
            .args(["-A", "-o", "pid=,ppid=,pgid="])
            .output(),
    )
    .await
    .map_err(|_| stop_error("signal-failed"))?
    .map_err(|_| stop_error("signal-failed"))?;
    if !output.status.success() {
        return Err(stop_error("signal-failed"));
    }
    Ok(parse_process_table(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(unix)]
fn signal_process_group(group: u32, signal: libc::c_int) -> Result<bool, Value> {
    let rc = unsafe { libc::kill(-(group as libc::pid_t), signal) };
    if rc == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(stop_error("signal-failed"))
    }
}

pub async fn stop_local_server(
    pid: u32,
    port: u16,
    terminals: &crate::terminal::TerminalManager,
) -> Result<(), Value> {
    if cfg!(target_os = "windows") {
        return Err(stop_error("unsupported"));
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, port, terminals);
        return Err(stop_error("unsupported"));
    }
    #[cfg(unix)]
    {
        let roots = terminals.discovery_processes();
        let owned = tokio::task::spawn_blocking(move || owned_listeners(&roots))
            .await
            .unwrap_or_default();
        let listed = owned.iter().any(|server| {
            server["pid"].as_u64() == Some(u64::from(pid))
                && server["port"].as_u64() == Some(u64::from(port))
                && is_owned_server(server)
        });
        if !listed {
            return Err(stop_error("not-found"));
        }
        let table = read_process_table().await?;
        if !table.contains_key(&pid) {
            return Ok(());
        }
        let Some(group) = stoppable_process_group(&table, pid, std::process::id()) else {
            return Err(stop_error("shared-group"));
        };
        if !signal_process_group(group, libc::SIGTERM)? {
            return Ok(());
        }
        let members: Vec<u32> = table
            .values()
            .filter(|row| row.pgid == group)
            .map(|row| row.pid)
            .collect();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let still_running = read_process_table()
                .await
                .map(|current| {
                    members
                        .iter()
                        .any(|member| current.get(member).is_some_and(|r| r.pgid == group))
                })
                .unwrap_or(false);
            if !still_running {
                return Ok(());
            }
        }
        let _ = signal_process_group(group, libc::SIGKILL)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn finds_real_listener_owned_by_registered_terminal_process() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let roots = vec![(
            std::process::id(),
            "thread".to_owned(),
            "terminal".to_owned(),
        )];
        let found = owned_listeners(&roots);
        let server = found
            .iter()
            .find(|s| s["port"] == port)
            .expect("listener must be discovered");
        assert_eq!(server["terminal"]["threadId"], "thread");
        assert_eq!(server["terminal"]["terminalId"], "terminal");
        let metadata = listener_metadata(&[port]);
        assert_eq!(metadata.get(&port).map(|m| m.0), Some(std::process::id()));
    }

    #[test]
    fn rejects_non_loopback_and_bounds_input() {
        let urls=configured(&json!({"configuredUrls":["http://127.0.0.1:1234","http://example.com","http://0.0.0.0:2345"]})).unwrap();
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[1].host_str(), Some("localhost"));
        assert!(configured(&json!({"configuredUrls":vec!["http://localhost";33]})).is_none());
    }

    #[test]
    fn stoppable_process_group_guards_server_ancestors_and_direct_children() {
        let table = parse_process_table(
            "1 0 1\n\
             10 1 10\n\
             20 10 20\n\
             30 20 20\n\
             40 30 40\n",
        );
        assert_eq!(stoppable_process_group(&table, 40, 20), Some(40));
        assert_eq!(stoppable_process_group(&table, 30, 20), None);
        assert_eq!(stoppable_process_group(&table, 10, 20), None);
        assert_eq!(stoppable_process_group(&table, 1, 20), None);
    }
}
