//! Private IPC foundation for managed Codex token commands.
//!
//! The resolver must validate the requested profile while holding the same
//! credential-store lock used for access and refresh. A session runtime must
//! not enable this broker until it can make that guarantee.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

const REQUEST_BYTES: usize = 1024;
const RESPONSE_BYTES: usize = 64 * 1024;
const IDLE: Duration = Duration::from_secs(5);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(80);

#[derive(Debug)]
pub struct BrokerError;
impl From<()> for BrokerError {
    fn from(_: ()) -> Self {
        Self
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub instance_id: String,
    pub environment_id: String,
    pub profile_key: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    token: String,
}
impl Request {
    fn valid(&self) -> bool {
        self.version == 1
            && !self.instance_id.is_empty()
            && !self.environment_id.is_empty()
            && self.profile_key.len() == 64
            && self
                .profile_key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}
/// Matches upstream's SHA-256 of JSON.stringify([clientId, subject, idToken ?? null]).
pub fn profile_key(credentials: &crate::codex_credential_store::Credentials) -> String {
    let bytes = serde_json::to_vec(&(
        credentials.client_id.as_str(),
        credentials.subject.as_str(),
        credentials.id_token.as_deref(),
    ))
    .expect("strings serialize");
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::{Path, PathBuf},
    };
    use tokio::{
        io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
        net::{UnixListener, UnixStream},
        sync::{oneshot, Semaphore},
        task::JoinHandle,
    };

    pub type Resolver =
        Arc<dyn Fn(Request) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> + Send + Sync>;

    async fn read_frame<R: AsyncRead + Unpin>(
        reader: &mut R,
        max: usize,
        duration: Duration,
    ) -> Result<Vec<u8>, ()> {
        tokio::time::timeout(duration, async {
            let mut data = Vec::new();
            let mut buf = [0u8; 1024];
            loop {
                let n = reader.read(&mut buf).await.map_err(|_| ())?;
                if n == 0 || data.len().saturating_add(n) > max {
                    return Err(());
                }
                data.extend_from_slice(&buf[..n]);
                if let Some(end) = data.iter().position(|b| *b == b'\n') {
                    if end != data.len() - 1 {
                        return Err(());
                    }
                    data.pop();
                    return Ok(data);
                }
            }
        })
        .await
        .map_err(|_| ())?
    }
    fn trusted_parent(path: &Path) -> Result<PathBuf, ()> {
        let real = std::fs::canonicalize(path).map_err(|_| ())?;
        let m = std::fs::symlink_metadata(&real).map_err(|_| ())?;
        let uid = unsafe { libc::geteuid() };
        if !m.is_dir()
            || !((m.uid() == uid && m.mode() & 0o022 == 0)
                || (m.uid() == 0 && (m.mode() & 0o022 == 0 || m.mode() & 0o1000 != 0)))
        {
            return Err(());
        }
        Ok(real)
    }
    struct Directory {
        path: PathBuf,
        dev: u64,
        ino: u64,
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            if let Ok(m) = std::fs::symlink_metadata(&self.path) {
                if m.is_dir() && m.dev() == self.dev && m.ino() == self.ino {
                    let _ = std::fs::remove_file(self.path.join("s"));
                    let _ = std::fs::remove_dir(&self.path);
                }
            }
        }
    }
    fn directory(parent: &Path) -> Result<Directory, ()> {
        let parent = trusted_parent(parent)?;
        let path = parent.join(format!("t3-token-{}", uuid::Uuid::new_v4().simple()));
        if path.join("s").as_os_str().as_encoded_bytes().len() > 100 {
            return Err(());
        }
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|_| ())?;
        let m = std::fs::symlink_metadata(&path).map_err(|_| ())?;
        if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o777 != 0o700 {
            let _ = std::fs::remove_dir(&path);
            return Err(());
        }
        Ok(Directory {
            path,
            dev: m.dev(),
            ino: m.ino(),
        })
    }
    /// Owns the listener. `shutdown` stops acceptance and drains active jobs.
    pub struct Broker {
        endpoint: PathBuf,
        stop: Option<oneshot::Sender<()>>,
        task: Option<JoinHandle<()>>,
    }
    impl Broker {
        pub fn start(environment_id: String, resolver: Resolver) -> Result<Self, BrokerError> {
            if environment_id.is_empty() {
                return Err(BrokerError);
            }
            let dir = directory(&std::env::temp_dir()).or_else(|_| directory(Path::new("/tmp")))?;
            let endpoint = dir.path.join("s");
            let listener = UnixListener::bind(&endpoint).map_err(|_| ())?;
            std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| ())?;
            let (stop, mut stopped) = oneshot::channel();
            let task = tokio::spawn(async move {
                let _dir = dir;
                let connections = Arc::new(Semaphore::new(32));
                let jobs = Arc::new(Semaphore::new(16));
                let mut tasks = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        _ = &mut stopped => break,
                        Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
                        accepted = listener.accept() => {
                            let Ok((mut socket, _)) = accepted else { break; };
                            let Ok(connection) = connections.clone().try_acquire_owned() else { continue; };
                            let jobs = jobs.clone(); let resolver = resolver.clone(); let environment_id = environment_id.clone();
                            tasks.spawn(async move {
                                let _connection = connection;
                                let Ok(frame) = read_frame(&mut socket, REQUEST_BYTES, IDLE).await else { return; };
                                let Ok(request) = serde_json::from_slice::<Request>(&frame) else { return; };
                                if !request.valid() || request.environment_id != environment_id { return; }
                                let Ok(_job) = jobs.try_acquire_owned() else { return; };
                                // Do not interrupt an admitted rotation: the resolver owns its deadline
                                // and must commit any started refresh before returning.
                                let Some(token) = resolver(request).await else { return; };
                                if token.is_empty() { return; }
                                let Ok(mut response) = serde_json::to_vec(&Response { token }) else { return; };
                                response.push(b'\n');
                                if response.len() > RESPONSE_BYTES { return; }
                                let _ = tokio::time::timeout(IDLE, socket.write_all(&response)).await;
                            });
                        }
                    }
                }
                drop(listener);
                while tasks.join_next().await.is_some() {}
            });
            Ok(Self {
                endpoint,
                stop: Some(stop),
                task: Some(task),
            })
        }
        pub fn endpoint(&self) -> &Path {
            &self.endpoint
        }
        pub async fn shutdown(mut self) {
            if let Some(stop) = self.stop.take() {
                let _ = stop.send(());
            }
            if let Some(task) = self.task.take() {
                let _ = task.await;
            }
        }
    }
    impl Drop for Broker {
        fn drop(&mut self) {
            if let Some(stop) = self.stop.take() {
                let _ = stop.send(());
            }
        }
    }

    pub async fn request_token(args: &[String]) -> Result<String, ()> {
        if args.len() != 4 || args[0].is_empty() {
            return Err(());
        }
        let request = Request {
            version: 1,
            instance_id: args[1].clone(),
            environment_id: args[2].clone(),
            profile_key: args[3].clone(),
        };
        if !request.valid() {
            return Err(());
        }
        tokio::time::timeout(COMMAND_TIMEOUT, async {
            let mut stream = UnixStream::connect(&args[0]).await.map_err(|_| ())?;
            let mut bytes = serde_json::to_vec(&request).map_err(|_| ())?;
            bytes.push(b'\n');
            if bytes.len() > REQUEST_BYTES {
                return Err(());
            }
            stream.write_all(&bytes).await.map_err(|_| ())?;
            let frame = read_frame(&mut stream, RESPONSE_BYTES, COMMAND_TIMEOUT).await?;
            let response: Response = serde_json::from_slice(&frame).map_err(|_| ())?;
            if response.token.is_empty() {
                return Err(());
            }
            Ok(response.token)
        })
        .await
        .map_err(|_| ())?
    }
}
#[cfg(unix)]
pub use unix::{request_token, Broker, Resolver};
#[cfg(not(unix))]
pub async fn request_token(_: &[String]) -> Result<String, ()> {
    Err(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn profile_key_matches_upstream_json_digest() {
        let credentials = crate::codex_credential_store::Credentials {
            client_id: "client".into(),
            access_token: "secret".into(),
            refresh_token: None,
            expires_at: 0,
            earliest_refresh_at: None,
            scopes: vec![],
            subject: "subject".into(),
            email: None,
            id_token: None,
            issuer: None,
        };
        assert_eq!(
            profile_key(&credentials),
            "d479b062b805fbf5f7308ea4e10beb6eaa5ca274796bc44672c24076d00c3ddc"
        );
    }
    #[tokio::test]
    async fn private_broker_serves_only_matching_environment_and_profile() {
        use std::os::unix::fs::PermissionsExt;
        let key = "a".repeat(64);
        let expected = key.clone();
        let resolver: Resolver = Arc::new(move |req| {
            let expected = expected.clone();
            Box::pin(async move {
                (req.instance_id == "codex" && req.profile_key == expected)
                    .then(|| "mock-token".into())
            })
        });
        let broker = Broker::start("environment".into(), resolver).unwrap();
        let endpoint = broker.endpoint().to_str().unwrap().to_owned();
        assert_eq!(
            std::fs::metadata(broker.endpoint())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(broker.endpoint().parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let mut args = vec![endpoint.clone(), "codex".into(), "environment".into(), key];
        assert_eq!(request_token(&args).await.unwrap(), "mock-token");
        args[2] = "other".into();
        assert!(request_token(&args).await.is_err());
        args[2] = "environment".into();
        args[3] = "b".repeat(64);
        assert!(request_token(&args).await.is_err());
        broker.shutdown().await;
        assert!(!std::path::Path::new(&endpoint).exists());
    }
}
