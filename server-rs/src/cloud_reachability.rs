//! Public tunnel probe: pin resolved public addresses to avoid private-network redirects.
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
pub(crate) fn classify_http(
    status: u16,
    code: Option<&str>,
) -> (&'static str, String, &'static str) {
    if status == 502 {
        (
            "origin_unreachable",
            "The tunnel is up, but it cannot reach the T3 server on this machine.".into(),
            "Restart T3 Code so the tunnel uses the port the server listens on.",
        )
    } else if status == 530 && code.is_none_or(|value| value == "1033") {
        (
            "no_connector",
            "Cloudflare has no live connection from this machine for the tunnel.".into(),
            "Restart T3 Code. If it stays, run `t3 connect` again.",
        )
    } else {
        (
            "unexpected_response",
            format!(
                "The T3 Connect address answered with HTTP {status}{}.",
                code.map(|value| format!(" (Cloudflare error {value})"))
                    .unwrap_or_default()
            ),
            "Restart T3 Code. If it stays, run `t3 connect` again.",
        )
    }
}
fn public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let o = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && !ip.is_unspecified()
                && !ip.is_broadcast()
                && o[0] != 0
                && o[0] < 224
                && !(o[0] == 100 && (64..=127).contains(&o[1]))
                && !(o[0] == 192 && o[1] == 0 && matches!(o[2], 0 | 2))
                && !(o[0] == 198 && ((18..=19).contains(&o[1]) || (o[1] == 51 && o[2] == 100)))
                && !(o[0] == 203 && o[1] == 0 && o[2] == 113)
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return public(IpAddr::V4(ip));
            }
            let parts = ip.segments();
            let first = parts[0];
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && (first & 0xfe00) != 0xfc00
                && (first & 0xffc0) != 0xfe80
                && first != 0x2002
                && !(first == 0x2001 && matches!(parts[1], 0 | 0x0db8))
                && !(first == 0x0064 && parts[1] == 0xff9b)
        }
    }
}
pub(crate) enum Probe {
    Response(u16, Option<String>),
    DnsFailed,
    TimedOut,
}
pub(crate) async fn public_dns(host: &str) -> Option<bool> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(path) = std::env::var_os("SSL_CERT_FILE") {
        use std::io::Read as _;
        let file = std::fs::File::open(path).ok()?;
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 1024 * 1024 {
            return None;
        }
        for certificate in reqwest::Certificate::from_pem_bundle(&bytes).ok()? {
            builder = builder.add_root_certificate(certificate);
        }
    }
    let mut response = builder
        .build()
        .ok()?
        .get("https://1.1.1.1/dns-query")
        .query(&[("name", host), ("type", "A")])
        .header("accept", "application/dns-json")
        .send()
        .await
        .ok()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len().saturating_add(chunk.len()) > 65536 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    match serde_json::from_slice::<serde_json::Value>(&bytes).ok()?["Status"].as_u64() {
        Some(0) => Some(true),
        Some(3) => Some(false),
        _ => None,
    }
}
pub(crate) async fn probe(hostname: &str) -> Option<Probe> {
    let host = hostname.trim();
    if host != hostname
        || host.len() > 253
        || !host.contains('.')
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".local")
        || host.parse::<IpAddr>().is_ok()
        || host
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.'))
    {
        return None;
    }
    let url = url::Url::parse(&format!("https://{host}/")).ok()?;
    if url
        .host_str()
        .is_none_or(|value| !value.eq_ignore_ascii_case(host))
    {
        return None;
    }
    let mut addresses =
        match tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, 443)))
            .await
        {
            Ok(Ok(addresses)) => addresses,
            _ => return Some(Probe::DnsFailed),
        };
    let Some(address) = addresses.next() else {
        return Some(Probe::DnsFailed);
    };
    if !public(address.ip()) || addresses.any(|address| !public(address.ip())) {
        return None;
    }
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(host, SocketAddr::new(address.ip(), 443));
    if let Some(path) = std::env::var_os("SSL_CERT_FILE") {
        use std::io::Read as _;
        let file = std::fs::File::open(path).ok()?;
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 1024 * 1024 {
            return None;
        }
        for certificate in reqwest::Certificate::from_pem_bundle(&bytes).ok()? {
            builder = builder.add_root_certificate(certificate);
        }
    }
    let client = builder.build().ok()?;
    let mut response = match client
        .get(format!("https://{host}/.well-known/t3/environment"))
        .header("accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return Some(Probe::TimedOut),
    };
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    if status == 530 {
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len().saturating_add(chunk.len()) > 65536 {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    let body = String::from_utf8_lossy(&bytes);
    let error = regex::Regex::new(r#"(?i)error[_ ]code\"?:\s*(\d{4})"#)
        .ok()?
        .captures(&body)
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str().to_owned());
    Some(Probe::Response(status, error))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_addresses() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "::1",
            "fd00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!public(ip.parse().unwrap()));
        }
        assert!(public("1.1.1.1".parse().unwrap()));
    }
    #[test]
    fn classifies_endpoint_statuses() {
        assert_eq!(classify_http(502, None).0, "origin_unreachable");
        assert_eq!(classify_http(530, Some("1033")).0, "no_connector");
        assert_eq!(classify_http(530, Some("1016")).0, "unexpected_response");
    }
}
#[cfg(test)]
mod async_tests {
    #[tokio::test]
    async fn rejects_local_and_malformed_hosts_before_network() {
        for host in [
            "127.0.0.1",
            "localhost",
            "internal.local",
            "user@example.com",
            "example.com:443",
        ] {
            assert!(super::probe(host).await.is_none());
        }
    }
}

pub(crate) struct ExitNode {
    pub(crate) name: Option<String>,
}
pub(crate) async fn exit_node() -> Option<ExitNode> {
    use tokio::io::AsyncReadExt;
    let executable = if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    let mut child = tokio::process::Command::new(executable)
        .args(["status", "--json"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (status, bytes) = tokio::time::timeout(Duration::from_millis(3500), async {
        let mut bytes = Vec::new();
        stdout.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, bytes))
    })
    .await
    .ok()?
    .ok()?;
    if !status.success() || bytes.len() > 1024 * 1024 {
        return None;
    }
    let data: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if !data
        .get("ExitNodeStatus")
        .is_some_and(serde_json::Value::is_object)
    {
        return None;
    }
    let peer = data["Peer"]
        .as_object()
        .and_then(|peers| peers.values().find(|peer| peer["ExitNode"] == true));
    let name = peer
        .and_then(|peer| peer["DNSName"].as_str())
        .and_then(|value| value.split('.').next())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            peer.and_then(|peer| peer["HostName"].as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(str::to_owned);
    Some(ExitNode { name })
}
pub(crate) fn exit_node_hint(exit: Option<&ExitNode>) -> Option<String> {
    exit.map(|exit| {
        format!(
            "Tailscale exit node{} is on. Traffic to Cloudflare goes through it.",
            exit.name
                .as_ref()
                .map(|name| format!(" \"{name}\""))
                .unwrap_or_default()
        )
    })
}
