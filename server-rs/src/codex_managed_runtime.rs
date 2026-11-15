//! Profile-bound managed Codex runtime foundation. The caller owns this object
//! for at least as long as any child launched with its token command.
#[cfg(unix)]
mod unix {
    use crate::{
        codex_credential_store::CredentialStore,
        codex_oauth::Discovery,
        codex_token_broker::{self, Broker, Resolver},
        provider::CodexLaunch,
    };
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
    };

    pub struct ManagedRuntime {
        broker: Broker,
        discovery: Discovery,
        secrets: PathBuf,
        environment_id: String,
        helper: PathBuf,
        home_root: PathBuf,
        shared_home: PathBuf,
    }
    impl std::fmt::Debug for ManagedRuntime {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("ManagedRuntime").finish_non_exhaustive()
        }
    }
    impl ManagedRuntime {
        /// Start the private listener before any credential refresh can occur.
        pub fn start(
            discovery: Discovery,
            secrets: PathBuf,
            environment_id: String,
            helper: PathBuf,
            home_root: PathBuf,
        ) -> Result<Self, &'static str> {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if !helper.is_absolute() || !home_root.is_absolute() {
                return Err("runtime");
            }
            // This executable receives a profile-bound token from the broker.
            // Refuse a symlink or a file writable by another user before opening
            // the listener; a caller must provide the server's own helper.
            let metadata = std::fs::symlink_metadata(&helper).map_err(|_| "runtime")?;
            if !metadata.is_file()
                || !matches!(metadata.uid(), 0) && metadata.uid() != unsafe { libc::geteuid() }
                || metadata.permissions().mode() & 0o022 != 0
                || metadata.permissions().mode() & 0o111 == 0
            {
                return Err("runtime");
            }
            let shared_home = crate::codex_shadow_home::shared_home().map_err(|_| "home")?;
            let broker_discovery = discovery.clone();
            let broker_secrets = secrets.clone();
            let resolver: Resolver = Arc::new(move |request| {
                let discovery = broker_discovery.clone();
                let secrets = broker_secrets.clone();
                Box::pin(async move {
                    let store = CredentialStore::new(&secrets, &request.instance_id).ok()?;
                    let now = chrono::Utc::now().timestamp_millis();
                    discovery
                        .access_for_profile(&store, now, Some(&request.profile_key))
                        .await
                        .ok()
                        .map(|c| c.access_token)
                })
            });
            let broker = Broker::start(environment_id.clone(), resolver).map_err(|_| "broker")?;
            Ok(Self {
                broker,
                discovery,
                secrets,
                environment_id,
                helper,
                home_root,
                shared_home,
            })
        }
        /// Build an isolated launch from a trusted managed executable. Never
        /// inherit caller-provided Codex arguments or provider settings here.
        pub async fn launch(
            self: &Arc<Self>,
            instance: &str,
            binary: &Path,
            shared_home: Option<&Path>,
            shadow_home: Option<&Path>,
        ) -> Result<CodexLaunch, &'static str> {
            use sha2::{Digest, Sha256};
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if instance.is_empty() || !binary.is_absolute() || !binary.is_file() {
                return Err("install");
            }
            let store = CredentialStore::new(&self.secrets, instance).map_err(|_| "storage")?;
            let credentials = self
                .discovery
                .access(&store, chrono::Utc::now().timestamp_millis())
                .await
                .map_err(|_| "auth")?;
            let profile = codex_token_broker::profile_key(&credentials);
            let hash = Sha256::digest(instance.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let home = shadow_home
                .map(Path::to_path_buf)
                .unwrap_or_else(|| self.home_root.join(hash));
            std::fs::create_dir_all(&self.home_root).map_err(|_| "home")?;
            if let Some(parent) = home.parent() {
                std::fs::create_dir_all(parent).map_err(|_| "home")?;
            }
            let shared = shared_home.unwrap_or(&self.shared_home);
            std::fs::create_dir_all(shared).map_err(|_| "home")?;
            // Reject overlapping homes before changing permissions on the shadow.
            let shared_canonical = std::fs::canonicalize(shared).map_err(|_| "home")?;
            if home.exists() {
                let home_canonical = std::fs::canonicalize(&home).map_err(|_| "home")?;
                if home_canonical.starts_with(&shared_canonical)
                    || shared_canonical.starts_with(&home_canonical)
                {
                    return Err("home");
                }
            }
            for path in [&self.home_root, &home] {
                match std::fs::create_dir(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err("home"),
                }
                let metadata = std::fs::symlink_metadata(path).map_err(|_| "home")?;
                if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
                    return Err("home");
                }
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                    .map_err(|_| "home")?;
            }
            crate::codex_shadow_home::materialize(shared, &home).map_err(|_| "home")?;
            let endpoint = self.broker.endpoint().to_str().ok_or("runtime")?;
            let helper = self.helper.to_str().ok_or("runtime")?;
            let command = serde_json::to_string(helper).map_err(|_| "runtime")?;
            let args = serde_json::to_string(&[
                "__managed-chatgpt-token",
                endpoint,
                instance,
                &self.environment_id,
                &profile,
            ])
            .map_err(|_| "runtime")?;
            let model = format!("model_providers.openai_token_sharing={{name=\"OpenAI Token Sharing\",base_url=\"https://api.openai.com/v1\",model_catalog_url=\"https://api.openai.com/v1/models\",wire_api=\"responses\",requires_openai_auth=false,supports_websockets=false,auth={{command={command},args={args},timeout_ms=80000,refresh_interval_ms=0}}}}");
            let mut launch = CodexLaunch {
                binary: Some(binary.to_path_buf()),
                home: Some(home),
                managed_runtime: Some(self.clone()),
                ..Default::default()
            };
            for value in [
                "model_provider=\"openai_token_sharing\"".to_owned(),
                model,
                "features.api_key_model_discovery=true".into(),
                "features.multi_agent=false".into(),
                "features.multi_agent_v2=false".into(),
            ] {
                launch.args.push("-c".into());
                launch.args.push(value);
            }
            launch.env_remove = [
                "ACCESS_TOKEN",
                "T3CODE_CODEX_LAUNCH_ARGS",
                "OPENAI_API_KEY",
                "OPENAI_BASE_URL",
            ]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
            Ok(launch)
        }
        pub async fn shutdown(self) {
            self.broker.shutdown().await;
        }
    }

    /// Lazily prepares the broker so normal server startup does not require
    /// network access or a managed installation.
    pub struct RuntimeManager {
        runtime: tokio::sync::OnceCell<Arc<ManagedRuntime>>,
        secrets: PathBuf,
        environment_id: String,
        helper: PathBuf,
        home_root: PathBuf,
        install_root: PathBuf,
        #[cfg(test)]
        test_asset: Option<crate::codex_release::ReleaseAsset>,
    }
    impl RuntimeManager {
        pub fn new(
            secrets: PathBuf,
            environment_id: String,
            helper: PathBuf,
            home_root: PathBuf,
            install_root: PathBuf,
        ) -> Self {
            Self {
                runtime: tokio::sync::OnceCell::new(),
                secrets,
                environment_id,
                helper,
                home_root,
                install_root,
                #[cfg(test)]
                test_asset: None,
            }
        }
        #[cfg(test)]
        pub(crate) fn with_fixture(
            mut self,
            discovery: Discovery,
            asset: crate::codex_release::ReleaseAsset,
        ) -> Self {
            let mut runtime = ManagedRuntime::start(
                discovery,
                self.secrets.clone(),
                self.environment_id.clone(),
                self.helper.clone(),
                self.home_root.clone(),
            )
            .unwrap();
            runtime.shared_home = self.home_root.parent().unwrap().join("mock-shared-codex");
            self.runtime = tokio::sync::OnceCell::new_with(Some(Arc::new(runtime)));
            self.test_asset = Some(asset);
            self
        }
        #[cfg(test)]
        pub async fn launch(&self, instance: &str) -> Result<CodexLaunch, String> {
            self.launch_with_home(instance, None, None).await
        }
        pub async fn launch_with_home(
            &self,
            instance: &str,
            shared_home: Option<&Path>,
            shadow_home: Option<&Path>,
        ) -> Result<CodexLaunch, String> {
            let runtime = self
                .runtime
                .get_or_try_init(|| async {
                    let discovery = Discovery::production().await.map_err(|_| {
                        "Could not prepare managed Codex authentication.".to_owned()
                    })?;
                    ManagedRuntime::start(
                        discovery,
                        self.secrets.clone(),
                        self.environment_id.clone(),
                        self.helper.clone(),
                        self.home_root.clone(),
                    )
                    .map(Arc::new)
                    .map_err(|_| "Could not prepare managed Codex runtime.".to_owned())
                })
                .await?;
            #[cfg(test)]
            let result = match self.test_asset {
                Some(asset) => {
                    crate::codex_release::acquire_fixture(&self.install_root, asset).await
                }
                None => crate::codex_release::acquire_installed(&self.install_root).await,
            };
            #[cfg(not(test))]
            let result = crate::codex_release::acquire_installed(&self.install_root).await;
            let lease =
                result.map_err(|_| "Set up managed Codex before starting a session.".to_owned())?;
            #[cfg(test)]
            let shared_home = if self.test_asset.is_some() {
                None
            } else {
                shared_home
            };
            let mut launch = runtime.launch(instance, lease.binary(), shared_home, shadow_home).await.map_err(|_| "Could not prepare managed Codex session. Check installation and authentication.".to_owned())?;
            launch.managed_install = Some(lease);
            Ok(launch)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::codex_credential_store::Credentials;
        use std::os::unix::fs::PermissionsExt;

        #[tokio::test]
        async fn launch_binds_broker_to_profile_and_mock_provider() {
            let root =
                std::env::temp_dir().join(format!("managed-runtime-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let binary = root.join("provider");
            let output = root.join("args");
            let helper = root.join("helper");
            let success = root.join("helper-success");
            std::fs::write(&helper, r##"#!/usr/bin/env python3
import sys, socket, json
endpoint, instance, environment, profile = sys.argv[2:]
s = socket.socket(socket.AF_UNIX)
s.connect(endpoint)
s.sendall((json.dumps({'version':1,'instanceId':instance,'environmentId':environment,'profileKey':profile})+'\n').encode())
data = b''
while not data.endswith(b'\n'):
    part = s.recv(65536)
    if not part: sys.exit(1)
    data += part
sys.stdout.write(json.loads(data)['token'])
"##).unwrap();
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
            let script = r##"#!/usr/bin/env python3
import sys, json, subprocess, time
config = next(arg for arg in sys.argv if arg.startswith('model_providers.openai_token_sharing='))
fragment = config.split('auth={command=', 1)[1]
command, end = json.JSONDecoder().raw_decode(fragment)
fragment = fragment[end:]
assert fragment.startswith(',args=')
args, _ = json.JSONDecoder().raw_decode(fragment[len(',args='):])
result = subprocess.run([command, *args], capture_output=True)
assert result.returncode == 0 and result.stdout == b'test-token'
open(OUTPUT, 'w').write('\n'.join(sys.argv[1:]))
open(SUCCESS, 'w').write('ok')
time.sleep(1)
"##
            .replace(
                "OUTPUT",
                &serde_json::to_string(&output.to_string_lossy()).unwrap(),
            )
            .replace(
                "SUCCESS",
                &serde_json::to_string(&success.to_string_lossy()).unwrap(),
            );
            std::fs::write(&binary, script).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let secrets = root.join("secrets");
            let store = CredentialStore::new(&secrets, "instance").unwrap();
            let mut credentials = Credentials {
                client_id: "client".into(),
                access_token: "test-token".into(),
                refresh_token: None,
                expires_at: chrono::Utc::now().timestamp_millis() + 300_000,
                earliest_refresh_at: None,
                scopes: vec!["chatgpt.tokens.use.direct".into()],
                subject: "subject".into(),
                email: None,
                id_token: Some("identity".into()),
                issuer: None,
            };
            store.save(credentials.clone()).await.unwrap();
            let mut runtime = ManagedRuntime::start(
                Discovery::test_discovery(),
                secrets,
                "environment".into(),
                helper,
                root.join("homes"),
            )
            .unwrap();
            runtime.shared_home = root.join("shared");
            std::fs::create_dir_all(&runtime.shared_home).unwrap();
            std::fs::write(runtime.shared_home.join("auth.json"), "shared-secret").unwrap();
            std::fs::write(runtime.shared_home.join("config.toml"), "shared-config").unwrap();
            let runtime = Arc::new(runtime);
            let launch = runtime
                .launch("instance", &binary, None, None)
                .await
                .unwrap();
            let home = launch.home.as_ref().unwrap();
            assert_eq!(
                std::fs::read_to_string(home.join("config.toml")).unwrap(),
                "shared-config"
            );
            assert!(!home.join("auth.json").exists());
            std::fs::write(home.join("sessions/continued.jsonl"), "session").unwrap();
            assert_eq!(
                std::fs::read_to_string(runtime.shared_home.join("sessions/continued.jsonl"))
                    .unwrap(),
                "session"
            );
            assert!(std::fs::symlink_metadata(home.join("state_5.sqlite"))
                .unwrap()
                .file_type()
                .is_symlink());
            let profile = codex_token_broker::profile_key(&credentials);
            let args = vec![
                runtime.broker.endpoint().to_str().unwrap().to_owned(),
                "instance".into(),
                "environment".into(),
                profile,
            ];
            assert_eq!(
                codex_token_broker::request_token(&args).await.unwrap(),
                "test-token"
            );
            let provider = crate::provider::CodexClient::spawn(launch).unwrap();
            // The process owns the runtime even after its creator releases it.
            drop(runtime);
            assert_eq!(
                codex_token_broker::request_token(&args).await.unwrap(),
                "test-token"
            );
            for _ in 0..100 {
                if success.exists() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(
                success.exists(),
                "mock provider could not obtain its token through the configured helper"
            );
            let native_args = std::fs::read_to_string(&output).unwrap();
            assert!(native_args.contains("model_provider=\"openai_token_sharing\""));
            assert!(native_args.contains("__managed-chatgpt-token"));
            assert!(!native_args.contains("test-token"));
            credentials.subject = "different-subject".into();
            credentials.client_id = "different-client".into();
            credentials.access_token = "different-token".into();
            store.save(credentials).await.unwrap();
            assert!(codex_token_broker::request_token(&args).await.is_err());
            drop(provider);
            for _ in 0..100 {
                if !std::path::Path::new(&args[0]).exists() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(!std::path::Path::new(&args[0]).exists());
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn launch_rejects_symlinked_instance_home() {
            let root = std::env::temp_dir().join(format!("managed-home-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let binary = root.join("provider");
            std::fs::write(&binary, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let secrets = root.join("secrets");
            CredentialStore::new(&secrets, "instance")
                .unwrap()
                .save(Credentials {
                    client_id: "client".into(),
                    access_token: "mock-token".into(),
                    refresh_token: None,
                    expires_at: chrono::Utc::now().timestamp_millis() + 300_000,
                    earliest_refresh_at: None,
                    scopes: vec!["chatgpt.tokens.use.direct".into()],
                    subject: "subject".into(),
                    email: None,
                    id_token: None,
                    issuer: None,
                })
                .await
                .unwrap();
            let homes = root.join("homes");
            std::fs::create_dir(&homes).unwrap();
            let target = root.join("untrusted-home");
            std::fs::create_dir(&target).unwrap();
            use sha2::{Digest, Sha256};
            let name = Sha256::digest(b"instance")
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            std::os::unix::fs::symlink(&target, homes.join(name)).unwrap();
            let runtime = Arc::new(
                ManagedRuntime::start(
                    Discovery::test_discovery(),
                    secrets,
                    "environment".into(),
                    binary.clone(),
                    homes,
                )
                .unwrap(),
            );
            assert!(matches!(
                runtime.launch("instance", &binary, None, None).await,
                Err("home")
            ));
            assert!(std::fs::read_dir(&target).unwrap().next().is_none());
            drop(runtime);
            std::fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn rejects_replaceable_helper() {
            let root =
                std::env::temp_dir().join(format!("managed-helper-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let helper = root.join("helper");
            std::fs::write(&helper, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o777)).unwrap();
            assert!(ManagedRuntime::start(
                Discovery::test_discovery(),
                root.join("secrets"),
                "environment".into(),
                helper.clone(),
                root.join("homes")
            )
            .is_err());
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
            let link = root.join("link");
            std::os::unix::fs::symlink(&helper, &link).unwrap();
            assert!(ManagedRuntime::start(
                Discovery::test_discovery(),
                root.join("secrets"),
                "environment".into(),
                link,
                root.join("homes")
            )
            .is_err());
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
#[cfg(unix)]
pub use unix::{ManagedRuntime, RuntimeManager};
