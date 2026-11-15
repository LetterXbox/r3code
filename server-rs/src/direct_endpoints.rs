//! Discovery of private addresses that clients can use to reach the server.
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Clone, Debug)]
struct InterfaceAddress {
    name: String,
    address: IpAddr,
    internal: bool,
    virtual_adapter: bool,
}

fn virtual_interface(name: &str) -> bool {
    [
        "docker",
        "br-",
        "veth",
        "virbr",
        "vmnet",
        "vboxnet",
        "vEthernet",
        "podman",
        "cni",
        "flannel",
        "cali",
        "lxcbr",
        "lxdbr",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
        || name.strip_prefix("bridge").is_some_and(|v| {
            let bytes = v.as_bytes();
            bytes.len() >= 3
                && (b'1'..=b'9').contains(&bytes[0])
                && bytes[1..3].iter().all(u8::is_ascii_digit)
        })
}

fn tailnet_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    segments[0..3] == [0xfd7a, 0x115c, 0xa1e0]
}

fn bound_endpoints(
    host: &str,
    port: u16,
    interfaces: &[InterfaceAddress],
    on_cloud_vm: bool,
) -> Vec<Value> {
    use std::collections::HashSet;
    let tailnet_names: HashSet<&str> = interfaces
        .iter()
        .filter(|entry| {
            entry.name.to_ascii_lowercase().starts_with("tailscale")
                || matches!(entry.address, IpAddr::V6(ip) if tailnet_v6(ip))
        })
        .map(|entry| entry.name.as_str())
        .collect();
    let tailnet_addresses: HashSet<IpAddr> = interfaces
        .iter()
        .filter(|entry| tailnet_names.contains(entry.name.as_str()))
        .map(|entry| entry.address)
        .collect();
    let wildcard = matches!(host, "0.0.0.0" | "::" | "[::]");
    let allowed = |ip: Ipv4Addr| {
        !ip.is_loopback() && crate::startup_access::is_private_network_address(&ip.to_string())
    };
    let candidates: Vec<Ipv4Addr> = if wildcard {
        interfaces
            .iter()
            .filter(|entry| {
                !entry.internal && !entry.virtual_adapter && !virtual_interface(&entry.name)
            })
            .filter_map(|entry| match entry.address {
                IpAddr::V4(ip) if allowed(ip) => Some(ip),
                _ => None,
            })
            .collect()
    } else {
        host.parse::<Ipv4Addr>()
            .ok()
            .filter(|ip| allowed(*ip))
            .into_iter()
            .collect()
    };
    let mut seen = HashSet::new();
    candidates.into_iter().filter(|ip| seen.insert(*ip)).filter_map(|ip| {
        let tailnet = tailnet_addresses.contains(&IpAddr::V4(ip));
        if on_cloud_vm && !tailnet { return None; }
        Some(json!({"kind":if tailnet {"tailnet"} else {"lan"}, "httpBaseUrl":format!("http://{ip}:{port}/")}))
    }).collect()
}

#[cfg(unix)]
fn interfaces() -> Vec<InterfaceAddress> {
    use std::ffi::CStr;
    let mut list = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return vec![];
    }
    let mut result = Vec::new();
    let mut item = list;
    while !item.is_null() {
        let entry = unsafe { &*item };
        if !entry.ifa_addr.is_null() && !entry.ifa_name.is_null() {
            let address = unsafe {
                match (*entry.ifa_addr).sa_family as i32 {
                    libc::AF_INET => {
                        let addr = &*(entry.ifa_addr.cast::<libc::sockaddr_in>());
                        Some(IpAddr::V4(Ipv4Addr::from(
                            addr.sin_addr.s_addr.to_ne_bytes(),
                        )))
                    }
                    libc::AF_INET6 => {
                        let addr = &*(entry.ifa_addr.cast::<libc::sockaddr_in6>());
                        Some(IpAddr::V6(Ipv6Addr::from(addr.sin6_addr.s6_addr)))
                    }
                    _ => None,
                }
            };
            if let Some(address) = address {
                let name = unsafe { CStr::from_ptr(entry.ifa_name) }
                    .to_string_lossy()
                    .into_owned();
                result.push(InterfaceAddress {
                    name,
                    address,
                    internal: entry.ifa_flags & libc::IFF_LOOPBACK as u32 != 0,
                    virtual_adapter: false,
                });
            }
        }
        item = entry.ifa_next;
    }
    unsafe { libc::freeifaddrs(list) };
    result
}

#[cfg(windows)]
fn interfaces() -> Vec<InterfaceAddress> {
    use windows_sys::Win32::{
        NetworkManagement::IpHelper::{
            GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
            GAA_FLAG_SKIP_MULTICAST, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
        },
        Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6},
    };
    // The API fills an aligned caller-owned buffer containing linked records.
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_SKIP_MULTICAST;
    let mut size = 0u32;
    unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut size,
        );
    }
    if size == 0 || size > 16 * 1024 * 1024 {
        return vec![];
    }
    let mut storage = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    let mut adapter = storage.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    if unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            std::ptr::null(),
            adapter,
            &mut size,
        )
    } != 0
    {
        return vec![];
    }
    let mut result = Vec::new();
    while !adapter.is_null() {
        let current = unsafe { &*adapter };
        let name = if current.FriendlyName.is_null() {
            String::new()
        } else {
            let mut len = 0usize;
            while unsafe { *current.FriendlyName.add(len) } != 0 {
                len += 1;
            }
            String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(current.FriendlyName, len)
            })
        };
        let mac = &current.PhysicalAddress;
        let virtual_adapter = current.PhysicalAddressLength >= 6
            && (mac[..3] == [0x0a, 0x00, 0x27] || mac[..5] == [0x00, 0x50, 0x56, 0xc0, 0x00]);
        let mut unicast = current.FirstUnicastAddress;
        while !unicast.is_null() {
            let entry = unsafe { &*unicast };
            let socket = entry.Address.lpSockaddr;
            if !socket.is_null() {
                let address = unsafe {
                    match (*socket).sa_family {
                        AF_INET => {
                            let addr = &*socket.cast::<SOCKADDR_IN>();
                            Some(IpAddr::V4(Ipv4Addr::from(
                                addr.sin_addr.S_un.S_addr.to_ne_bytes(),
                            )))
                        }
                        AF_INET6 => {
                            let addr = &*socket.cast::<SOCKADDR_IN6>();
                            Some(IpAddr::V6(Ipv6Addr::from(addr.sin6_addr.u.Byte)))
                        }
                        _ => None,
                    }
                };
                if let Some(address) = address {
                    result.push(InterfaceAddress {
                        name: name.clone(),
                        address,
                        internal: current.IfType == IF_TYPE_SOFTWARE_LOOPBACK,
                        virtual_adapter,
                    });
                }
            }
            unicast = entry.Next;
        }
        adapter = current.Next;
    }
    result
}

#[cfg(not(any(unix, windows)))]
fn interfaces() -> Vec<InterfaceAddress> {
    vec![]
}

/// Resolve reachable private addresses. Cloud VM private networks are excluded
/// because their addresses ordinarily cannot be reached from a client's LAN.
pub async fn resolve(host: &str, port: u16, private_network_only: bool) -> Vec<Value> {
    let on_cloud_vm = if private_network_only {
        matches!(
            tokio::time::timeout(
                std::time::Duration::from_millis(300),
                tokio::net::TcpStream::connect("169.254.169.254:80")
            )
            .await,
            Ok(Ok(_))
        )
    } else {
        false
    };
    bound_endpoints(host, port, &interfaces(), on_cloud_vm)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(name: &str, address: &str, internal: bool) -> InterfaceAddress {
        InterfaceAddress {
            name: name.into(),
            address: address.parse().unwrap(),
            internal,
            virtual_adapter: false,
        }
    }

    #[test]
    fn virtual_interface_filter_matches_server_bridge_rule_without_panicking() {
        for name in [
            "docker0",
            "br-123",
            "vethabc",
            "bridge100",
            "bridge100-extra",
        ] {
            assert!(virtual_interface(name), "{name}");
        }
        for name in ["br0", "vmbr0", "bridge000", "bridge099", "bridge1é"] {
            assert!(!virtual_interface(name), "{name}");
        }
    }

    #[test]
    fn reports_private_real_interfaces_and_tailnet_only_on_cloud() {
        let interfaces = [
            entry("lo", "127.0.0.1", true),
            entry("eth0", "192.168.1.2", false),
            entry("docker0", "172.17.0.1", false),
            entry("utun1", "fd7a:115c:a1e0::1", false),
            entry("utun1", "100.65.1.2", false),
            entry("eth1", "8.8.8.8", false),
        ];
        let result = bound_endpoints("0.0.0.0", 3773, &interfaces, false);
        assert_eq!(
            result,
            vec![
                json!({"kind":"lan","httpBaseUrl":"http://192.168.1.2:3773/"}),
                json!({"kind":"tailnet","httpBaseUrl":"http://100.65.1.2:3773/"})
            ]
        );
        assert_eq!(
            bound_endpoints("0.0.0.0", 3773, &interfaces, true),
            vec![result[1].clone()]
        );
        assert!(bound_endpoints("127.0.0.1", 3773, &interfaces, false).is_empty());
        assert!(bound_endpoints("lan.example", 3773, &interfaces, false).is_empty());
        assert!(bound_endpoints("169.254.1.1", 3773, &interfaces, false).is_empty());
        assert_eq!(
            bound_endpoints("192.168.1.2", 3773, &interfaces, false),
            vec![result[0].clone()]
        );
    }
}

/// Resolve the Serve URL only when it presents this server's environment descriptor.
/// The overall deadline includes both the CLI invocation and the HTTPS request.
pub async fn discover_tailscale(port: u16, environment_id: &str) -> Option<Value> {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let cli = if cfg!(windows) {
            "tailscale.exe"
        } else {
            "tailscale"
        };
        let output = tokio::process::Command::new(cli)
            .args(["status", "--json"])
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .await
            .ok()?;
        if !output.status.success() || output.stdout.len() > 1024 * 1024 {
            return None;
        }
        let status: Value = serde_json::from_slice(&output.stdout).ok()?;
        let base = tailscale_base_url(&status, port)?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok()?;
        if probe_environment(&client, &base, environment_id).await {
            Some(json!({"kind":"tailnet", "httpBaseUrl":base.as_str()}))
        } else {
            None
        }
    })
    .await
    .ok()
    .flatten()
}

fn tailscale_base_url(status: &Value, port: u16) -> Option<url::Url> {
    let name = status["Self"]["DNSName"]
        .as_str()?
        .trim()
        .trim_end_matches('.');
    // Reject URL syntax, IP literals and malformed labels from the local CLI output.
    if name.is_empty()
        || name.len() > 253
        || name.parse::<IpAddr>().is_ok()
        || !name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
    {
        return None;
    }
    let mut url = url::Url::parse(&format!("https://{name}/")).ok()?;
    if port != 443 {
        url.set_port(Some(port)).ok()?;
    }
    Some(url)
}

async fn probe_environment(
    client: &reqwest::Client,
    base: &url::Url,
    environment_id: &str,
) -> bool {
    let Ok(url) = base.join("/.well-known/t3/environment") else {
        return false;
    };
    let Ok(mut response) = client.get(url).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 64 * 1024 => {
                body.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return false,
        }
    }
    let Ok(descriptor) = serde_json::from_slice::<Value>(&body) else {
        return false;
    };
    descriptor["environmentId"].as_str() == Some(environment_id)
        && descriptor["label"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
        && descriptor["serverVersion"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
        && matches!(
            descriptor["platform"]["os"].as_str(),
            Some("darwin" | "linux" | "windows" | "unknown")
        )
        && matches!(
            descriptor["platform"]["arch"].as_str(),
            Some("arm64" | "x64" | "other")
        )
        && descriptor["capabilities"].is_object()
}

#[cfg(test)]
mod tailscale_tests {
    use super::*;
    #[test]
    fn validates_name_and_formats_serve_port() {
        let status = json!({"Self":{"DNSName":" host.example.ts.net. "}});
        assert_eq!(
            tailscale_base_url(&status, 443).unwrap().as_str(),
            "https://host.example.ts.net/"
        );
        assert_eq!(
            tailscale_base_url(&status, 8443).unwrap().as_str(),
            "https://host.example.ts.net:8443/"
        );
        for name in [
            "",
            "evil.example/path",
            "user@host",
            "127.0.0.1",
            "bad..name",
            "-bad.example",
        ] {
            assert!(
                tailscale_base_url(&json!({"Self":{"DNSName":name}}), 443).is_none(),
                "{name}"
            );
        }
    }
    #[tokio::test]
    async fn probe_requires_success_and_matching_complete_descriptor() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        async fn serve(body: &'static str, status: &'static str) -> url::Url {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                let n = stream.read(&mut request).await.unwrap();
                assert!(String::from_utf8_lossy(&request[..n])
                    .starts_with("GET /.well-known/t3/environment "));
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            url::Url::parse(&format!("http://{address}/")).unwrap()
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let good = r#"{"environmentId":"ours","label":"T3","serverVersion":"1","platform":{"os":"linux","arch":"arm64"},"capabilities":{}}"#;
        assert!(probe_environment(&client, &serve(good, "200 OK").await, "ours").await);
        assert!(!probe_environment(&client, &serve(good, "200 OK").await, "other").await);
        assert!(!probe_environment(&client, &serve(good, "404 Not Found").await, "ours").await);
        assert!(
            !probe_environment(
                &client,
                &serve(r#"{"environmentId":"ours"}"#, "200 OK").await,
                "ours"
            )
            .await
        );
    }
}
