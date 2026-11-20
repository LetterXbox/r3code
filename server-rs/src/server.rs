//! Composition of the currently implemented HTTP, authentication and RPC services.
use crate::{
    application::Application,
    auth,
    auth_http::AuthHttpState,
    config::{Mode, ResolvedConfig},
    database,
    effect_worker::{EffectWorker, RuntimeExecutor, Signals},
    event_bus::EventBus,
    http_server, outbox, runtime_bootstrap,
    runtime_http::{self, StartupReadiness, StartupStatus},
    runtime_state::{self, ServerRuntimeState, ServerRuntimeStateInput},
    startup_access::PrivateNetworkListener,
    static_client::StaticClient,
};
use sha2::{Digest, Sha256};
use std::{
    io,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::net::TcpListener;
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
};

/// Start the platform URL handler without recording the one-time pairing URL.
fn open_browser(target: &str) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    let mut command = {
        use base64::Engine;
        let script = format!(
            "$ProgressPreference = 'SilentlyContinue'; Start '{}'",
            target.replace('\'', "''")
        );
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &base64::engine::general_purpose::STANDARD.encode(bytes),
        ]);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let mut command = std::process::Command::new(if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        });
        command.arg(target);
        command
    };
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env_remove("ELECTRON_RUN_AS_NODE")
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Start the implemented server surface and keep serving until shutdown.
/// Caller holds the ownership lock for the entire lifetime of this future.
pub async fn serve(
    config: ResolvedConfig,
    service_managed: bool,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<(), Box<dyn std::error::Error>> {
    crate::managed_policy::check_platform_policy()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    crate::managed_policy::load(&crate::managed_policy::system_path())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    crate::managed_policy::initialize_runtime()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let loopback = match config.host.as_deref() {
        None => Some("127.0.0.1".to_owned()),
        Some(host) => {
            let normalized = host
                .trim_matches(['[', ']'])
                .trim_end_matches('.')
                .to_ascii_lowercase();
            if normalized == "localhost" {
                Some("127.0.0.1".to_owned())
            } else if normalized
                .parse::<std::net::Ipv4Addr>()
                .is_ok_and(|ip| ip.is_loopback())
                || normalized == "::1"
            {
                Some(normalized)
            } else {
                None
            }
        }
    };
    let remote = loopback.is_none();
    let client_mode = if remote {
        "remote"
    } else if config.mode == Mode::Desktop {
        "desktop"
    } else {
        "local-browser"
    };
    crate::managed_policy::check_client_mode(client_mode)
        .map_err(|e| io::Error::new(io::ErrorKind::PermissionDenied, e))?;
    let remote_denial = crate::managed_policy::check_client_mode("remote").err();
    let remote_clients_allowed = remote_denial.is_none();
    if !remote_clients_allowed && config.tailscale_serve {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "{}, so Tailscale Serve cannot be turned on.",
                remote_denial
                    .as_deref()
                    .unwrap_or("Managed policy does not allow remote clients")
                    .trim_end_matches('.')
            ),
        )
        .into());
    }
    let webhook_policy_block = crate::managed_policy::webhook_denial()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let mut persistence = runtime_bootstrap::initialize_persistence(&config.paths)?;
    let host = if remote_clients_allowed {
        config.host.as_deref().unwrap_or("127.0.0.1")
    } else {
        loopback.as_deref().unwrap_or("127.0.0.1")
    };
    let listener = if let Some(port) = config.port {
        TcpListener::bind((host, port)).await?
    } else {
        let mut port = 3773;
        loop {
            match TcpListener::bind((host, port)).await {
                Ok(listener) => break listener,
                Err(error) if error.kind() == io::ErrorKind::AddrInUse && port < u16::MAX => {
                    port += 1
                }
                Err(error) => return Err(error.into()),
            }
        }
    };
    let address = listener.local_addr()?;
    let port = address.port();
    let tailscale_host = if address.ip().is_unspecified() {
        if address.is_ipv4() {
            "127.0.0.1".to_string()
        } else {
            "::1".to_string()
        }
    } else {
        address.ip().to_string()
    };
    if !remote_clients_allowed {
        crate::tailscale_serve::enforce_local_only(&tailscale_host, port)
            .await
            .map_err(io::Error::other)?;
    }
    let endpoint_host = config
        .host
        .clone()
        .unwrap_or_else(|| address.ip().to_string());
    let private_network_only = config.private_network_only;
    let direct_endpoints = tokio::spawn(async move {
        crate::direct_endpoints::resolve(&endpoint_host, port, private_network_only).await
    });
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
    let now_iso: String = persistence.db.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1 / 1000.0, 'unixepoch')",
        [now],
        |r| r.get(0),
    )?;
    let connect_allowed = crate::managed_policy::allows_connect().map_err(io::Error::other)?;
    if !connect_allowed {
        crate::managed_policy::unlink_cloud_state(&config.paths.secrets_dir)?;
    }
    auth::revoke_disallowed_pairings(
        &mut persistence.db,
        &now_iso,
        remote_clients_allowed,
        connect_allowed,
    )?;
    // Recover durable work before a worker can claim anything in this process.
    outbox::reconcile_after_process_loss(&persistence.db, &now_iso)?;
    let pairing = if config.mode == Mode::Web {
        Some(auth::issue_startup_pairing_credential(
            &mut persistence.db,
            now,
            &now_iso,
            config.dev_url.is_some(),
        )?)
    } else {
        None
    };
    let hash = if remote && config.dev_url.is_none() {
        Sha256::digest(persistence.environment_id.as_bytes())
    } else {
        Sha256::digest(persistence.signing_key)
    };
    let suffix: String = hash[..6].iter().map(|b| format!("{b:02x}")).collect();
    let cookie = if config.mode == Mode::Desktop {
        format!("t3_session_{port}")
    } else if remote && config.dev_url.is_none() {
        format!("t3_session_{suffix}")
    } else {
        format!("t3_session_{port}_{suffix}")
    };
    let policy = if remote {
        "remote-reachable"
    } else if config.mode == Mode::Desktop {
        "desktop-managed-local"
    } else {
        "loopback-browser"
    };
    let bootstrap = if config.mode == Mode::Desktop {
        if remote {
            vec!["desktop-bootstrap", "one-time-token"]
        } else {
            vec!["desktop-bootstrap"]
        }
    } else {
        vec!["one-time-token"]
    };
    let descriptor = serde_json::json!({"policy":policy,"bootstrapMethods":bootstrap,"sessionMethods":["browser-session-cookie","bearer-access-token","dpop-access-token"],"sessionCookieName":cookie,"serverUpdateScope":"environment:maintain"});
    let owner_id = uuid::Uuid::new_v4().to_string();
    let state = ServerRuntimeState::new(ServerRuntimeStateInput {
        owner_id: owner_id.clone(),
        host: config.host.clone(),
        private_network_only: config.private_network_only,
        port,
        dev_url: config.dev_url.clone(),
        service_managed,
        server_version: env!("CARGO_PKG_VERSION").into(),
        started_at: now_iso.clone(),
    });
    let target = config.dev_url.as_deref().unwrap_or(&state.origin);
    let pairing_url = match pairing {
        Some(pairing) => auth::startup_pairing_url(target, &pairing.credential)?,
        None => target.to_owned(),
    };
    let origin = state.origin.clone();
    let mut origins = vec![origin];
    if let Some(dev_url) = &config.dev_url {
        if let Ok(url) = url::Url::parse(dev_url) {
            origins.push(url.origin().ascii_serialization());
        }
        if let Ok(extra) = std::env::var("T3CODE_DEV_ALLOWED_ORIGINS") {
            origins.extend(
                extra
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            );
        }
    }
    let cors = {
        use axum::http::{header, HeaderName, HeaderValue, Method};
        let base = CorsLayer::new()
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers([
                header::AUTHORIZATION,
                HeaderName::from_static("b3"),
                HeaderName::from_static("traceparent"),
                header::CONTENT_TYPE,
                HeaderName::from_static("dpop"),
                HeaderName::from_static("x-t3-orchestration-protocol"),
            ])
            .max_age(std::time::Duration::from_secs(600));
        if config.dev_url.is_some() {
            let allowed: Vec<HeaderValue> = origins
                .iter()
                .skip(1)
                .map(String::as_str)
                .chain(["t3code://app", "t3code-dev://app"])
                .filter_map(|s| HeaderValue::from_str(s).ok())
                .collect();
            base.allow_origin(allowed).allow_credentials(true)
        } else {
            base.allow_origin(Any)
        }
    };
    let auth = Arc::new(AuthHttpState {
        replay_dir: config.paths.secrets_dir.clone(),
        environment_descriptor: std::sync::OnceLock::new(),
        cloud_action_lock: tokio::sync::Mutex::new(()),
        cloud_generation: std::sync::atomic::AtomicU64::new(0),
        cloud_connector: crate::cloud_connector::Connector::default(),
        listen_address: std::sync::OnceLock::new(),
        lifecycle: Default::default(),
        db: Mutex::new(persistence.db),
        signing_key: persistence.signing_key,
        descriptor,
        trusted_origins: origins,
        accept_legacy_cookie: true,
        desktop_bootstrap: if config.mode == Mode::Desktop
            && config.desktop_bootstrap_token.is_some()
        {
            Some(auth::DesktopBootstrap::new(
                config.desktop_bootstrap_secret.clone(),
                config.desktop_bootstrap_token.clone(),
                now,
            ))
        } else {
            None
        },
    });
    let _ = auth.listen_address.set(address);
    let replay_dir = auth.replay_dir.clone();
    let replay_pruner = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            if let Err(error) =
                crate::dpop::prune_replay_markers(&replay_dir, std::time::SystemTime::now())
            {
                eprintln!("Warning: could not prune DPoP replay markers: {error}");
            }
        }
    });
    let bus = EventBus::new(database::open_writer(&config.paths.db_path)?, 256);
    let pending_legacy =
        bus.commit(|tx| Ok((crate::legacy_shells::pending_thread_count(tx)?, vec![])))?;
    let (legacy_lifecycle, legacy_lifecycle_rx) = tokio::sync::watch::channel(
        if pending_legacy > 0 {
            Some(
                serde_json::json!({"version":1,"sequence":2,"type":"legacyThreadMigration","payload":{"status":"running","totalThreadCount":pending_legacy}}),
            )
        } else {
            None
        },
    );
    crate::legacy_shells::reconcile_shells(&bus)?;
    let recovery_settings =
        crate::settings::Settings::new(config.paths.settings_path.clone()).snapshot();
    crate::runtime_recovery::recover_with_settings(&bus, &now_iso, &recovery_settings)?;
    let signals = Arc::new(Signals::default());
    bus.set_effect_signals(signals.clone());
    let sessions = Arc::new(crate::provider::session_registry::SessionRegistry::default());
    let terminals = Arc::new(crate::terminal::TerminalManager::with_logs_dir(
        config.paths.terminal_logs_dir.clone(),
    )?);
    let executor = RuntimeExecutor {
        terminals: terminals.clone(),
        bus: bus.clone(),
        worktrees_dir: config.paths.worktrees_dir.clone(),
        settings_path: config.paths.settings_path.clone(),
        provider: {
            let mut provider =
                crate::provider::executor::CodexTurnExecutor::new(bus.clone(), sessions.clone());
            provider.attachments_dir = config.paths.attachments_dir.clone();
            provider.settings_path = Some(config.paths.settings_path.clone());
            provider.mcp_endpoint = Some(format!("{}/mcp", state.origin));
            #[cfg(unix)]
            {
                provider.managed =
                    Some(Arc::new(crate::codex_managed_runtime::RuntimeManager::new(
                        config.paths.secrets_dir.clone(),
                        persistence.environment_id.clone(),
                        std::env::current_exe()?,
                        config.paths.state_dir.join("managed-codex-homes"),
                        config.paths.base_dir.join("tools/codex"),
                    )));
            }
            provider
        },
    };
    let worker = EffectWorker::new(
        Arc::new(Mutex::new(database::open_writer(&config.paths.db_path)?)),
        signals,
        Arc::new(executor),
        owner_id.clone(),
        5,
    )
    .with_supported_types(&[
        "provider-turn.start",
        "provider-runtime.continue",
        "provider-session.detach",
        "terminal.cleanup",
        "scheduled-tasks.cleanup",
        "preview.cleanup",
        "attachment.cleanup",
        "provider-turn.interrupt",
        "provider-turn.steer",
        "provider-turn.restart",
        "checkpoint.capture",
        "provider-thread.rollback",
        "runtime-request.respond",
    ]);
    let worker_task = tokio::spawn(async move {
        worker
            .run_daemon(4, std::time::Duration::from_secs(1))
            .await
    });
    let app = Arc::new(
        Application::new(
            auth.clone(),
            persistence.environment_id.clone(),
            std::env::var("T3CODE_ENVIRONMENT_LABEL")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "T3 Code".to_owned()),
        )
        .with_webhook_policy(webhook_policy_block.clone())
        .with_runtime_paths(&std::env::current_dir()?, &config.paths)
        .with_direct_endpoints(direct_endpoints.await.unwrap_or_default())
        .with_tailscale_endpoint(
            (config.tailscale_serve && remote_clients_allowed).then_some(config.tailscale_port),
        )
        .with_event_bus(bus.clone())
        .with_migration_lifecycle(legacy_lifecycle_rx)
        .with_terminal_manager(terminals)
        .with_session_registry(sessions.clone()),
    );
    if connect_allowed {
        let weak = Arc::downgrade(&auth);
        tokio::spawn(async move {
            crate::cloud_connector::restore_and_register(weak, address).await;
        });
    }
    app.resource_telemetry_handle().set_mode(config.mode);
    if let Some(fd) = config.desktop_telemetry_fd {
        app.background_activity_handle()
            .start_desktop_telemetry(fd, sessions.clone());
    }
    if let Some(fd) = config.desktop_telemetry_control_fd {
        crate::background_activity::start_desktop_control(fd, app.settings_handle());
    }
    let trace_writer = app.trace_writer_handle();
    let storage_cleanup_task = app.storage_cleanup_handle().start();
    let database_storage_task = app.database_storage_handle().start();
    let delegated_settings = app.settings_handle();
    let (keep_awake_shutdown, keep_awake_stopping) = tokio::sync::oneshot::channel();
    let keep_awake_task = tokio::spawn(crate::keep_awake::run(
        bus.clone(),
        delegated_settings.clone(),
        keep_awake_stopping,
    ));
    let mcp_settings = delegated_settings.clone();
    let mcp_provider_cache = app.provider_cache_handle();
    let cache_to_invalidate = mcp_provider_cache.clone();
    let mut provider_settings_changes = delegated_settings.subscribe();
    let provider_cache_task = tokio::spawn(async move {
        while let Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) =
            provider_settings_changes.recv().await
        {
            *cache_to_invalidate
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
        }
    });
    let delegated_sessions = sessions.clone();
    let scheduler_sessions = sessions.clone();
    let readiness = StartupReadiness::default();
    let static_dir = if config.dev_url.is_some() {
        None
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().and_then(crate::runtime::resolve_static_dir))
    };
    let static_state = Arc::new(StaticClient::new(static_dir, config.dev_url.as_deref()));
    let upload_state = Arc::new(crate::attachment_http::UploadState {
        directory: config.paths.attachments_dir.clone(),
        signing_key: auth.signing_key,
    });
    let asset_state = Arc::new(crate::attachment_asset::AssetState {
        directory: config.paths.attachments_dir.clone(),
        state_directory: config.paths.state_dir.clone(),
        signing_key: auth.signing_key,
    });
    let voice_state = crate::voice_http::VoiceState {
        auth: auth.clone(),
        settings: app.settings_handle(),
        catalog: Arc::new(crate::voice_http::Catalog::default()),
        downloads: Arc::new(crate::speech_model_store::Downloads::new(
            &config.paths.state_dir,
        )),
    };
    let mut otlp = crate::otlp_http::ExportConfig::from_environment(&app.settings_handle().private_snapshot(), config.desktop_otlp_traces_url.as_deref());
    otlp.trace_writer = trace_writer.clone();
    let mcp_db = Arc::new(Mutex::new(database::open_writer(&config.paths.db_path)?));
    let oauth_state = Arc::new(crate::mcp_oauth_http::OAuthHttpState {
        oauth: crate::mcp_oauth::McpOAuth::new(auth.signing_key),
        db: mcp_db.clone(),
        signing_key: auth.signing_key,
        settings: mcp_settings.clone(),
        auth: Some(auth.clone()),
    });
    let signing_key = auth.signing_key;
    app.start_background_services();
    let router = http_server::router_with_auth_and_otlp(app, auth, otlp)
        .merge(crate::voice_http::router(voice_state))
        .merge(crate::mcp_oauth_http::router(oauth_state))
        .merge(crate::mcp_http::router(
            sessions,
            mcp_db,
            persistence.environment_id.clone(),
            bus.clone(),
            mcp_settings,
            mcp_provider_cache,
            config.paths.worktrees_dir.clone(),
            signing_key,
            true,
            config.paths.secrets_dir.clone(),
        ))
        .merge(crate::attachment_http::router(upload_state))
        .merge(crate::attachment_asset::router(asset_state))
        .merge(runtime_http::router(readiness.clone()))
        .fallback_service(axum::routing::get(crate::static_client::serve).with_state(static_state))
        .layer(CompressionLayer::new())
        .layer(cors);
    if let Err(error) = runtime_state::publish(&config.paths.server_runtime_state_path, &state) {
        eprintln!("Warning: could not publish server runtime state: {error}");
    }
    readiness.set(StartupStatus::Ready);
    bus.set_worktrees_dir(config.paths.worktrees_dir.clone());
    bus.set_secrets_dir(config.paths.secrets_dir.clone());
    let _ = crate::mcp_secret::cancel_orphaned(&bus);
    let _ = bus.with_autocommit(|db| {
        crate::secret_requests::cleanup_claimed(db, &config.paths.secrets_dir)
    });
    let sweep_dir = config.paths.secrets_dir.clone();
    let secret_sweeper = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            let _ = crate::secret_requests::sweep_expired(
                &sweep_dir,
                chrono::Utc::now().timestamp_millis(),
            );
        }
    });
    let scheduler_task = tokio::spawn(crate::scheduled_tasks::run_scheduler(
        bus.clone(),
        scheduler_sessions,
        webhook_policy_block.is_none(),
    ));
    let delegated_task = tokio::spawn(crate::delegated_worker::run(
        bus.clone(),
        delegated_settings,
        delegated_sessions,
    ));
    let _awareness_task = tokio::spawn(crate::agent_awareness_relay::run(
        bus.clone(),
        config.paths.secrets_dir.clone(),
        persistence.environment_id.clone(),
    ));
    let legacy_bus = bus.clone();
    let legacy_task = tokio::spawn(async move {
        if let Err(error) = crate::legacy_transcript::import_pending_transcripts(&legacy_bus).await
        {
            eprintln!("Warning: legacy transcript import stopped: {error}");
        }
        if pending_legacy > 0 {
            let _ = legacy_lifecycle.send(Some(serde_json::json!({"version":1,"sequence":4,"type":"legacyThreadMigration","payload":{"status":"complete","totalThreadCount":pending_legacy}})));
        }
    });
    println!("Server listening at {}", state.origin);
    if config.mode == Mode::Web {
        println!("Pairing URL: {pairing_url}");
    }
    if !config.no_browser && open_browser(&pairing_url).is_err() {
        eprintln!("Browser auto-open unavailable; open the pairing URL above.");
    }
    let tailscale_task = if config.tailscale_serve && remote_clients_allowed {
        crate::tailscale_serve::start(tailscale_host.clone(), port, config.tailscale_port).await
    } else {
        None
    };
    let scheduler_shutdown = bus.shutdown_flag();
    let ending = async move {
        shutdown.await;
        scheduler_shutdown.store(true, std::sync::atomic::Ordering::SeqCst);
        readiness.set(StartupStatus::ShuttingDown);
    };
    let result = if config.private_network_only {
        axum::serve(
            PrivateNetworkListener::new(listener),
            router.into_make_service_with_connect_info::<crate::auth_http::SocketPeer>(),
        )
        .with_graceful_shutdown(ending)
        .await
    } else {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<crate::auth_http::SocketPeer>(),
        )
        .with_graceful_shutdown(ending)
        .await
    };
    if let Some(writer) = trace_writer {
        if let Err(error) = writer.flush(std::time::Duration::from_secs(2)).await {
            eprintln!("Warning: could not flush local traces during shutdown: {error}");
        }
    }
    if let Some(task) = tailscale_task {
        task.abort();
        let _ = task.await;
        crate::tailscale_serve::stop(&tailscale_host, port, config.tailscale_port).await;
    }
    bus.shutdown_flag()
        .store(true, std::sync::atomic::Ordering::SeqCst);
    worker_task.abort();
    replay_pruner.abort();
    legacy_task.abort();
    delegated_task.abort();
    let _ = keep_awake_shutdown.send(());
    let _ = keep_awake_task.await;
    scheduler_task.abort();
    secret_sweeper.abort();
    provider_cache_task.abort();
    storage_cleanup_task.abort();
    database_storage_task.abort();
    let _ = worker_task.await;
    if let Err(error) =
        runtime_state::remove_if_owned(&config.paths.server_runtime_state_path, &owner_id)
    {
        eprintln!("Warning: could not remove server runtime state: {error}");
    }
    result.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{self, ConfigInput};
    use std::{
        io::{Read, Write},
        path::Path,
    };

    #[tokio::test]
    async fn composed_server_publishes_health_and_cleans_up() {
        let root = std::env::temp_dir().join(format!("t3-server-{}", uuid::Uuid::new_v4()));
        let flags = ConfigInput {
            base_dir: Some(root.to_string_lossy().into_owned()),
            no_browser: Some(true),
            ..Default::default()
        };
        let config = config::resolve(
            &flags,
            &ConfigInput::default(),
            &ConfigInput::default(),
            Path::new("/"),
            Path::new("/"),
            true,
            false,
        )
        .unwrap();
        config.paths.ensure_directories(&root).unwrap();
        let state_path = config.paths.server_runtime_state_path.clone();
        let trace_path = config.paths.server_trace_path.clone();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            serve(config, false, async {
                let _ = stopped.await;
            })
            .await
            .map_err(|e| e.to_string())
        });
        let state = loop {
            if let Ok(bytes) = std::fs::read(&state_path) {
                break serde_json::from_slice::<ServerRuntimeState>(&bytes).unwrap();
            }
            assert!(
                !server.is_finished(),
                "server failed before publishing state"
            );
            tokio::task::yield_now().await;
        };
        let (response, preflight, mcp) = tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", state.port)).unwrap();
            write!(
                stream,
                "GET /ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", state.port)).unwrap();
            write!(stream, "OPTIONS /ready HTTP/1.1\r\nHost: localhost\r\nOrigin: https://example.com\r\nAccess-Control-Request-Method: GET\r\nConnection: close\r\n\r\n").unwrap();
            let mut preflight = String::new();
            stream.read_to_string(&mut preflight).unwrap();
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", state.port)).unwrap();
            write!(stream, "POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            let mut mcp = String::new();
            stream.read_to_string(&mut mcp).unwrap();
            (response, preflight, mcp)
        })
        .await
        .unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(mcp.starts_with("HTTP/1.1 401"), "{mcp}");
        assert!(
            preflight
                .to_ascii_lowercase()
                .contains("access-control-allow-origin: *"),
            "{preflight}"
        );
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();
        assert!(!state_path.exists());
        let traces = std::fs::read_to_string(trace_path).unwrap();
        assert!(traces.contains("server.startup"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
