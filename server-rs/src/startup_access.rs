//! Private-network-only listener admission checks.
use std::{
    io,
    net::{Ipv4Addr, SocketAddr},
};
use tokio::net::{TcpListener, TcpStream};

/// TCP listener that closes connections unless both socket endpoints are in
/// the private IPv4 ranges accepted by the server's LAN policy.
pub struct PrivateNetworkListener {
    listener: TcpListener,
}

impl PrivateNetworkListener {
    pub fn new(listener: TcpListener) -> Self {
        Self { listener }
    }
}

impl axum::serve::Listener for PrivateNetworkListener {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.listener.accept().await {
                Ok((stream, remote)) => {
                    let local = stream.local_addr().ok();
                    if accepts_private_connection(
                        local
                            .as_ref()
                            .map(|address| address.ip().to_string())
                            .as_deref(),
                        Some(remote.ip().to_string()).as_deref(),
                    ) {
                        return (stream, remote);
                    }
                    // Dropping the stream closes the rejected TCP connection.
                }
                Err(error) => {
                    // axum's listener contract requires recovering from accept
                    // errors. Yield to avoid a tight loop on persistent errors.
                    let _ = error;
                    tokio::task::yield_now().await;
                }
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

/// Accept the exact IPv4 ranges supported by the original server, including
/// IPv4-mapped textual addresses. Native IPv6 and link-local IPv4 are excluded.
pub fn is_private_network_address(address: &str) -> bool {
    let address = if address
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("::ffff:"))
    {
        &address[7..]
    } else {
        address
    };
    let Ok(ip) = address.parse::<Ipv4Addr>() else {
        return false;
    };
    let [a, b, _, _] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 198 && (18..=19).contains(&b))
}

/// Both socket endpoints must be private; unknown endpoints fail closed.
pub fn accepts_private_connection(local: Option<&str>, remote: Option<&str>) -> bool {
    local.is_some_and(is_private_network_address) && remote.is_some_and(is_private_network_address)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_endpoints_must_be_private_ipv4() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.31.0.1",
            "192.168.0.1",
            "100.64.0.1",
            "::FFFF:100.127.1.1",
            "198.19.1.1",
        ] {
            assert!(is_private_network_address(ip), "{ip}");
        }
        for ip in [
            "::1",
            "fe80::1",
            "169.254.1.1",
            "8.8.8.8",
            "100.128.0.1",
            "172.32.0.1",
            "invalid",
            "ééééé",
        ] {
            assert!(!is_private_network_address(ip), "{ip}");
        }
        assert!(accepts_private_connection(
            Some("127.0.0.1"),
            Some("192.168.1.1")
        ));
        assert!(!accepts_private_connection(
            Some("192.168.1.1"),
            Some("8.8.8.8")
        ));
        assert!(!accepts_private_connection(None, Some("127.0.0.1")));
    }

    #[tokio::test]
    async fn private_listener_accepts_loopback_client() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut guarded = PrivateNetworkListener::new(listener);
        let client = TcpStream::connect(addr);
        let (client, accepted) = tokio::join!(client, axum::serve::Listener::accept(&mut guarded));
        let _client = client.unwrap();
        assert_eq!(accepted.1, _client.local_addr().unwrap());
    }
}
