//! Concrete RPC application with scope checks and project command dispatch.
use crate::{
    auth::{AuthError, Principal},
    auth_http::{self, AuthHttpState},
    authorization,
    event_bus::EventBus,
    http_server::{BoxFuture, RpcApplication, RpcFailure},
    rpc::Request,
    thread_commands::{create_thread_with_import, CreateThread},
    transport::HttpRejection,
};
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

#[derive(Clone)]
pub struct Application {
    pub auth: Arc<AuthHttpState>,
    descriptor: Value,
    event_bus: Option<EventBus>,
    sessions: Arc<crate::provider::session_registry::SessionRegistry>,
    client_config: Value,
    settings: Arc<crate::settings::Settings>,
    storage_cleanup: Arc<crate::storage_cleanup::StorageCleanup>,
    background_activity: Arc<crate::background_activity::ClientActivity>,
    launch_gates: Arc<std::sync::Mutex<HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>>,
    clones: Arc<crate::project_clone_tracker::Tracker>,
    source_signins: Arc<crate::source_control_signin::SignIns>,
    device_status: Arc<crate::device_status::DeviceStatus>,
    preview_manager: Arc<crate::preview_manager::PreviewManager>,
    browser_pool: Arc<crate::preview_browser::BrowserPool>,
    database_storage: Arc<crate::database_storage::DatabaseStorage>,
    keybindings: Arc<crate::keybindings::Keybindings>,
    themes: Arc<crate::environment_theme::Themes>,
    provider_cache: Arc<std::sync::Mutex<Option<Vec<Value>>>>,
    managed_flows: Arc<crate::provider_auth::ManagedFlows>,
    cursor_auth: Arc<crate::provider::cursor_auth::CursorAuth>,
    installer: Arc<crate::provider_install::Installer>,
    repository_identities: Arc<crate::repository_identity::RepositoryIdentityCache>,
    pull_request_refreshes: Arc<crate::pull_request_refresh::Refreshes>,
    review_guide_runs: Arc<crate::pull_request_review_guide::Runs>,
    ready_at: String,
    migration_lifecycle: tokio::sync::watch::Receiver<Option<Value>>,
    attachments_dir: std::path::PathBuf,
    secrets_dir: std::path::PathBuf,
    trace_path: std::path::PathBuf,
    named_projects_root: std::path::PathBuf,
    review_guide_worktrees: std::path::PathBuf,
    trace_writer: Option<Arc<crate::trace_writer::TraceWriter>>,
    terminals: Arc<crate::terminal::TerminalManager>,
    resource_telemetry: Arc<crate::resource_telemetry::ResourceTelemetry>,
    triage: Arc<crate::triage::TriageService>,
    usage_service: crate::usage_service::UsageService,
    usage_limit_sources: crate::usage_limit_sources::UsageLimitSources,
    webhook_policy_block: Option<String>,
    tailscale_serve_port: Option<u16>,
}
impl Application {
    pub fn new(auth: Arc<AuthHttpState>, environment_id: String, label: String) -> Self {
        let os = match std::env::consts::OS {
            "linux" => "linux",
            "macos" => "darwin",
            "windows" => "windows",
            _ => "unknown",
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => "other",
        };
        let mut capabilities = serde_json::Map::new();
        for flag in [
            "repositoryIdentity",
            "connectionProbe",
            "attachmentUploads",
            "questionAttachments",
            "pullRequests",
            "pullRequestChecks",
            "linkedThreadRefreshes",
            "sideChats",
            "vcsBranchStatus",
            "storageCleanup",
            "storageCleanupRun",
            "databaseStorage",
            "otlpEndpointCheck",
            "secretSourceCheck",
            "worktreesDirectory",
            "threadSnooze",
            "threadForceStop",
            "environmentThemes",
            "threadPinning",
            "threadPinReorder",
            "threadActiveReorder",
            "threadAutoSettleOptOut",
            "commandOutputStreaming",
            "threadVisitedTracking",
            "threadPullRequests",
            "threadPullRequestWatch",
            "pullRequestStackActions",
            "threadPullRequestLinking",
            "threadStop",
            "projectOrganization",
            "ignoredFileListing",
            "ignoredFileSearch",
            "oneTimeSchedules",
            "freshContext",
            "scheduledTaskThreadModes",
            "npmReleaseLookup",
            "voiceTranscription",
            "cloudVoiceTranscription",
            "serverBrowser",
            "peerLinks",
            "mcpModeLimitHeader",
            "linkFence",
            "environmentIcon",
            "inlineMessageContext",
            "requiredWorktreeBootstrap",
            "mcpApprovalCodes",
            "mcpHostedApproval",
            "projectCloneTracking",
            "projectProviderInstanceOverrides",
            "projectSettingsOverrides",
            "projectWorktreeCleanup",
            "serverResolvedCommandContext",
            "settledWorktreeCleanup",
            "threadAutoSettlement",
            "threadAutoSettlementScope",
            "threadProjectFromScratch",
            "threadRestartContinuation",
            "threadSettlement",
            "threadTitleRegeneration",
            "triage",
            "shellOlderSettled",
            "shellThreadFamilies",
            "providerWorkspaceSnapshotsOnDemand",
            "modelCatalogRefresh",
            "usageLimitSources",
            "usageModelAliases",
            "usagePriceOverrides",
        ] {
            capabilities.insert(flag.to_owned(), Value::Bool(true));
        }
        if cfg!(not(target_os = "windows")) {
            capabilities.insert("localServerStop".to_owned(), Value::Bool(true));
        }
        capabilities.insert(
            "fileAttachments".to_owned(),
            json!({"maxUploadBytes": 50 * 1024 * 1024}),
        );
        let mut descriptor = json!({
            "environmentId": environment_id,
            "label": label,
            "platform": {"os": os, "arch": arch},
            "serverVersion": env!("CARGO_PKG_VERSION"),
            "orchestrationProtocolVersion": 2,
            "capabilities": Value::Object(capabilities)
        });
        if let Some(head) = auth
            .db
            .lock()
            .ok()
            .and_then(|db| {
                db.query_row(
                    "SELECT MAX(migration_id) FROM effect_sql_migrations",
                    [],
                    |r| r.get::<_, Option<i64>>(0),
                )
                .ok()
            })
            .flatten()
        {
            let build_head = crate::migration_history::MANIFEST
                .last()
                .map_or(0, |(id, _)| *id);
            descriptor["databaseMigration"] = json!(head.max(build_head));
        }
        let _ = auth.environment_descriptor.set(descriptor.clone());
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| cwd.clone());
        let paths = crate::runtime::ServerPaths::new(home.join(".t3"), false, false, None);
        let client_config = Self::make_client_config(&descriptor, &auth.descriptor, &cwd, &paths);
        let ready_at = auth
            .db
            .lock()
            .ok()
            .and_then(|db| {
                db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                    r.get(0)
                })
                .ok()
            })
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
        let settings = Arc::new(crate::settings::Settings::new(paths.settings_path.clone()));
        let storage_cleanup = crate::storage_cleanup::StorageCleanup::new(
            settings.clone(),
            paths.browser_artifacts_dir.clone(),
            paths.logs_dir.clone(),
        );
        let usage_service = crate::usage_service::UsageService::new(paths.state_dir.clone());
        let usage_limit_sources = crate::usage_limit_sources::UsageLimitSources::new(settings.clone());
        let background_activity = Arc::new(crate::background_activity::ClientActivity::default());
        let terminals = Arc::new(crate::terminal::TerminalManager::default());
        let resource_telemetry = Arc::new(crate::resource_telemetry::ResourceTelemetry::new(
            background_activity.clone(),
            terminals.clone(),
        ));
        Self {
            auth: auth.clone(),
            descriptor,
            event_bus: None,
            sessions: Arc::new(crate::provider::session_registry::SessionRegistry::default()),
            client_config,
            settings,
            storage_cleanup,
            background_activity,
            launch_gates: Arc::new(std::sync::Mutex::new(HashMap::new())),
            clones: crate::project_clone_tracker::Tracker::new(),
            source_signins: Arc::new(crate::source_control_signin::SignIns::default()),
            device_status: Arc::new(crate::device_status::DeviceStatus::new(
                paths.base_dir.clone(),
            )),
            preview_manager: Arc::new(crate::preview_manager::PreviewManager::new()),
            browser_pool: Arc::new(crate::preview_browser::BrowserPool::default()),
            database_storage: crate::database_storage::DatabaseStorage::new(
                auth.clone(),
                paths.base_dir.clone(),
                paths.db_path.clone(),
            ),
            keybindings: Arc::new(crate::keybindings::Keybindings::new(
                paths.keybindings_config_path.clone(),
                false,
            )),
            themes: Arc::new(crate::environment_theme::Themes::new(
                paths.environment_themes_dir.clone(),
                false,
            )),
            provider_cache: Arc::new(std::sync::Mutex::new(None)),
            managed_flows: Arc::new(crate::provider_auth::ManagedFlows::default()),
            cursor_auth: Arc::new(crate::provider::cursor_auth::CursorAuth::default()),
            installer: crate::provider_install::Installer::new(paths.base_dir.join("tools/codex")),
            repository_identities: Arc::new(
                crate::repository_identity::RepositoryIdentityCache::default(),
            ),
            pull_request_refreshes: Arc::new(crate::pull_request_refresh::Refreshes::default()),
            review_guide_runs: Arc::new(crate::pull_request_review_guide::Runs::default()),
            ready_at,
            migration_lifecycle: tokio::sync::watch::channel(None).1,
            triage: Arc::new(crate::triage::TriageService::new(
                paths.clone(),
                env!("CARGO_PKG_VERSION"),
            )),
            attachments_dir: paths.attachments_dir,
            secrets_dir: paths.secrets_dir,
            trace_path: paths.server_trace_path,
            named_projects_root: paths.base_dir.join("projects"),
            review_guide_worktrees: paths.worktrees_dir.clone(),
            trace_writer: None,
            terminals,
            resource_telemetry,
            usage_service,
            usage_limit_sources,
            webhook_policy_block: None,
            tailscale_serve_port: None,
        }
    }
    fn make_client_config(
        descriptor: &Value,
        auth: &Value,
        cwd: &std::path::Path,
        paths: &crate::runtime::ServerPaths,
    ) -> Value {
        let (keybindings, issues) = crate::keybindings::load(&paths.keybindings_config_path);
        let editors = crate::editor::available();
        let mut config = json!({"environment":descriptor,"auth":auth,"cwd":cwd.to_string_lossy(),
            "keybindingsConfigPath":paths.keybindings_config_path.to_string_lossy(),
            "keybindings":keybindings,"issues":issues,"providers":[],"availableEditors":editors,
            "remoteOpenTargets":[],"directEndpoints":[],"secretRequestReferences":true,"shellThreadFamilies":true,"shellOlderSettled":true,"newProjectsRoot":paths.base_dir.join("projects").to_string_lossy(),
            "observability":{"logsDirectoryPath":paths.logs_dir.to_string_lossy(),"localTracingEnabled":false,"otlpTracesEnabled":false,"otlpMetricsEnabled":false,"otlpLogsEnabled":false},
            "settings":{}});
        if editors.contains(&"file-manager") {
            config["shellRevealInFileManager"] = json!(true);
            if let Some(kind) = crate::editor::reveal_kind() {
                config["shellRevealInFileManagerKind"] = json!(kind);
            }
        }
        config
    }
    pub fn with_webhook_policy(mut self, block: Option<String>) -> Self {
        self.webhook_policy_block = block;
        self
    }
    pub fn with_tailscale_endpoint(mut self, port: Option<u16>) -> Self {
        self.tailscale_serve_port = port;
        self
    }
    pub fn with_direct_endpoints(mut self, endpoints: Vec<Value>) -> Self {
        self.client_config["directEndpoints"] = Value::Array(endpoints);
        self
    }
    pub fn start_background_services(&self) {
        self.usage_limit_sources
            .start_background_loop(self.background_activity.clone());
        self.resource_telemetry.start_background_sampler();
        if let Some(bus) = &self.event_bus {
            crate::thread_settlement_service::ThreadSettlementService::new().start(
                Arc::new(bus.clone()),
                self.settings.clone(),
                Some(self.terminals.clone()),
            );
        }
    }
    pub fn with_runtime_paths(
        mut self,
        cwd: &std::path::Path,
        paths: &crate::runtime::ServerPaths,
    ) -> Self {
        self.client_config =
            Self::make_client_config(&self.descriptor, &self.auth.descriptor, cwd, paths);
        self.settings = Arc::new(crate::settings::Settings::new(paths.settings_path.clone()));
        self.usage_service = crate::usage_service::UsageService::new(paths.state_dir.clone());
        self.usage_limit_sources =
            crate::usage_limit_sources::UsageLimitSources::new(self.settings.clone());
        self.installer =
            crate::provider_install::Installer::new(paths.base_dir.join("tools/codex"));
        self.storage_cleanup = crate::storage_cleanup::StorageCleanup::new(
            self.settings.clone(),
            paths.browser_artifacts_dir.clone(),
            paths.logs_dir.clone(),
        );
        if let Some(bus) = &self.event_bus {
            self.storage_cleanup
                .set_worktree_context(bus.clone(), self.terminals.clone());
        }
        self.device_status = Arc::new(crate::device_status::DeviceStatus::new(
            paths.base_dir.clone(),
        ));
        self.database_storage = crate::database_storage::DatabaseStorage::new(
            self.auth.clone(),
            paths.base_dir.clone(),
            paths.db_path.clone(),
        );
        self.themes = Arc::new(crate::environment_theme::Themes::new(
            paths.environment_themes_dir.clone(),
            true,
        ));
        if let Ok(db) = self.auth.db.lock() {
            if let Err(error) = self.settings.fold_legacy_project_settings(&db) {
                eprintln!("Warning: could not migrate project settings: {error}");
            }
        }
        self.keybindings = Arc::new(crate::keybindings::Keybindings::new(
            paths.keybindings_config_path.clone(),
            true,
        ));
        self.attachments_dir = paths.attachments_dir.clone();
        self.triage = Arc::new(crate::triage::TriageService::new(
            paths.clone(),
            env!("CARGO_PKG_VERSION"),
        ));
        self.secrets_dir = paths.secrets_dir.clone();
        self.trace_path = paths.server_trace_path.clone();
        self.named_projects_root = paths.base_dir.join("projects");
        self.review_guide_worktrees = paths.worktrees_dir.clone();
        match crate::trace_writer::TraceWriter::new(self.trace_path.clone()) {
            Ok(writer) => {
                let _ = writer.startup();
                self.trace_writer = Some(Arc::new(writer));
                self.client_config["observability"]["localTracingEnabled"] = json!(true);
            }
            Err(error) => eprintln!("Warning: could not initialize local tracing: {error}"),
        }
        self.terminals = Arc::new(
            crate::terminal::TerminalManager::with_logs_dir(paths.terminal_logs_dir.clone())
                .expect("failed to create terminal logs directory"),
        );
        self.resource_telemetry = Arc::new(crate::resource_telemetry::ResourceTelemetry::new(
            self.background_activity.clone(),
            self.terminals.clone(),
        ));
        self
    }
    pub fn resource_telemetry_handle(
        &self,
    ) -> Arc<crate::resource_telemetry::ResourceTelemetry> {
        self.resource_telemetry.clone()
    }
    pub fn trace_writer_handle(&self) -> Option<Arc<crate::trace_writer::TraceWriter>> {
        self.trace_writer.clone()
    }
    pub fn provider_cache_handle(&self) -> Arc<std::sync::Mutex<Option<Vec<Value>>>> {
        self.provider_cache.clone()
    }
    pub fn settings_handle(&self) -> Arc<crate::settings::Settings> {
        self.settings.clone()
    }
    pub fn database_storage_handle(&self) -> Arc<crate::database_storage::DatabaseStorage> {
        self.database_storage.clone()
    }
    pub fn background_activity_handle(&self) -> Arc<crate::background_activity::ClientActivity> {
        self.background_activity.clone()
    }
    pub fn storage_cleanup_handle(&self) -> Arc<crate::storage_cleanup::StorageCleanup> {
        self.storage_cleanup.clone()
    }
    pub fn with_migration_lifecycle(
        mut self,
        lifecycle: tokio::sync::watch::Receiver<Option<Value>>,
    ) -> Self {
        self.migration_lifecycle = lifecycle;
        self
    }
    pub fn with_session_registry(
        mut self,
        sessions: Arc<crate::provider::session_registry::SessionRegistry>,
    ) -> Self {
        self.sessions = sessions;
        self
    }
    pub fn with_terminal_manager(
        mut self,
        terminals: Arc<crate::terminal::TerminalManager>,
    ) -> Self {
        self.terminals = terminals;
        if let Some(bus) = &self.event_bus {
            self.storage_cleanup
                .set_worktree_context(bus.clone(), self.terminals.clone());
            bus.set_setup_context(self.terminals.clone(), self.settings.clone());
        }
        self
    }
    /// Attach the shared ordered event bus used by all orchestration writers.
    pub fn with_event_bus(mut self, event_bus: EventBus) -> Self {
        event_bus.set_setup_context(self.terminals.clone(), self.settings.clone());
        self.storage_cleanup
            .set_worktree_context(event_bus.clone(), self.terminals.clone());
        self.event_bus = Some(event_bus);
        self
    }
}

/// Recheck the authoritative database on every call and while a socket is
/// open. Missing, expired, changed, revoked, and unreadable sessions fail closed.
pub(crate) fn session_current(state: &AuthHttpState, principal: &Principal) -> bool {
    let Ok(db) = state.db.lock() else {
        return false;
    };
    let row: Result<Option<(String, String, String, bool)>, _> = db.query_row(
        "SELECT subject, scopes, method, (revoked_at IS NULL AND julianday(expires_at) > julianday('now')) FROM auth_sessions WHERE session_id=?1",
        [&principal.session_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional();
    let Ok(Some((subject, scopes, method, true))) = row else {
        return false;
    };
    let Ok(scopes) = serde_json::from_str::<Vec<String>>(&scopes) else {
        return false;
    };
    subject == principal.subject && method == principal.method && scopes == principal.scopes
}
pub(crate) fn normalize_provider_options(options: &Value) -> Option<Value> {
    let normalize = |id: &str, value: &Value| -> Option<Value> {
        let id = id.trim();
        if id.is_empty() {
            return None;
        }
        let value = match value {
            Value::String(s) if !s.trim().is_empty() => json!(s.trim()),
            Value::Bool(_) => value.clone(),
            _ => return None,
        };
        Some(json!({"id":id,"value":value}))
    };
    match options {
        Value::Array(values) => values
            .iter()
            .map(|v| normalize(v.get("id")?.as_str()?, v.get("value")?))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        Value::Object(values) => Some(Value::Array(
            values
                .iter()
                .map(|(id, v)| normalize(id, v))
                .collect::<Option<Vec<_>>>()?,
        )),
        _ => None,
    }
}
fn failure(message: &str) -> RpcFailure {
    RpcFailure::Die(json!({"name":"Error","message":message}))
}

fn issued_asset(issued: crate::attachment_asset::IssuedAssetUrl) -> Value {
    let mut value = json!({"relativeUrl":issued.relative_url,"expiresAt":issued.expires_at});
    if let Some(size) = issued.image_dimensions {
        value["imageDimensions"] = json!({"width":size.width,"height":size.height});
    }
    if let Some(revision) = issued.file_revision {
        value["fileRevision"] = json!(revision);
    }
    value
}

fn enrich_project_identity(
    cache: &crate::repository_identity::RepositoryIdentityCache,
    project: &mut Value,
) -> bool {
    let Some(root) = project["workspaceRoot"].as_str().map(str::to_owned) else {
        return false;
    };
    let (identity, resolved) = cache.get_with_status(&root);
    project["repositoryIdentity"] = identity.unwrap_or(Value::Null);
    resolved
}

fn enrich_shell_snapshot(
    cache: &crate::repository_identity::RepositoryIdentityCache,
    snapshot: &mut Value,
) -> Vec<String> {
    let mut roots = Vec::new();
    if let Some(projects) = snapshot["projects"].as_array_mut() {
        for project in projects {
            if enrich_project_identity(cache, project) {
                if let Some(root) = project["workspaceRoot"].as_str() {
                    roots.push(root.to_owned());
                }
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn identity_marker(mut snapshot: Value, roots: &[String]) -> Option<Value> {
    let projects = snapshot["projects"].as_array_mut()?;
    projects.retain(|project| {
        project["workspaceRoot"]
            .as_str()
            .is_some_and(|root| roots.iter().any(|r| r == root))
    });
    if projects.is_empty() {
        return None;
    }
    snapshot["threads"] = json!([]);
    snapshot["archivedThreads"] = json!([]);
    Some(json!({"kind":"snapshot","snapshot":snapshot,"resolvedRepositoryIdentityRoots":roots}))
}
impl RpcApplication for Application {
    type Session = Principal;
    fn descriptor(&self) -> Value {
        let mut descriptor = self.descriptor.clone();
        let publishing_active =
            crate::agent_awareness_relay::read_agent_activity_publishing_active(
                &self.auth.replay_dir,
            );
        descriptor["capabilities"]["agentActivityPublishing"] = json!(publishing_active);
        descriptor
    }
    fn webhook(
        &self,
        request: crate::http_server::WebhookHttpRequest,
    ) -> BoxFuture<crate::http_server::WebhookHttpResponse> {
        let bus = self.event_bus.clone();
        let blocked = self.webhook_policy_block.is_some();
        let relay_allowed = crate::managed_policy::allows_connect().unwrap_or(false);
        let environment_id = self.descriptor["environmentId"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let secrets_dir = self.secrets_dir.clone();
        Box::pin(async move {
            use crate::http_server::WebhookHttpResponse;
            if blocked {
                return WebhookHttpResponse {
                    status: 403,
                    outcome: "blocked_by_policy".into(),
                    body: json!({"error":"blocked_by_policy"}),
                };
            }
            if !cfg!(any(unix, windows)) || bus.is_none() {
                return WebhookHttpResponse {
                    status: 503,
                    outcome: "unavailable".into(),
                    body: json!({"error":"unavailable"}),
                };
            }
            tokio::task::spawn_blocking(move || {
                crate::webhook_http::handle_with_relay(
                    &bus.unwrap(),
                    request,
                    relay_allowed.then_some(crate::webhook_http::RelayConfig {
                        environment_id: &environment_id,
                        secrets_dir: &secrets_dir,
                    }),
                )
            })
            .await
            .unwrap_or_else(|_| WebhookHttpResponse {
                status: 500,
                outcome: "error".into(),
                body: json!({"error":"internal_error"}),
            })
        })
    }
    fn pull_request_diff(&self, request: axum::extract::Request) -> BoxFuture<Response> {
        let auth = self.auth.clone();
        Box::pin(async move {
            let (parts, body) = request.into_parts();
            let headers = parts.headers;
            let principal = match auth_http::authenticate_at(
                &auth,
                &headers,
                None,
                None,
                "POST",
                "/api/pull-requests/diff",
            ) {
                Ok(p) => p,
                Err(error) => return auth_http::auth_failure(error, &headers),
            };
            if !principal.scopes.iter().any(|s| s == "orchestration:read") {
                return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"orchestration:read","requiredPermission":"orchestration:read","traceId":uuid::Uuid::new_v4().to_string()}))).into_response();
            }
            let mut input: Value = match axum::body::to_bytes(body, 2 * 1024 * 1024).await.ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) {
                Some(input) => input,
                None => return (StatusCode::BAD_REQUEST, Json(json!({"_tag":"EnvironmentRequestInvalidError","code":"invalid_request","reason":"invalid_payload","traceId":uuid::Uuid::new_v4().to_string()}))).into_response(),
            };
            if let Some(object) = input.as_object_mut() {
                for key in [
                    "projectId",
                    "repository",
                    "host",
                    "expectedAccountId",
                    "cursor",
                    "commit",
                ] {
                    if let Some(Value::String(value)) = object.get_mut(key) {
                        *value = value.trim().to_owned();
                    }
                }
            }
            if !crate::pull_request_links::valid(&input)
                || ["cursor", "commit"].iter().any(|k| {
                    input
                        .get(*k)
                        .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
                })
            {
                return (StatusCode::BAD_REQUEST, Json(json!({"_tag":"EnvironmentRequestInvalidError","code":"invalid_request","reason":"invalid_payload","traceId":uuid::Uuid::new_v4().to_string()}))).into_response();
            }
            let (status, body) = tokio::task::spawn_blocking(move || {
                let projects = match auth.db.lock() {
                    Ok(db) => match crate::pull_request_routing::projects(&db) {
                        Ok(p) => p,
                        Err(e) => return (500, e),
                    },
                    Err(_) => return (500, json!({"_tag":"EnvironmentInternalError"})),
                };
                match crate::pull_request_diff::read(projects, &input) {
                    Ok(value) => (200, value),
                    Err(error) => (
                        if error["_tag"] == "PullRequestUnavailableError" {
                            503
                        } else {
                            502
                        },
                        error,
                    ),
                }
            })
            .await
            .unwrap_or_else(|_| (500, json!({"_tag":"EnvironmentInternalError"})));
            (
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                Json(body),
            )
                .into_response()
        })
    }
    fn orchestration_shell(
        &self,
        headers: HeaderMap,
        query: HashMap<String, String>,
    ) -> BoxFuture<Response> {
        use axum::response::IntoResponse;
        let auth = self.auth.clone();
        let bus = self.event_bus.clone();
        let repository_identities = self.repository_identities.clone();
        Box::pin(async move {
            let principal = match auth_http::authenticate_at(
                &auth,
                &headers,
                None,
                None,
                "GET",
                "/api/orchestration/shell",
            ) {
                Ok(p) => p,
                Err(error) => return auth_http::auth_failure(error, &headers),
            };
            if !principal.scopes.iter().any(|s| s == "orchestration:read") {
                return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"orchestration:read","requiredPermission":"orchestration:read","traceId":uuid::Uuid::new_v4().to_string()}))).into_response();
            }
            let Some(bus) = bus else {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"_tag":"OrchestrationV2GetShellSnapshotError","message":"Orchestration is unavailable"}))).into_response();
            };
            let omit_idle_subagents = query.get("omitIdleSubagents").is_some_and(|v| v == "1" || v == "true");
            let omit_older_settled = query.get("omitOlderSettled").is_some_and(|v| v == "1" || v == "true");
            let mut snapshot = match bus.shell_snapshot_with_options(omit_idle_subagents, omit_older_settled) {
                Ok(snapshot) => snapshot,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"_tag":"OrchestrationV2GetShellSnapshotError","message":"Failed to load orchestration V2 shell"}))).into_response(),
            };
            enrich_shell_snapshot(&repository_identities, &mut snapshot);
            let digest = snapshot["projects"]
                .as_array()
                .map(|projects| crate::event_bus::project_identities_digest(projects))
                .unwrap_or_default();
            snapshot["projectIdentities"] = json!(digest);
            (StatusCode::OK, Json(snapshot)).into_response()
        })
    }
    fn orchestration_thread_bounded(
        &self,
        thread_id: String,
        headers: HeaderMap,
        _query: HashMap<String, String>,
    ) -> BoxFuture<Response> {
        use axum::response::IntoResponse;
        let auth = self.auth.clone();
        let bus = self.event_bus.clone();
        Box::pin(async move {
            let path = format!("/api/orchestration/threads/{thread_id}/bounded");
            let principal = match auth_http::authenticate_at(
                &auth,
                &headers,
                None,
                None,
                "GET",
                &path,
            ) {
                Ok(p) => p,
                Err(error) => return auth_http::auth_failure(error, &headers),
            };
            if !principal.scopes.iter().any(|s| s == "orchestration:read") {
                return (StatusCode::FORBIDDEN, Json(json!({"_tag":"EnvironmentScopeRequiredError","code":"insufficient_scope","requiredScope":"orchestration:read","requiredPermission":"orchestration:read","traceId":uuid::Uuid::new_v4().to_string()}))).into_response();
            }
            let Some(bus) = bus else {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"_tag":"OrchestrationV2GetThreadProjectionError","threadId":thread_id,"message":"Orchestration is unavailable"}))).into_response();
            };
            match bus.thread_snapshot(thread_id.trim()) {
                Ok(Some((seq, projection))) => (
                    StatusCode::OK,
                    Json(json!({ "snapshotSequence": seq, "projection": projection })),
                )
                    .into_response(),
                Ok(None) => (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "_tag": "EnvironmentResourceNotFoundError", "message": "Thread not found" })),
                )
                    .into_response(),
                Err(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "_tag": "OrchestrationV2GetThreadProjectionError", "threadId": thread_id, "message": "Failed to load orchestration V2 thread" })),
                )
                    .into_response(),
            }
        })
    }
    fn preview_stream(
        &self,
        ws: axum::extract::ws::WebSocketUpgrade,
        headers: HeaderMap,
        query: HashMap<String, String>,
    ) -> BoxFuture<Response> {
        use axum::response::IntoResponse;
        let principal = match auth_http::authenticate_media(
            &self.auth,
            &headers,
            query.get("wsTicket").map(String::as_str),
            query.get("dpop").map(String::as_str),
            "/api/preview-stream/ws",
        ) {
            Ok(p) if session_current(&self.auth, &p) => p,
            Err(error) => {
                let internal = matches!(
                    error,
                    AuthError::Database(_) | AuthError::Proof(crate::dpop::ProofError::Storage)
                );
                let status = if internal {
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR
                } else if matches!(error, AuthError::Proof(crate::dpop::ProofError::Replay)) {
                    axum::http::StatusCode::CONFLICT
                } else {
                    axum::http::StatusCode::UNAUTHORIZED
                };
                let mut body = json!({"code":if internal {"internal_error"} else {"auth_invalid"},"reason":if internal {"internal_error"} else if query.contains_key("wsTicket") || headers.contains_key("authorization") || headers.contains_key("cookie") {"invalid_credential"}else{"missing_credential"},"traceId":uuid::Uuid::new_v4().to_string()});
                let is_proof = if let AuthError::Proof(proof) = error {
                    body["dpopFailureReason"] = json!(proof.wire_reason());
                    true
                } else {
                    false
                };
                return Box::pin(async move {
                    let mut response = (status, axum::Json(body)).into_response();
                    if is_proof {
                        response.headers_mut().insert(
                            axum::http::header::WWW_AUTHENTICATE,
                            axum::http::HeaderValue::from_static("DPoP"),
                        );
                    }
                    response
                });
            }
            _ => {
                return Box::pin(async {
                    (axum::http::StatusCode::UNAUTHORIZED, "Unauthorized").into_response()
                })
            }
        };
        if !principal.scopes.iter().any(|s| s == "orchestration:read") {
            return Box::pin(async {
                (axum::http::StatusCode::FORBIDDEN,axum::Json(json!({"code":"insufficient_scope","requiredScope":"orchestration:read","traceId":uuid::Uuid::new_v4().to_string()}))).into_response()
            });
        }
        let thread = query.get("threadId").cloned().unwrap_or_default();
        let tab = query.get("tabId").cloned().unwrap_or_default();
        if thread.trim().is_empty() || tab.trim().is_empty() {
            return Box::pin(async {
                (axum::http::StatusCode::NOT_FOUND, "Not Found").into_response()
            });
        }
        let allowed = principal.scopes.iter().any(|s| s == "preview:operate")
            && query.get("interactive").is_none_or(|v| v != "false");
        let pool = self.browser_pool.clone();
        let manager = self.preview_manager.clone();
        let auth = self.auth.clone();
        Box::pin(async move {
            ws.on_upgrade(move |socket| {
                crate::preview_stream::run(
                    socket,
                    crate::preview_stream::ViewerContext {
                        pool,
                        manager,
                        auth,
                        principal,
                        thread,
                        tab,
                        allowed,
                    },
                )
            })
            .into_response()
        })
    }
    fn authenticate(
        &self,
        headers: &HeaderMap,
        query: &HashMap<String, String>,
    ) -> Result<Principal, HttpRejection> {
        auth_http::authenticate_at(&self.auth, headers, query.get("wsTicket").map(String::as_str), query.get("dpop").map(String::as_str), "GET", "/ws").map_err(|error| {
            let internal = matches!(error, AuthError::Database(_) | AuthError::Proof(crate::dpop::ProofError::Storage));
            let credential_present = query.get("wsTicket").is_some_and(|t| !t.trim().is_empty()) || headers.contains_key("authorization") || headers.contains_key("cookie");
            let mut body = if internal { json!({"code":"internal_error","reason":"internal_error","traceId":uuid::Uuid::new_v4().to_string()}) } else { json!({"code":"auth_invalid","reason":if credential_present {"invalid_credential"} else {"missing_credential"},"traceId":uuid::Uuid::new_v4().to_string()}) };
            let mut response_headers = vec![];
            let mut status = if internal { 500 } else { 401 };
            if let AuthError::Proof(proof) = error {
                body["dpopFailureReason"] = json!(proof.wire_reason());
                if proof == crate::dpop::ProofError::Replay { status = 409; }
                response_headers.push(("www-authenticate".into(), "DPoP".into()));
            }
            HttpRejection { status, body, headers: response_headers }
        })
    }
    fn authorize(&self, session: &Principal, request: &Request) -> Result<(), RpcFailure> {
        if !session_current(&self.auth, session) {
            return Err(failure("Session is no longer valid"));
        }
        if !crate::terminal::TerminalManager::handles(&request.tag)
            && !crate::workspace_rpc::handles(&request.tag)
            && !crate::provider_auth::handles(&request.tag)
            && !crate::provider_install::handles(&request.tag)
            && !crate::vcs_status::handles(&request.tag)
            && !matches!(
                request.tag.as_str(),
                "server.probe"
                    | "peerLinks.list"
                    | "peerLinks.link"
                    | "peerLinks.unlink"
                    | "peerLinks.answerRequest"
                    | "cloud.getRelayClientStatus"
                    | "cloud.installRelayClient"
                    | "server.getTraceDiagnostics"
                    | "server.getNpmRelease"
                    | "server.runStorageCleanup"
                    | "server.getStorageCleanupReport"
                    | "server.getDatabaseStorage"
                    | "server.reclaimDatabaseSpace"
                    | "server.getHostResources"
                    | "server.getProcessDiagnostics"
                    | "server.getProcessResourceHistory"
                    | "server.getResourceTelemetryHistory"
                    | "server.retryResourceTelemetry"
                    | "server.signalProcess"
                    | "subscribeResourceTelemetry"
                    | "server.getUsageSummary"
                    | "server.refreshUsageRates"
                    | "attachments.createUploadUrl"
                    | "attachments.delete"
                    | "assets.createUrl"
                    | "scheduledTasks.subscribe"
                    | "secrets.answerRequest"
                    | "scheduledTasks.upsert"
                    | "scheduledTasks.setEnabled"
                    | "scheduledTasks.delete"
                    | "scheduledTasks.runNow"
                    | "scheduledTasks.rotateWebhookToken"
                    | "scheduledTasks.listWebhookDeliveries"
                    | "scheduledTasks.getWebhookDelivery"
                    | "server.checkOtlpEndpoint"
                    | "projects.mutate"
                    | "projects.createNew"
                    | "projects.ensureScratch"
                    | "projects.createFromThread"
                    | "shell.openInEditor"
                    | "projects.writeFile"
                    | "server.getConfig"
                    | "server.updateSettings"
                    | "server.checkSecretSource"
                    | "server.upsertKeybinding"
                    | "server.removeKeybinding"
                    | "server.refreshProviders"
                    | "server.prepareTriage"
                    | "subscribeServerConfig"
                    | "subscribeServerLifecycle"
                    | "subscribeAuthAccess"
                    | "orchestration.dispatchCommand"
                    | "orchestration.forceStopThread"
                    | "orchestration.getArchivedShellSnapshot"
                    | "orchestration.launchThread"
                    | "orchestration.stopWorkflow"
                    | "review.getDiffFileContents"
                    | "review.getBranchCommits"
                    | "review.getDiffPreview"
                    | "server.discoverSourceControl"
                    | "sourceControl.cloneRepository"
                    | "sourceControl.publishRepository"
                    | "sourceControl.lookupRepository"
                    | "sourceControl.signInStart"
                    | "sourceControl.signInWait"
                    | "sourceControl.signInCancel"
                    | "sourceControl.appAccess"
                    | "sourceControl.starred"
                    | "sourceControl.star"
                    | "server.reportClientActivity"
                    | "subscribeProjectClones"
                    | "projectClone.start"
                    | "projectClone.cancel"
                    | "projectClone.retry"
                    | "agentSessions.scan"
                    | "agentSessions.import"
                    | "device.list"
                    | "device.configure"
                    | "device.shutdown"
                    | "subscribeDeviceState"
                    | "preview.list"
                    | "preview.open"
                    | "preview.close"
                    | "preview.resize"
                    | "preview.adjust"
                    | "preview.reportProfiles"
                    | "preview.reportStatus"
                    | "preview.stopLocalServer"
                    | "subscribePreviewEvents"
                    | "subscribeDiscoveredLocalServers"
                    | "pullRequests.runAction"
                    | "pullRequests.setReaction"
                    | "pullRequests.submitReview"
                    | "pullRequests.replyToThread"
                    | "pullRequests.setThreadResolution"
                    | "pullRequests.reviewerCandidates"
                    | "pullRequests.requestReviewers"
                    | "pullRequests.labelCandidates"
                    | "pullRequests.setLabels"
                    | "pullRequests.comment"
                    | "pullRequests.updateComment"
                    | "pullRequests.invalidate"
                    | "pullRequests.reportState"
                    | "pullRequests.subscribeRefreshes"
                    | "pullRequests.linkedThreads"
                    | "pullRequests.list"
                    | "pullRequests.listStats"
                    | "pullRequests.filterOptions"
                    | "pullRequests.stack"
                    | "pullRequests.summary"
                    | "pullRequests.activity"
                    | "pullRequests.threadComments"
                    | "pullRequests.checks"
                    | "pullRequests.diffFileContents"
                    | "pullRequests.filesViewed"
                    | "pullRequests.setFilesViewed"
                    | "pullRequests.preview"
                    | "pullRequests.detail"
                    | "pullRequests.reviewGuide"
                    | "pullRequests.generateReviewGuide"
                    | "pullRequests.routingIdentity"
                    | "pullRequests.routing"
                    | "orchestration.searchThreads"
                    | "orchestration.getOlderSettledThreads"
                    | "orchestration.getShellSnapshot"
                    | "orchestration.getThreadProjection"
                    | "orchestration.getThreadFamily"
                    | "orchestration.getWorktreeThreadIds"
                    | "orchestration.getThreadTitles"
                    | "orchestration.getThreadLinkMetadata"
                    | "orchestration.subscribeShell"
                    | "orchestration.subscribeThread"
                    | "orchestration.subscribeCommandOutput"
            )
        {
            return Err(failure("RPC method is not implemented"));
        }
        if !request.payload.is_object() {
            return Err(failure("Invalid RPC payload"));
        }
        let required = authorization::required_scopes_for_rpc(&request.tag, &request.payload)
            .map_err(|_| failure("Invalid RPC request"))?;
        let grants: HashSet<String> = session.scopes.iter().cloned().collect();
        if let Some(missing) = authorization::first_missing(&grants, &required) {
            return Err(RpcFailure::Fail(
                json!({"_tag":"EnvironmentAuthorizationError","code":"insufficient_scope","requiredScope":missing.required_scope,"requiredPermission":missing.required_permission,"message":"Insufficient scope"}),
            ));
        }
        Ok(())
    }
    fn dispatch(
        &self,
        principal: Principal,
        request: Request,
    ) -> BoxFuture<Result<Value, RpcFailure>> {
        let bus = self.event_bus.clone();
        let launch_app = (request.tag == "orchestration.launchThread").then(|| self.clone());
        let pull_request_refreshes = self.pull_request_refreshes.clone();
        let review_guide_runs = self.review_guide_runs.clone();
        let review_guide_worktrees = self.review_guide_worktrees.clone();
        let managed_flows = self.managed_flows.clone();
        let cursor_auth = self.cursor_auth.clone();
        let installer = self.installer.clone();
        let host_id = format!(
            "urn:uuid:{}",
            self.descriptor["environmentId"].as_str().unwrap_or("")
        );
        let terminals = self.terminals.clone();
        let resource_telemetry = self.resource_telemetry.clone();
        let triage = self.triage.clone();
        let repository_identities = self.repository_identities.clone();
        let sessions = self.sessions.clone();
        let auth = self.auth.clone();
        let client_config = self.client_config.clone();
        let tailscale_serve_port = self.tailscale_serve_port;
        let settings = self.settings.clone();
        let storage_cleanup = self.storage_cleanup.clone();
        let background_activity = self.background_activity.clone();
        let clones = self.clones.clone();
        let source_signins = self.source_signins.clone();
        let device_status = self.device_status.clone();
        let preview_manager = self.preview_manager.clone();
        let browser_pool = self.browser_pool.clone();
        let database_storage = self.database_storage.clone();
        let keybindings = self.keybindings.clone();
        let provider_cache = self.provider_cache.clone();
        let attachments_dir = self.attachments_dir.clone();
        let secrets_dir = self.secrets_dir.clone();
        let environment_descriptor = self.descriptor.clone();
        let trace_path = self.trace_path.clone();
        let named_projects_root = self.named_projects_root.clone();
        let trace_backups = self
            .trace_writer
            .as_ref()
            .map_or(10, |writer| writer.backups());
        let webhook_policy_block = self.webhook_policy_block.clone();
        let trace_writer = self.trace_writer.clone();
        let usage_service = self.usage_service.clone();
        let usage_limit_sources = self.usage_limit_sources.clone();
        Box::pin(async move {
            let start = trace_writer.as_ref().map(|writer| writer.start());
            let trace_tag = request.tag.clone();
            let result = async move {
            if request.tag == "server.getUsageSummary" {
                let settings_snapshot = settings.snapshot();
                return usage_service
                    .read_summary(&request.payload, &settings_snapshot)
                    .await
                    .map_err(RpcFailure::Fail);
            }
            if request.tag == "server.refreshUsageRates" {
                return Ok(usage_service.refresh_rates().await);
            }
            if request.tag == "cloud.getRelayClientStatus" {
                return Ok(resolve_relay_client_status(&secrets_dir).await);
            }
            if request.tag == "peerLinks.list" {
                let links = crate::peer_links::list(&auth.db).await.map_err(|error| RpcFailure::Fail(crate::peer_links::wire_error(error)))?;
                return Ok(json!({"links":links}));
            }
            if request.tag == "peerLinks.unlink" {
                let id = request.payload["environmentId"].as_str().map(str::trim).filter(|id| !id.is_empty()).ok_or_else(|| failure("Invalid RPC payload"))?;
                let removed = crate::peer_links::unlink(&auth.db, &secrets_dir, id).await.map_err(|error| RpcFailure::Fail(crate::peer_links::wire_error(error)))?;
                return Ok(json!({"removed":removed}));
            }
            if request.tag == "peerLinks.link" {
                let mut input = request.payload.clone();
                for field in ["url", "pairingCode"] {
                    let value = input[field].as_str().map(str::trim).filter(|value| !value.is_empty()).ok_or_else(|| failure("Invalid RPC payload"))?.to_owned();
                    input[field] = json!(value);
                }
                if !matches!(input["access"].as_str(), Some("read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access")) { return Err(failure("Invalid RPC payload")); }
                if settings.snapshot()["linkedEnvironmentsEnabled"] != true {
                    return Err(RpcFailure::Fail(json!({"_tag":"PeerLinkError","reason":"disabled","message":"Linked environments is off on this machine. Turn it on in Settings → Labs."})));
                }
                return crate::peer_links::link(&auth.db, &secrets_dir, &environment_descriptor, &input).await.map_err(|error| RpcFailure::Fail(crate::peer_links::wire_error(error)));
            }
            if request.tag == "peerLinks.answerRequest" {
                let bus = bus.as_ref().ok_or_else(|| failure("Orchestration is unavailable"))?;
                return crate::peer_link_requests::answer(bus, &auth.db, &secrets_dir, &environment_descriptor, &request.payload)
                    .await
                    .map(|()| json!({}))
                    .map_err(|(reason, message)| RpcFailure::Fail(json!({"_tag":"PeerLinkRequestError","reason":reason,"message":message})));
            }
            if matches!(request.tag.as_str(), "preview.list" | "preview.open" | "preview.close" | "preview.resize" | "preview.adjust" | "preview.reportProfiles" | "preview.reportStatus") {
                let result = preview_manager.dispatch(&request.tag, &request.payload).map_err(RpcFailure::Fail)?;
                if request.tag == "preview.close" { if let Some(thread)=request.payload["threadId"].as_str() { browser_pool.close(thread.trim(),request.payload["tabId"].as_str().map(str::trim)).await; } }
                return Ok(result);
            }
            if request.tag == "device.configure" {
                let p=&request.payload;
                if ["enabled","agentAccessEnabled","onboardingCompleted"].iter().any(|key| p.get(*key).is_some_and(|v| !v.is_boolean())) { return Err(failure("Invalid RPC payload")); }
                device_status.read(&settings.snapshot(),false).map_err(RpcFailure::Fail)?;
                if p["enabled"] == true && !crate::device_status::can_enable_without_hub() { if let Err(error)=device_status.refresh_hub().await { device_status.stop_hub().await; return Err(RpcFailure::Fail(error)); } }
                if p["enabled"] == false {device_status.stop_hub().await;}
                let mut patch=json!({});
                for (input,setting) in [("enabled","enableDeviceSupport"),("agentAccessEnabled","enableAgentDeviceAccess"),("onboardingCompleted","deviceOnboardingCompleted")] { if let Some(v)=p.get(input){ patch[setting]=v.clone(); } }
                settings.update(&patch).map_err(|message| RpcFailure::Fail(json!({"_tag":"DeviceOperationError","operation":"configure","reason":"settings_failed","message":message})))?;
                device_status.mark_configured();
                return device_status.read(&settings.snapshot(),true).map_err(RpcFailure::Fail);
            }
            if request.tag == "device.shutdown" {
                let p=&request.payload;
                let id=p["deviceId"].as_str().map(str::trim).filter(|s|!s.is_empty() && s.chars().count()<=256).ok_or_else(||failure("Invalid RPC payload"))?;
                let platform=p["platform"].as_str().filter(|s|matches!(*s,"ios"|"android")).ok_or_else(||failure("Invalid RPC payload"))?;
                if p.get("hostId").is_some_and(|v|v.as_str()!=Some("local")) {return Err(failure("Remote device hosts are not supported by this server"));}
                if settings.snapshot()["enableDeviceSupport"] != true {return Err(RpcFailure::Fail(json!({"_tag":"DeviceHostUnavailableError","hostId":"local","hostLabel":"This machine","reason":"Device support is off. Enable it in the Device panel before installing or starting device tools."})));}
                device_status.refresh_hub().await.map_err(RpcFailure::Fail)?;
                device_status.shutdown(id,platform).await.map_err(RpcFailure::Fail)?;
                let _=device_status.read(&settings.snapshot(),true).map_err(RpcFailure::Fail)?;
                return Ok(Value::Null);
            }
            if request.tag == "device.list" {
                let p=&request.payload;
                if p.get("inspectOnly").is_some_and(|v| !v.is_boolean()) || p.get("updateTool").is_some_and(|v| !matches!(v.as_str(),Some("hub" | "agent"))) || p.get("retryHostId").is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty())) { return Err(failure("Invalid RPC payload")); }
                if p.get("updateTool").is_some() || p.get("retryHostId").is_some() { return Err(failure("Device host operations are not supported by this server")); }
                if settings.snapshot()["enableDeviceSupport"] == true && !crate::device_status::can_enable_without_hub() && p["inspectOnly"] != true { device_status.refresh_hub().await.map_err(RpcFailure::Fail)?; }
                return device_status.read(&settings.snapshot(), p["inspectOnly"] == true).map_err(RpcFailure::Fail);
            }
            if request.tag == "server.prepareTriage" {
                let Some(client) = request.payload.get("client").filter(|v| v.is_object()) else {
                    return Err(failure("Invalid RPC payload"));
                };
                return triage.prepare(client).await.map_err(|cause| {
                    RpcFailure::Fail(json!({
                        "_tag": "ServerPrepareTriageError",
                        "message": "Could not write the triage session files.",
                        "cause": cause,
                    }))
                });
            }
            if request.tag == "preview.stopLocalServer" {
                let Some(pid) = request
                    .payload
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok())
                    .filter(|v| *v > 0)
                else {
                    return Err(failure("Invalid RPC payload"));
                };
                let Some(port) = request
                    .payload
                    .get("port")
                    .and_then(Value::as_u64)
                    .and_then(|v| u16::try_from(v).ok())
                    .filter(|v| *v > 0)
                else {
                    return Err(failure("Invalid RPC payload"));
                };
                crate::preview_discovery::stop_local_server(pid, port, &terminals)
                    .await
                    .map_err(RpcFailure::Fail)?;
                return Ok(Value::Null);
            }
            if request.tag == "orchestration.getOlderSettledThreads" {
                let bus = bus
                    .as_ref()
                    .ok_or_else(|| failure("Orchestration is unavailable"))?;
                let Some(before) = request.payload.get("before").filter(|v| v.is_object()) else {
                    return Err(failure("Invalid RPC payload"));
                };
                let Some(settled_at) = before
                    .get("settledAt")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    return Err(failure("Invalid RPC payload"));
                };
                let thread_id = match before.get("threadId") {
                    None => None,
                    Some(v) => {
                        let Some(id) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                            return Err(failure("Invalid RPC payload"));
                        };
                        Some(id)
                    }
                };
                let project_ids = match request.payload.get("projectIds") {
                    None => None,
                    Some(v) => {
                        let Some(arr) = v.as_array() else {
                            return Err(failure("Invalid RPC payload"));
                        };
                        let mut ids = Vec::with_capacity(arr.len());
                        for item in arr {
                            let Some(id) = item.as_str().map(str::trim).filter(|s| !s.is_empty())
                            else {
                                return Err(failure("Invalid RPC payload"));
                            };
                            ids.push(id.to_owned());
                        }
                        Some(ids)
                    }
                };
                let Some(limit) = request
                    .payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .filter(|v| *v <= 50)
                else {
                    return Err(failure("Invalid RPC payload"));
                };
                return bus
                    .get_older_settled_threads(
                        settled_at,
                        thread_id,
                        project_ids.as_deref(),
                        limit as usize,
                    )
                    .map_err(|_| {
                        RpcFailure::Fail(json!({
                            "_tag": "OrchestrationV2GetShellSnapshotError",
                            "message": "Failed to load older settled threads",
                        }))
                    });
            }
            if request.tag == "orchestration.getShellSnapshot" {
                let bus = bus
                    .as_ref()
                    .ok_or_else(|| failure("Orchestration is unavailable"))?;
                let resume_from = match request.payload.get("resumeFrom") {
                    None | Some(Value::Null) => None,
                    Some(v) => {
                        let Some(seq) = v.as_i64().filter(|seq| *seq >= 0) else {
                            return Err(failure("Invalid RPC payload"));
                        };
                        Some(seq)
                    }
                };
                let omit_idle_subagents =
                    request.payload.get("omitIdleSubagents") == Some(&json!(true));
                let omit_older_settled =
                    request.payload.get("omitOlderSettled") == Some(&json!(true));
                if let Some(after) = resume_from {
                    if bus
                        .can_resume_shell_from(after)
                        .map_err(|_| failure("Failed to check shell resume cursor"))?
                    {
                        return Ok(json!({ "resumable": true }));
                    }
                }
                let mut snapshot = bus
                    .shell_snapshot_with_options(omit_idle_subagents, omit_older_settled)
                    .map_err(|_| {
                        RpcFailure::Fail(json!({
                            "_tag": "OrchestrationV2GetShellSnapshotError",
                            "message": "Failed to load orchestration V2 shell",
                        }))
                    })?;
                enrich_shell_snapshot(&repository_identities, &mut snapshot);
                let digest = snapshot["projects"]
                    .as_array()
                    .map(|projects| crate::event_bus::project_identities_digest(projects))
                    .unwrap_or_default();
                snapshot["projectIdentities"] = json!(digest);
                return Ok(snapshot);
            }
            if request.tag == "orchestration.getThreadProjection" {
                let bus = bus
                    .as_ref()
                    .ok_or_else(|| failure("Orchestration is unavailable"))?;
                let Some(thread_id) = request
                    .payload
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    return Err(failure("Invalid RPC payload"));
                };
                return match bus.thread_snapshot(thread_id) {
                    Ok(Some((_seq, projection))) => Ok(projection),
                    Ok(None) => Err(RpcFailure::Fail(json!({
                        "_tag": "OrchestrationV2GetThreadProjectionError",
                        "threadId": thread_id,
                        "message": "Thread not found",
                    }))),
                    Err(_) => Err(RpcFailure::Fail(json!({
                        "_tag": "OrchestrationV2GetThreadProjectionError",
                        "threadId": thread_id,
                        "message": "Failed to load orchestration V2 thread",
                    }))),
                };
            }
            if request.tag == "orchestration.getThreadFamily" {
                let bus = bus
                    .as_ref()
                    .ok_or_else(|| failure("Orchestration is unavailable"))?;
                let Some(thread_id) = request
                    .payload
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    return Err(failure("Invalid RPC payload"));
                };
                return bus.get_thread_family(thread_id).map_err(|_| {
                    RpcFailure::Fail(json!({
                        "_tag": "OrchestrationV2GetShellSnapshotError",
                        "message": "Failed to load the thread family",
                    }))
                });
            }
            if request.tag == "orchestration.getWorktreeThreadIds" {
                let bus = bus
                    .as_ref()
                    .ok_or_else(|| failure("Orchestration is unavailable"))?;
                let Some(worktree_path) = request
                    .payload
                    .get("worktreePath")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    return Err(failure("Invalid RPC payload"));
                };
                return bus.get_worktree_thread_ids(worktree_path).map_err(|_| {
                    RpcFailure::Fail(json!({
                        "_tag": "OrchestrationV2GetShellSnapshotError",
                        "message": "Failed to load the worktree's threads",
                    }))
                });
            }
            if request.tag == "orchestration.getArchivedShellSnapshot" {
                let bus=bus.as_ref().ok_or_else(||failure("Orchestration is unavailable"))?;
                let mut snapshot=bus.archived_shell_snapshot().map_err(|_|failure("Failed to load archived thread snapshot"))?;
                snapshot.as_object_mut().map(|v|v.remove("archivedThreads"));
                return Ok(snapshot);
            }
            if request.tag == "orchestration.stopWorkflow" {
                let bus = bus.as_ref().ok_or_else(|| failure("Orchestration is unavailable"))?;
                return crate::mcp_workflow::stop_workflow(bus, None, &request.payload)
                    .await
                    .map_err(|(_, msg)| failure(&msg));
            }
            if request.tag == "orchestration.launchThread" {
                if let Some(mode)=request.payload["runtimeMode"].as_str(){crate::managed_policy::check_runtime_mode(mode).map_err(|e|failure(&e))?;}
                let launch_app=launch_app.as_ref().ok_or_else(||failure("Launch unavailable"))?;
                let input=&request.payload;
                let required=|key:&str| input[key].as_str().map(str::trim).filter(|s|!s.is_empty()).ok_or_else(||failure("Invalid RPC payload"));
                let command_id=required("commandId")?;let project_id=required("projectId")?;let title=required("title")?;
                if let Some(message)=clones.blocked(project_id){return Err(RpcFailure::Fail(json!({"_tag":"OrchestrationDispatchCommandError","message":message})));}
                let key=input["threadId"].as_str().filter(|s|!s.trim().is_empty()).map(|s|format!("thread:{s}")).unwrap_or_else(||format!("command:{command_id}"));
                let gate={let mut gates=launch_app.launch_gates.lock().map_err(|_|failure("Launch unavailable"))?;gates.retain(|_,v|v.strong_count()>0);if let Some(gate)=gates.get(&key).and_then(std::sync::Weak::upgrade){gate}else{let gate=Arc::new(tokio::sync::Mutex::new(()));gates.insert(key,Arc::downgrade(&gate));gate}};
                let _launch_guard=gate.lock().await;
                let strategy=input.get("workspaceStrategy").filter(|v|v.is_object()).ok_or_else(||failure("Invalid RPC payload"))?;
                let strategy_type=strategy["type"].as_str().ok_or_else(||failure("Invalid RPC payload"))?;
                if !matches!(strategy_type,"root"|"existing_worktree"|"worktree") {return Err(failure("Invalid workspace strategy"));}
                if strategy_type=="worktree" && strategy["baseRef"].as_str().is_none_or(|s|s.trim().is_empty()) {return Err(failure("Invalid workspace strategy"));}
                if input.get("reuseExistingThread").is_some_and(|v|!v.is_boolean()) {return Err(failure("Invalid RPC payload"));}
                if let Some(message)=input.get("initialMessage") {if !message.is_object() || !message["text"].is_string() || !message["attachments"].is_array() || message.get("context").is_some_and(|v|crate::composer_context::normalize(v).is_err()) {return Err(failure("Invalid or unsupported initial message"));}}
                let bus=bus.as_ref().ok_or_else(||failure("Orchestration is unavailable"))?;
                let project: Option<String>=bus.with_autocommit(|db|db.query_row("SELECT workspace_root FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL",[project_id],|r|r.get(0)).optional()).map_err(|_|failure("Database unavailable"))?.map_err(|_|failure("Database unavailable"))?;
                let project=project.ok_or_else(||failure("Project not found."))?;
                let receipt=bus.with_autocommit(|db|crate::event_store::get_receipt(db,command_id,"thread")).map_err(|_|failure("Database unavailable"))?.map_err(|_|failure("Database unavailable"))?;
                let thread_id=input["threadId"].as_str().filter(|s|!s.trim().is_empty()).map(str::to_owned).or_else(||receipt.as_ref().map(|r|r.aggregate_id.clone())).unwrap_or_else(||uuid::Uuid::new_v4().to_string());
                if receipt.as_ref().is_some_and(|r|r.aggregate_id!=thread_id){return Err(failure("Launch command id belongs to another thread."));}
                let reuse=input["reuseExistingThread"]==true;
                if reuse && input.get("threadId").is_none(){return Err(failure("Reusing an existing thread requires a thread id."));}
                if reuse {let owner: Option<String>=bus.with_autocommit(|db|db.query_row("SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL AND archived_at IS NULL",[&thread_id],|r|r.get(0)).optional()).map_err(|_|failure("Database unavailable"))?.map_err(|_|failure("Database unavailable"))?;if owner.as_deref()!=Some(project_id){return Err(failure("Thread is not active in the target project."));}}
                let mut branch=strategy.get("branch").cloned().unwrap_or(Value::Null);
                let mut worktree=if strategy_type=="existing_worktree" {strategy.get("worktreePath").cloned().filter(|v|v.as_str().is_some_and(|s|!s.trim().is_empty())).ok_or_else(||failure("Invalid RPC payload"))?}else{Value::Null};
                let mut preparation=None;
                let mut scratch_folder=None;
                if strategy_type=="root" && receipt.is_none() {
                    let base=named_projects_root.parent().ok_or_else(||failure("Server data directory unavailable"))?.to_path_buf();
                    let text=input["initialMessage"]["text"].as_str().unwrap_or(title).to_owned();let root=project.clone();let tid=thread_id.clone();
                    scratch_folder=tokio::task::spawn_blocking(move ||crate::scratch_project::folder_for_thread(&base,&root,&tid,&text)).await.map_err(|_|failure("Scratch folder worker failed"))?.map_err(|e|failure(&e))?;
                    if let Some(folder)=scratch_folder.as_ref(){worktree=json!(folder.to_string_lossy());}
                }
                if strategy_type=="worktree" {
                    let existing=bus.with_autocommit(|db|db.query_row("SELECT json_extract(payload_json,'$.worktreePath'),json_extract(payload_json,'$.branch') FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND project_id=?2",rusqlite::params![thread_id,project_id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?))).optional()).map_err(|_|failure("Database unavailable"))?.map_err(|_|failure("Database unavailable"))?;
                    if let Some((Some(path),Some(b)))=existing {worktree=json!(path);branch=json!(b);} else {
                        let owned_bus=bus.clone();let snapshot=settings.snapshot();let cmd=command_id.to_owned();let tid=thread_id.clone();let pid=project_id.to_owned();let root=project.clone();let base=strategy["baseRef"].as_str().unwrap().to_owned();let b=strategy["branch"].as_str().map(str::to_owned);let origin=strategy["startFromOrigin"]==true;let now=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
                        let p=tokio::task::spawn_blocking(move ||crate::thread_launch::prepare_worktree(&owned_bus,&snapshot,&cmd,&tid,&pid,&root,&base,b.as_deref(),origin,&now)).await.map_err(|_|failure("Worktree preparation failed"))?.map_err(|e|failure(&e))?;
                        worktree=json!(p.worktree_path);branch=json!(p.branch);preparation=Some(p);
                    }
                }
                let mut create=request.clone();create.tag="orchestration.dispatchCommand".into();
                create.payload=if reuse {json!({"type":"thread.metadata.update","commandId":command_id,"threadId":thread_id,"expectedEmpty":true,"branch":branch,"worktreePath":worktree})} else {json!({"type":"thread.create","commandId":command_id,"threadId":thread_id,"projectId":project_id,"title":title,"createdBy":"user","creationSource":input.get("creationSource").cloned().unwrap_or(json!("web")),"modelSelection":input["modelSelection"],"runtimeMode":input["runtimeMode"],"interactionMode":input["interactionMode"],"branch":branch,"worktreePath":worktree})};
                if let Err(error)=launch_app.dispatch(principal.clone(),create).await {
                    if let Some(p)=preparation.as_ref(){crate::thread_launch::cleanup(bus,p);}
                    if let Some(folder)=scratch_folder.as_ref(){let _=std::fs::remove_dir(folder);}
                    return Err(error);
                }
                if let Some(p)=preparation.as_ref(){crate::thread_launch::mark_attached(bus,p).map_err(|e|failure(&e))?;}
                if strategy_type=="worktree" {let owned_bus=bus.clone();let pid=project_id.to_owned();let root=project.clone();let tid=thread_id.clone();let path=worktree.as_str().ok_or_else(||failure("Worktree unavailable"))?.to_owned();tokio::task::spawn_blocking(move ||crate::thread_launch::setup(&owned_bus,&pid,&root,&tid,&path)).await.map_err(|_|failure("Worktree setup failed"))?.map_err(|e|failure(&e))?;}

                let mut resumed=receipt.is_some();let mut sequence=None;
                if let Some(message)=input.get("initialMessage") {
                    if !message.is_object() || !message["text"].is_string() || !message["attachments"].is_array() || message.get("context").is_some_and(|v|crate::composer_context::normalize(v).is_err()) {return Err(failure("Invalid or unsupported initial message"));}
                    let message_command=format!("{command_id}:initial-message");
                    resumed=bus.with_autocommit(|db|crate::event_store::get_receipt(db,&message_command,"thread")).map_err(|_|failure("Database unavailable"))?.map_err(|_|failure("Database unavailable"))?.is_some();
                    let message_id=message["messageId"].as_str().map(str::to_owned).unwrap_or_else(||uuid::Uuid::new_v4().to_string());
                    let mut send=request.clone();send.tag="orchestration.dispatchCommand".into();send.payload=json!({"type":"message.dispatch","commandId":message_command,"threadId":thread_id,"messageId":message_id,"text":message["text"],"attachments":message["attachments"],"createdBy":"user","creationSource":input.get("creationSource").cloned().unwrap_or(json!("web")),"modelSelection":input["modelSelection"],"dispatchMode":{"type":"start_immediately"}});
                    if let Some(context)=message.get("context"){send.payload["context"]=context.clone();}
                    let result=launch_app.dispatch(principal.clone(),send).await?;sequence=result["sequence"].as_u64();
                    if input["generateTitle"]==true {let now=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);crate::thread_launch::request_initial_title(bus,&message_command,&thread_id,&message_id,&now).map_err(|e|failure(&e))?;}
                }
                let (_,projection)=bus.thread_snapshot(&thread_id).map_err(|_|failure("Thread projection unavailable"))?.ok_or_else(||failure("Thread not found"))?;
                let mut result=json!({"threadId":thread_id,"projection":projection,"resumed":resumed});if let Some(sequence)=sequence {result["sequence"]=json!(sequence);}return Ok(result);
            }
            if request.tag == "review.getDiffFileContents" {
                return tokio::task::spawn_blocking(move || {let db=auth.db.lock().map_err(|_|failure("Database unavailable"))?;let state=attachments_dir.parent().ok_or_else(||failure("Asset state unavailable"))?;crate::review_diff::file_contents(&request.payload,&db,state).map_err(RpcFailure::Fail)}).await.map_err(|_|failure("Review worker failed"))?;
            }
            if request.tag == "review.getBranchCommits" {
                return tokio::task::spawn_blocking(move || {let db=auth.db.lock().map_err(|_|failure("Database unavailable"))?;crate::review_diff::branch_commits(&request.payload,&db).map_err(RpcFailure::Fail)}).await.map_err(|_|failure("Review worker failed"))?;
            }
            if request.tag == "review.getDiffPreview" {
                return tokio::task::spawn_blocking(move || {
                    let db=auth.db.lock().map_err(|_|failure("Database unavailable"))?;
                    crate::review_diff::preview(&request.payload,&db).map_err(RpcFailure::Fail)
                }).await.map_err(|_|failure("Review worker failed"))?;
            }
            if matches!(request.tag.as_str(),"sourceControl.signInStart"|"sourceControl.signInWait"|"sourceControl.signInCancel") {
                let provider=request.payload["provider"].as_str().filter(|v|!v.trim().is_empty()).ok_or_else(||failure("Invalid RPC payload"))?;
                let host=request.payload["host"].as_str().filter(|v|!v.trim().is_empty()).ok_or_else(||failure("Invalid RPC payload"))?;
                return match request.tag.as_str() {
                    "sourceControl.signInStart"=>source_signins.start(provider,host,settings.clone()).await,
                    "sourceControl.signInWait"=>source_signins.wait(provider,host,settings.clone()).await,
                    _=>source_signins.cancel(provider,host),
                }.map_err(RpcFailure::Fail);
            }
            if matches!(request.tag.as_str(),"sourceControl.starred"|"sourceControl.star") {
                if ["provider","host","repository"].iter().any(|key|request.payload[*key].as_str().is_none_or(|v|v.trim().is_empty())) {return Err(failure("Invalid RPC payload"));}
                let write=request.tag=="sourceControl.star";
                return tokio::task::spawn_blocking(move || json!(crate::source_control_lookup::github_star(&request.payload,&settings,write))).await.map_err(|_|failure("Source control operation failed"));
            }
            if request.tag=="sourceControl.appAccess" {
                if ["provider","host","repository"].iter().any(|key|request.payload[*key].as_str().is_none_or(|v|v.trim().is_empty())) {return Err(failure("Invalid RPC payload"));}
                return tokio::task::spawn_blocking(move || crate::source_control_lookup::github_app_access(&request.payload,&settings)).await.map_err(|_|failure("Source control lookup worker failed"));
            }
            if request.tag == "sourceControl.lookupRepository" {
                return tokio::task::spawn_blocking(move || crate::source_control_lookup::lookup(&request.payload,Some(&settings)).map_err(RpcFailure::Fail))
                    .await.map_err(|_| failure("Source control lookup worker failed"))?;
            }
            if request.tag == "sourceControl.cloneRepository" {
                return tokio::task::spawn_blocking(move || crate::source_control_clone::clone_repository(&request.payload,Some(&settings)).map_err(RpcFailure::Fail))
                    .await.map_err(|_| failure("Source control clone worker failed"))?;
            }
            if request.tag == "sourceControl.publishRepository" {
                return tokio::task::spawn_blocking(move || crate::source_control_publish::publish(&request.payload,Some(&settings)).map_err(RpcFailure::Fail))
                    .await.map_err(|_| failure("Source control publish worker failed"))?;
            }
            if request.tag == "server.discoverSourceControl" {
                return tokio::task::spawn_blocking(move || crate::source_control_discovery::discover(&std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"))))
                    .await.map_err(|_| failure("Source control discovery failed"));
            }
            if request.tag == "server.reportClientActivity" {
                background_activity.report(&principal.session_id, &request.payload).map_err(|_| failure("Invalid RPC payload"))?;
                if background_activity.start_scheduler() {
                    let activity = Arc::downgrade(&background_activity);
                    let weak_settings = Arc::downgrade(&settings);
                    let weak_sessions = Arc::downgrade(&sessions);
                    let weak_cache = Arc::downgrade(&provider_cache);
                    let cwd = client_config["cwd"].as_str().unwrap_or("/").to_owned();
                    tokio::spawn(async move {
                        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
                        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                        loop {
                            tick.tick().await;
                            let (Some(activity), Some(settings), Some(sessions), Some(cache)) = (activity.upgrade(), weak_settings.upgrade(), weak_sessions.upgrade(), weak_cache.upgrade()) else { break };
                            let snapshot = settings.snapshot();
                            let mut demands = activity.provider_demands(&snapshot);
                            if demands.is_empty() { continue; }
                            if demands.iter().any(|id| id == "*") {
                                demands = snapshot["providerInstances"].as_object().map(|instances| instances.keys().cloned().collect()).unwrap_or_default();
                                if !demands.iter().any(|id| id == "codex") { demands.push("codex".into()); }
                            }
                            let configured_ms = crate::background_activity::ClientActivity::provider_refresh_interval(&snapshot);
                            if configured_ms == 0 { continue; }
                            let deferred = sessions.kiro_deferred.lock().map(|v| v.clone()).unwrap_or_default();
                            let due: Vec<String> = if let Ok(mut last) = sessions.last_provider_refresh.lock() {
                                demands.into_iter().filter(|id| {
                                    let interval = if deferred.contains(id) { 30_000 } else { configured_ms };
                                    if last.get(id).is_none_or(|at| at.elapsed() >= std::time::Duration::from_millis(interval)) { last.insert(id.clone(), std::time::Instant::now()); true } else { false }
                                }).collect()
                            } else { Vec::new() };
                            if due.is_empty() { continue; }
                            let _ = refresh_selected_providers(&cwd, settings.path(), &sessions, &cache, due).await;
                        }
                    });
                }
                return Ok(Value::Null);
            }
            if request.tag == "agentSessions.scan" {
                let snapshot = settings.snapshot();
                return tokio::task::spawn_blocking(move || {
                    let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                    crate::agent_session_scan::scan(&db, &snapshot).map_err(|detail| RpcFailure::Fail(json!({"_tag":"AgentSessionScanError","operation":"read-projects","cause":{"message":detail}})))
                }).await.map_err(|_| failure("Agent session scanner failed"))?;
            }
            if request.tag == "agentSessions.import" {
                let input = request.payload;
                let Some(project_id) = input["projectId"].as_str().filter(|v| !v.trim().is_empty()).map(str::to_owned) else { return Err(failure("Invalid RPC payload")); };
                if input.get("expectedWorkspaceRoot").is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty())) { return Err(failure("Invalid RPC payload")); }
                let expected = input["expectedWorkspaceRoot"].as_str().map(|s| s.trim().to_owned());
                let snapshot = settings.snapshot();
                let import_bus = bus.clone();
                return tokio::task::spawn_blocking(move || {
                    use rusqlite::OptionalExtension;
                    let db=auth.db.lock().map_err(|_|failure("Database unavailable"))?;
                    let root:Option<String>=db.query_row("SELECT workspace_root FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL",[&project_id],|r|r.get(0)).optional().map_err(|_|failure("Database unavailable"))?;
                    let Some(root)=root else {return Err(RpcFailure::Fail(json!({"_tag":"AgentSessionImportProjectNotFoundError","projectId":project_id})));};
                    let norm=crate::agent_session_scan::normalize_project_path;
                    if expected.as_deref().is_some_and(|v| norm(v)!=norm(&root)) {return Err(RpcFailure::Fail(json!({"_tag":"AgentSessionImportProjectChangedError","projectId":project_id})));}
                    drop(db);
                    crate::agent_session_import::import(import_bus.as_ref().ok_or_else(||failure("Event bus unavailable"))?,&snapshot,&project_id,&root).map_err(|e|failure(&e))
                }).await.map_err(|_|failure("Agent session importer failed"))?;
            }
            if crate::provider_install::handles(&request.tag) {
                if !crate::provider_install::valid(&request.tag, &request.payload) { return Err(failure("Invalid RPC payload")); }
                return installer.dispatch(&request.tag, &request.payload, settings.path()).await.map_err(RpcFailure::Fail);
            }
            if crate::provider_auth::handles(&request.tag) {
                if !crate::provider_auth::validate(&request.tag, &request.payload) { return Err(failure("Invalid RPC payload")); }
                let instance = request.payload["instanceId"].as_str().unwrap_or("");
                let provider_settings = crate::provider::session_registry::read_provider_settings(Some(settings.path())).map_err(|_| failure("Could not read provider settings"))?;
                let cursor_entry = &provider_settings["providerInstances"][instance];
                if cursor_entry["driver"] == "cursor" {
                    crate::managed_policy::check_provider_allowed("cursor").map_err(|detail| failure(&detail))?;
                    let detail = |operation: &str, detail: &str| RpcFailure::Fail(json!({"_tag":"ProviderSetupError","instanceId":instance,"operation":operation,"detail":detail}));
                    match request.tag.as_str() {
                        "provider.auth.start" => {
                            if cursor_entry["enabled"] == false || cursor_entry["config"]["enabled"] == false { return Err(detail("start", "Enable Cursor before signing in.")); }
                            let configured = std::env::var("CURSOR_API_KEY").is_ok_and(|key| !key.trim().is_empty()) || cursor_entry["environment"].as_array().is_some_and(|values| values.iter().any(|value| value["name"] == "CURSOR_API_KEY" && (value["value"].as_str().is_some_and(|key| !key.trim().is_empty()) || value.get("secret").is_some_and(|secret| !secret.is_null()))));
                            if configured { return Err(detail("start", "Remove CURSOR_API_KEY from this provider's environment before using browser sign-in.")); }
                            let node = std::env::var("T3CODE_CURSOR_NODE").unwrap_or_else(|_| "node".into());
                            let sdk = std::env::var("T3CODE_CURSOR_SDK_PATH").ok();
                            let backend = std::env::var("CURSOR_BACKEND_URL").ok();
                            let display = cursor_entry["displayName"].as_str().unwrap_or("Cursor");
                            return cursor_auth.start(crate::provider::cursor_auth::CursorAuthStart { instance, owner: &principal.session_id, display, settings: settings.path().to_owned(), node: &node, sdk_path: sdk.as_deref(), backend: backend.as_deref() }).map_err(|error| detail("start", &error));
                        }
                        "provider.auth.cancel" => return cursor_auth.cancel(instance, &principal.session_id, request.payload["flowId"].as_str().unwrap_or("")).map_err(|error| detail("cancel", &error)),
                        "provider.auth.logout" => { cursor_auth.logout(instance, settings.path()).map_err(|error| detail("logout", &error))?; return Ok(json!({})); }
                        _ => return Err(detail(request.tag.rsplit('.').next().unwrap_or("unknown"), "Cursor does not support this sign-in operation.")),
                    }
                }
                if crate::provider_auth::ManagedFlows::managed(&request.payload, settings.path()) {
                    let instance = request.payload["instanceId"].as_str().unwrap_or("");
                    let hook_bus = bus.clone();
                    let hook_sessions = sessions.clone();
                    let hook_instance = instance.to_owned();
                    let hook: crate::codex_oauth::RetirementHook = Arc::new(move || {
                        let bus = hook_bus.clone();
                        let sessions = hook_sessions.clone();
                        let instance = hook_instance.clone();
                        Box::pin(async move {
                            let guard = sessions.secret_refresh.clone().lock_owned().await;
                            retire_auth_sessions(bus.as_ref(), &sessions, &instance).await.map_err(|_| "stop_sessions")?;
                            Ok(guard)
                        })
                    });
                    managed_flows.set_retirement_hook(instance, hook).await
                        .map_err(|cause| RpcFailure::Fail(crate::provider_auth::managed_error(&request.tag, instance, cause)))?;
                    // Start retires under the launch lock. Adoption and durable
                    // logout retain it inside the controller through the write.
                    let _refresh = if request.tag == "provider.auth.start" {
                        Some(sessions.secret_refresh.lock().await)
                    } else { None };
                    if request.tag == "provider.auth.start" {
                        retire_auth_sessions(bus.as_ref(), &sessions, instance).await
                            .map_err(|_| RpcFailure::Fail(crate::provider_auth::managed_error(&request.tag, instance, "stop_sessions")))?;
                    }
                    return managed_flows.dispatch(&request.tag, &request.payload, &principal.session_id, &host_id, &secrets_dir).await
                        .map_err(|cause| RpcFailure::Fail(crate::provider_auth::managed_error(&request.tag, instance, cause)));
                }
                return Err(RpcFailure::Fail(crate::provider_auth::error(&request.tag, &request.payload, settings.path())));
            }
            if request.tag == "server.reclaimDatabaseSpace" {
                return Err(RpcFailure::Fail(json!({"_tag":"DatabaseReclaimError","reason":format!("Stop T3 Code on this machine, then run: {}", database_storage.command())})));
            }
            if request.tag == "server.runStorageCleanup" {
                return Ok(storage_cleanup.run_now().await);
            }
            if request.tag == "server.getNpmRelease" {
                let spec = request.payload["spec"].as_str().ok_or_else(|| failure("Invalid RPC payload"))?;
                return crate::npm_release::get(spec).await.map_err(|reason| RpcFailure::Fail(json!({"_tag":"ServerNpmReleaseError","reason":reason})));
            }
            if request.tag == "server.getTraceDiagnostics" {
                return tokio::task::spawn_blocking(move || {
                    crate::trace_diagnostics::read(&trace_path, trace_backups)
                })
                .await
                .map_err(|_| failure("Trace diagnostics worker failed"));
            }
            if request.tag == "server.getResourceTelemetryHistory" {
                let payload = request.payload.clone();
                return tokio::task::spawn_blocking(move || {
                    resource_telemetry.telemetry_history(&payload)
                })
                .await
                .map_err(|_| failure("Resource telemetry worker failed"))?;
            }
            if request.tag == "server.retryResourceTelemetry" {
                return tokio::task::spawn_blocking(move || Ok(resource_telemetry.retry()))
                    .await
                    .map_err(|_| failure("Resource telemetry worker failed"))?;
            }
            if request.tag == "server.getProcessDiagnostics" {
                return tokio::task::spawn_blocking(move || {
                    Ok(resource_telemetry.process_diagnostics())
                })
                .await
                .map_err(|_| failure("Process diagnostics worker failed"))?;
            }
            if request.tag == "server.getProcessResourceHistory" {
                let payload = request.payload.clone();
                return tokio::task::spawn_blocking(move || {
                    resource_telemetry.process_resource_history(&payload)
                })
                .await
                .map_err(|_| failure("Process resource history worker failed"))?;
            }
            if request.tag == "server.signalProcess" {
                let payload = request.payload.clone();
                return tokio::task::spawn_blocking(move || {
                    resource_telemetry.signal_process(&payload)
                })
                .await
                .map_err(|_| failure("Process signal worker failed"))?;
            }
            if request.tag == "secrets.answerRequest" {
                let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                let reference = &request.payload["answer"]["reference"];
                let snapshot = settings.private_snapshot();
                return crate::mcp_secret::answer_with_resolver(&bus, &request.payload, || {
                    crate::mcp_secret::resolve_reference(&snapshot, reference)
                })
                .await
                .map(|_| Value::Null)
                .map_err(|reason| {
                    let mut error = json!({"_tag":"SecretRequestError","reason":reason});
                    if reason == "reference_unreadable" {
                        if let Some(id) = reference["provider"].as_str() {
                            let label = snapshot["secretProviders"][id]["label"]
                                .as_str()
                                .unwrap_or(id);
                            error["provider"] = json!(label);
                        }
                    }
                    RpcFailure::Fail(error)
                });
            }
            if request.tag.starts_with("scheduledTasks.") {
                let task_error = |message: String| {
                    RpcFailure::Fail(json!({"_tag":"ScheduledTaskError","message":message}))
                };
                let now = chrono::Utc::now();
                if request.tag == "scheduledTasks.runNow" {
                    let id = request
                        .payload
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| failure("Invalid RPC payload"))?
                        .to_owned();
                    let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                    let result = tokio::task::spawn_blocking(move || {
                        crate::scheduled_tasks::run_manual_background(&bus, &id, sessions)
                    })
                    .await
                    .map_err(|_| failure("Scheduled task worker failed"))?
                    .map_err(task_error)?;
                    return result
                        .map(|task| json!({"task":task}))
                        .ok_or_else(|| task_error("Schedule task not found.".into()));
                }
                let mut db = auth
                    .db
                    .lock()
                    .map_err(|_| failure("Database unavailable"))?;
                if request.tag == "scheduledTasks.upsert" {
                    let input = &request.payload;
                    if input["enabled"] == true && input["schedule"]["type"] == "webhook" {
                        if let Some(message) = &webhook_policy_block {
                            return Err(task_error(message.clone()));
                        }
                        if !cfg!(any(unix, windows)) {
                            return Err(task_error(
                                "Webhook tasks are unavailable on this platform.".into(),
                            ));
                        }
                    }
                    let project = input["projectId"].as_str().unwrap_or("");
                    let id = input["id"].as_str().map(str::to_owned).or_else(|| {
                        input["commandId"]
                            .as_str()
                            .map(|s| format!("scheduled-task:{s}"))
                    });
                    let existing = match id {
                        Some(ref id) => {
                            crate::scheduled_tasks::get(&db, id).map_err(&task_error)?
                        }
                        None => None,
                    };
                    if let Some(thread) = input["threadId"].as_str().filter(|thread| {
                        existing.as_ref().and_then(|t| t["threadId"].as_str()) != Some(*thread)
                    }) {
                        let destination: Option<(String, Option<String>, Option<String>)> = db.query_row("SELECT project_id,archived_at,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id=?1",[thread],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|task_error(e.to_string()))?;
                        match destination {None | Some((_,_,Some(_))) => return Err(task_error("That thread no longer exists. Pick another destination.".into())),Some((_,Some(_),_)) => return Err(task_error("That thread is archived. Unarchive it or pick another destination.".into())),Some((p,_,_)) if p!=project => return Err(task_error("That thread belongs to a different project.".into())),_=>{}}
                    }
                    let task = crate::scheduled_tasks::upsert_with_secret_dir(
                        &db,
                        input,
                        now,
                        &secrets_dir,
                    )
                    .map_err(task_error)?;
                    let _ = crate::secret_requests::cleanup_claimed(&db, &secrets_dir);
                    return Ok(json!({"task":task}));
                }
                let id = request
                    .payload
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| failure("Invalid RPC payload"))?;
                if matches!(
                    request.tag.as_str(),
                    "scheduledTasks.listWebhookDeliveries" | "scheduledTasks.getWebhookDelivery"
                ) {
                    let any = match request.payload.get("acceptAnyOutcome") {
                        None => false,
                        Some(Value::Bool(v)) => *v,
                        _ => return Err(failure("Invalid RPC payload")),
                    };
                    if request.tag == "scheduledTasks.listWebhookDeliveries" {
                        return crate::webhook_deliveries::list(&db, id, any)
                            .map_err(|e| task_error(e.to_string()));
                    }
                    let delivery_id = request
                        .payload
                        .get("deliveryId")
                        .and_then(Value::as_str)
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| failure("Invalid RPC payload"))?;
                    return crate::webhook_deliveries::get(&db,id,delivery_id,any).map_err(|e|task_error(e.to_string()))?.ok_or_else(||RpcFailure::Fail(json!({"_tag":"ScheduledTaskError","message":"Webhook delivery not found.","taskId":id})));
                }
                if request.tag == "scheduledTasks.rotateWebhookToken" {
                    let task = crate::scheduled_tasks::rotate_webhook_token(&db, id, now)
                        .map_err(task_error)?;
                    return Ok(json!({"task":task}));
                }
                if request.tag == "scheduledTasks.setEnabled" {
                    let enabled = request
                        .payload
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| failure("Invalid RPC payload"))?;
                    if enabled {
                        if !cfg!(any(unix, windows))
                            && crate::scheduled_tasks::get(&db, id)
                                .map_err(&task_error)?
                                .is_some_and(|task| task["schedule"]["type"] == "webhook")
                        {
                            return Err(task_error(
                                "Webhook tasks are unavailable on this platform.".into(),
                            ));
                        }
                        if let Some(message) = &webhook_policy_block {
                            if crate::scheduled_tasks::get(&db, id)
                                .map_err(&task_error)?
                                .is_some_and(|task| {
                                    task["schedule"]["type"] == "webhook" && task["enabled"] != true
                                })
                            {
                                return Err(task_error(message.clone()));
                            }
                        }
                    }
                    let task = crate::scheduled_tasks::set_enabled(&db, id, enabled, now)
                        .map_err(task_error)?;
                    return Ok(json!({"task":task}));
                }
                if request.tag == "scheduledTasks.delete" {
                    crate::scheduled_tasks::delete(&mut db, id).map_err(task_error)?;
                    return Ok(json!({"id":id}));
                }
            }
            if request.tag == "server.checkOtlpEndpoint" {
                return crate::otlp_check::check(&request.payload)
                    .await
                    .map_err(|_| failure("Invalid RPC payload"));
            }
            if crate::terminal::TerminalManager::handles(&request.tag) {
                if request.tag == "terminal.open" {
                    let viewer = request.headers.iter().find(|(name, _)| name == "x-t3-internal-viewer").map(|(_, value)| value.clone());
                    return tokio::task::spawn_blocking(move || terminals.dispatch_for_viewer(&request.tag, &request.payload, viewer.as_deref()))
                        .await.map_err(|_| failure("Terminal worker failed"))?.map_err(RpcFailure::Fail);
                }
                return terminals
                    .dispatch_for_viewer(
                        &request.tag,
                        &request.payload,
                        request
                            .headers
                            .iter()
                            .find(|(name, _)| name == "x-t3-internal-viewer")
                            .map(|(_, value)| value.as_str()),
                    )
                    .map_err(RpcFailure::Fail);
            }
            if crate::vcs_status::handles(&request.tag) {
                let mut submodules = None;
                let root = if matches!(request.tag.as_str(), "vcs.createWorktree" | "vcs.removeWorktree") {
                    let default = bus.as_ref().and_then(|bus| bus.worktrees_dir()).ok_or_else(|| failure("Worktree directory is unavailable"))?;
                    if request.tag == "vcs.createWorktree" {
                        let snapshot = settings.snapshot();
                        let configured = snapshot["worktreesDirectory"].as_str().unwrap_or("").to_owned();
                        submodules = worktree_submodule_setting(bus.as_ref().unwrap(), &snapshot, request.payload["cwd"].as_str().unwrap_or(""));
                        resolve_worktrees_root(&configured, &default).ok_or_else(|| RpcFailure::Fail(json!({"_tag":"GitCommandError","operation":"GitVcsDriver.createWorktree","command":"git worktree add","cwd":request.payload["cwd"],"detail":format!("The worktree location \"{configured}\" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.")})))?
                    } else { default }
                } else { std::path::PathBuf::new() };
                return tokio::task::spawn_blocking(move || crate::vcs_status::dispatch_with_worktrees_and_submodules(&request.tag, &request.payload, &root, submodules.as_deref()))
                    .await
                    .map_err(|_| failure("VCS worker failed"))?;
            }
            if request.tag == "projectClone.start" {
                let bus=bus.as_ref().ok_or_else(||failure("Orchestration is unavailable"))?;
                let bus=bus.clone();
                return tokio::task::spawn_blocking(move || clones.start(&bus,&request.payload,Some(&settings)).map_err(RpcFailure::Fail))
                    .await.map_err(|_|failure("Project clone worker failed"))?;
            }
            if matches!(request.tag.as_str(),"projectClone.cancel"|"projectClone.retry") {
                let id=request.payload["projectId"].as_str().filter(|s|!s.trim().is_empty()).ok_or_else(||failure("Invalid RPC payload"))?;
                return Ok(json!({"applied":if request.tag=="projectClone.cancel"{clones.cancel(id).await}else{clones.retry(id)}}));
            }
            if request.tag == "projects.createFromThread" {
                let id=request.payload["threadId"].as_str().filter(|s|!s.trim().is_empty()).ok_or_else(||failure("Invalid RPC payload"))?.to_owned();
                let bus=bus.ok_or_else(||failure("Orchestration is unavailable"))?;
                let base=named_projects_root.parent().ok_or_else(||failure("Server data directory unavailable"))?.to_path_buf();
                return tokio::task::spawn_blocking(move ||crate::scratch_promotion::promote(&bus,&base,&id)).await.map_err(|_|failure("Project promotion worker failed"))?.map_err(RpcFailure::Fail);
            }
            if request.tag == "projects.ensureScratch" {
                let bus=bus.ok_or_else(||failure("Orchestration is unavailable"))?;
                let base=named_projects_root.parent().ok_or_else(||failure("Server data directory unavailable"))?.to_path_buf();
                return tokio::task::spawn_blocking(move ||crate::scratch_project::ensure(&bus,&base)).await.map_err(|_|failure("Scratch project worker failed"))?.map_err(RpcFailure::Fail);
            }
            if request.tag == "projects.createNew" {
                let name = request.payload["name"].as_str().map(str::trim)
                    .filter(|name| !name.is_empty() && name.encode_utf16().count() <= 200)
                    .ok_or_else(|| failure("Invalid RPC payload"))?.to_owned();
                let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                let result = tokio::task::spawn_blocking(move || crate::managed_project_folders::create_new(&bus, &named_projects_root, &name))
                    .await.map_err(|_| failure("Project creation worker failed"))?
                    .map_err(|error| RpcFailure::Fail(json!({"_tag":"OrchestrationDispatchCommandError", "message":error.to_string()})))?;
                let mut value = json!({"projectId":result.project_id,"workspaceRoot":result.workspace_root.to_string_lossy()});
                if let Some(error) = result.commit_error { value["commitError"] = json!(error); }
                return Ok(value);
            }
            if request.tag == "projects.mutate" {
                let input = &request.payload;
                let command_id = input["commandId"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| failure("Invalid RPC payload"))?;
                let project_id = input["projectId"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| failure("Invalid RPC payload"))?;
                if input["type"] == "project.delete" {
                    let force = match input.get("force") {
                        None => false,
                        Some(Value::Bool(v)) => *v,
                        _ => return Err(failure("Unsupported or invalid project mutation")),
                    };
                    let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    let result = crate::project_mutation::delete_with_outcome(&bus, command_id, project_id, force, &now).map_err(|e| RpcFailure::Fail(json!({"_tag":"ProjectMutationError","commandId":command_id,"message":e.to_string()})))?;
                    if result.deleted_workspace_root.is_some() {
                        clones.discard(project_id).await;
                        let _ = settings
                            .update(&json!({"projectSettingsOverrides": {project_id: null}}));
                    }
                    let db = auth
                        .db
                        .lock()
                        .map_err(|_| failure("Database unavailable"))?;
                    return crate::mcp_projects::read_including_deleted(&db, project_id)
                        .map_err(|_| failure("Project unavailable"));
                }
                if input["type"] == "project.create" {
                    let invalid = || failure("Unsupported or invalid project mutation");
                    if !crate::project_update::validate(input) {
                        return Err(invalid());
                    }
                    let title = input["title"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(invalid)?;
                    let root = input["workspaceRoot"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(invalid)?;
                    let create = match input.get("createWorkspaceRootIfMissing") {
                        None => false,
                        Some(Value::Bool(v)) => *v,
                        _ => return Err(invalid()),
                    };
                    let cwd = std::env::current_dir()
                        .map_err(|_| failure("Current directory unavailable"))?;
                    let home = std::env::var_os("HOME")
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| cwd.clone());
                    let path = crate::runtime::resolve_base_dir(Some(root), &home, &cwd);
                    if create {
                        std::fs::create_dir_all(&path)
                            .map_err(|_| failure("Failed to create project workspace"))?;
                    }
                    if !path.is_dir() {
                        return Err(RpcFailure::Fail(
                            json!({"_tag":"ProjectMutationError","commandId":command_id,"message":"Project workspace must be an existing directory."}),
                        ));
                    }
                    let workspace = path.to_string_lossy();
                    let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    let result = crate::project_sink::create_project_ordered(
                        &bus,
                        crate::project_commands::CreateProject {
                            command_id,
                            project_id,
                            title,
                            workspace_root: &workspace,
                            scripts: input
                                .get("scripts")
                                .and_then(Value::as_array)
                                .map(Vec::as_slice),
                        },
                        &uuid::Uuid::new_v4().to_string(),
                        &now,
                    )
                    .map_err(|e| RpcFailure::Fail(json!({"_tag":"ProjectMutationError","commandId":command_id,"message":e.to_string()})))?;
                    if result.receipt.status == "rejected" {
                        let message = result
                            .receipt
                            .error
                            .unwrap_or_else(|| "Project creation rejected".into());
                        return Err(RpcFailure::Fail(
                            json!({"_tag":"ProjectMutationError","commandId":command_id,"message":message}),
                        ));
                    }
                    let db = auth
                        .db
                        .lock()
                        .map_err(|_| failure("Database unavailable"))?;
                    return crate::mcp_projects::read_including_deleted(&db, project_id)
                        .map_err(|_| failure("Project unavailable"));
                }
                if input["type"] != "project.update" || !crate::project_update::validate(input) {
                    return Err(failure("Unsupported or invalid project mutation"));
                }
                let mut normalized = input.clone();
                if let Some(root) = input.get("workspaceRoot").and_then(Value::as_str) {
                    let cwd = std::env::current_dir()
                        .map_err(|_| failure("Current directory unavailable"))?;
                    let home = std::env::var_os("HOME")
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| cwd.clone());
                    let path = crate::runtime::resolve_base_dir(Some(root.trim()), &home, &cwd);
                    if !path.is_dir() {
                        return Err(RpcFailure::Fail(
                            json!({"_tag":"ProjectMutationError","commandId":command_id,"message":"Project workspace must be an existing directory."}),
                        ));
                    }
                    normalized["workspaceRoot"] = json!(path.to_string_lossy());
                }
                let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let receipt = crate::project_update::dispatch(
                    &bus,
                    command_id,
                    project_id,
                    &normalized,
                    &now,
                )
                .map_err(|_| failure("Failed to update project"))?;
                if receipt.status == "rejected" {
                    let message = receipt
                        .error
                        .unwrap_or_else(|| "Project update rejected".into());
                    return Err(RpcFailure::Fail(
                        json!({"_tag":"ProjectMutationError","commandId":command_id,"message":message}),
                    ));
                }
                let auth = auth.clone();
                let id = project_id.to_owned();
                return tokio::task::spawn_blocking(move || {
                    let db = auth
                        .db
                        .lock()
                        .map_err(|_| failure("Database unavailable"))?;
                    crate::mcp_projects::call(&db, "t3_project_read", &json!({"projectId":id}))
                        .map_err(|_| failure("Project unavailable"))
                })
                .await
                .map_err(|_| failure("Project unavailable"))?;
            }
            if request.tag == "shell.openInEditor" {
                return crate::editor::launch(&request.payload).map_err(RpcFailure::Fail);
            }
            if request.tag == "projects.writeFile" {
                let state = attachments_dir
                    .parent()
                    .unwrap_or(std::path::Path::new("/"));
                let db = auth
                    .db
                    .lock()
                    .map_err(|_| failure("Database unavailable"))?;
                return crate::workspace_rpc::write_file(
                    &request.payload,
                    state,
                    &db,
                    &settings.snapshot(),
                );
            }
            if crate::workspace_rpc::handles(&request.tag) {
                return crate::workspace_rpc::dispatch(
                    &request.tag,
                    &request.payload,
                    attachments_dir
                        .parent()
                        .unwrap_or(std::path::Path::new("/")),
                );
            }
            if request.tag == "attachments.createUploadUrl" {
                let payload = &request.payload;
                let invalid = || failure("Invalid RPC payload");
                let kind = match payload.get("type") {
                    None => "image",
                    Some(v) => v.as_str().ok_or_else(invalid)?,
                };
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?;
                let mime = payload
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?;
                let size = payload
                    .get("sizeBytes")
                    .and_then(Value::as_u64)
                    .ok_or_else(invalid)?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| failure("Clock unavailable"))?
                    .as_millis() as i64;
                crate::attachment_store::sweep_if_due(&attachments_dir, now);
                let (claims, token) = crate::attachment_store::create_upload(
                    &auth.signing_key,
                    kind,
                    name,
                    mime,
                    size,
                    now,
                )
                .map_err(|_| invalid())?;
                return Ok(
                    json!({"attachmentId": claims.attachment_id, "relativeUrl": format!("/api/attachments/upload/{token}"), "expiresAt": claims.expires_at}),
                );
            }
            if request.tag == "assets.createUrl" {
                let resource = &request.payload["resource"];
                if resource["_tag"] == "project-favicon" {
                    let cwd=resource["cwd"].as_str().map(str::trim).filter(|s|!s.is_empty()).ok_or_else(||failure("Invalid RPC payload"))?;
                    let db=auth.db.lock().map_err(|_|failure("Database unavailable"))?;
                    let project: Option<(String,Option<String>)>=db.query_row("SELECT workspace_root,favicon_path FROM projection_projects WHERE workspace_root=?1 AND deleted_at IS NULL",[cwd],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|failure("Project unavailable"))?;
                    let (root,override_path)=project.ok_or_else(||RpcFailure::Fail(json!({"_tag":"AssetWorkspaceContextNotFoundError","resource":resource})))?;
                    let state=attachments_dir.parent().ok_or_else(||failure("Asset state unavailable"))?;
                    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|failure("Clock unavailable"))?.as_millis() as i64;
                    let issued=crate::attachment_asset::issue_project_favicon_url(std::path::Path::new(&root),state,&auth.signing_key,override_path.as_deref(),now).map_err(|tag|RpcFailure::Fail(json!({"_tag":tag,"resource":resource})))?;
                    return Ok(issued_asset(issued));
                }
                if resource["_tag"] == "media-file" {
                    let path = resource["path"].as_str().map(str::trim).filter(|v| !v.is_empty() && v.encode_utf16().count() <= 1024).ok_or_else(|| failure("Invalid RPC payload"))?;
                    let thread = resource["threadId"].as_str().map(str::trim).filter(|v| !v.is_empty()).ok_or_else(|| failure("Invalid RPC payload"))?;
                    let disposition = match resource.get("disposition") {None => false, Some(Value::String(s)) if s == "attachment" => true, _ => return Err(failure("Invalid RPC payload"))};
                    if resource.get("hostOnly").is_some_and(|v| v != &json!(true)) { return Err(failure("Invalid RPC payload")); }
                    let needs_root = (!std::path::Path::new(path).is_absolute() && !path.starts_with("~/")) || path.starts_with("//") || path.starts_with("\\\\");
                    let root = if needs_root {
                        let bus = bus.as_ref().ok_or_else(|| failure("Orchestration is unavailable"))?;
                        Some(bus.with_autocommit(|db| db.query_row("SELECT COALESCE(NULLIF(json_extract(t.payload_json,'$.worktreePath'),''),p.workspace_root) FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL",[thread],|r|r.get::<_,String>(0)).optional())
                            .map_err(|_| failure("Failed to resolve workspace"))?.map_err(|_| failure("Failed to resolve workspace"))?.ok_or_else(|| RpcFailure::Fail(json!({"_tag":"AssetWorkspaceContextNotFoundError","resource":resource})))?)
                    } else { None };
                    let state = attachments_dir.parent().ok_or_else(|| failure("Asset state is unavailable"))?;
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| failure("Clock unavailable"))?.as_millis() as i64;
                    let issued = crate::attachment_asset::issue_media_asset_url(root.as_deref().map(std::path::Path::new),state,&auth.signing_key,path,disposition,now)
                        .map_err(|tag| RpcFailure::Fail(json!({"_tag":tag,"resource":resource,"cause":"Media asset unavailable"})))?;
                    return Ok(issued_asset(issued));
                }
                if matches!(resource["_tag"].as_str(), Some("workspace-file" | "draft-workspace-file")) {
                    let kind = resource["_tag"].as_str().unwrap();
                    let path = resource["path"].as_str().map(str::trim).filter(|v| !v.is_empty() && v.encode_utf16().count() <= 1024).ok_or_else(|| failure("Invalid RPC payload"))?.to_owned();
                    let root = if kind == "draft-workspace-file" {
                        resource["cwd"].as_str().map(str::trim).filter(|v| !v.is_empty() && v.encode_utf16().count() <= 1024).ok_or_else(|| failure("Invalid RPC payload"))?.to_owned()
                    } else {
                        let thread = resource["threadId"].as_str().map(str::trim).filter(|v| !v.is_empty()).ok_or_else(|| failure("Invalid RPC payload"))?;
                        let bus = bus.as_ref().ok_or_else(|| failure("Orchestration is unavailable"))?;
                        bus.with_autocommit(|db| db.query_row("SELECT COALESCE(NULLIF(json_extract(t.payload_json,'$.worktreePath'),''),p.workspace_root) FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL",[thread],|r|r.get::<_,String>(0)).optional())
                            .map_err(|_| failure("Failed to resolve workspace"))?.map_err(|_| failure("Failed to resolve workspace"))?.ok_or_else(|| RpcFailure::Fail(json!({"_tag":"AssetWorkspaceContextNotFoundError","resource":resource})))?
                    };
                    let state = attachments_dir.parent().ok_or_else(|| failure("Asset state is unavailable"))?;
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| failure("Clock unavailable"))?.as_millis() as i64;
                    let issued = crate::attachment_asset::issue_workspace_asset_url(std::path::Path::new(&root), state, &auth.signing_key, &path, kind == "draft-workspace-file", now)
                        .map_err(|tag| RpcFailure::Fail(json!({"_tag":tag,"resource":resource,"cause":"Workspace asset unavailable"})))?;
                    return Ok(issued_asset(issued));
                }
                if resource["_tag"] != "attachment" { return Err(failure("Unsupported asset resource")); }
                let id = resource["attachmentId"].as_str().map(str::trim).filter(|id| !id.is_empty() && id.encode_utf16().count() <= 256).ok_or_else(|| failure("Invalid RPC payload"))?;
                let optional = |key: &str| -> Result<Option<&str>, RpcFailure> {
                    match resource.get(key) { None => Ok(None), Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.trim())), _ => Err(failure("Invalid RPC payload")) }
                };
                let name = optional("fileName")?;
                let mime = optional("mimeType")?;
                let disposition = optional("disposition")?;
                if disposition.is_some_and(|v| !matches!(v,"inline"|"attachment")) { return Err(failure("Invalid RPC payload")); }
                let render = optional("renderIntent")?;
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| failure("Clock unavailable"))?.as_millis() as i64;
                let issued = crate::attachment_asset::issue_attachment_asset_url(&attachments_dir,&auth.signing_key,crate::attachment_asset::AttachmentAssetRequest { attachment_id:id,file_name:name,mime_type:mime,inline:disposition==Some("inline"),render_intent:render },now)
                    .map_err(|_| RpcFailure::Fail(json!({"_tag":"AssetAttachmentNotFoundError","resource":resource})))?;
                return Ok(issued_asset(issued));
            }
            if request.tag == "attachments.delete" {
                let id = request
                    .payload
                    .get("attachmentId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 256)
                    .ok_or_else(|| failure("Invalid RPC payload"))?;
                crate::attachment_store::delete_pending(&attachments_dir, id);
                return Ok(Value::Null);
            }
            if request.tag == "server.checkSecretSource" {
                let reference = &request.payload["source"];
                let provider = reference["provider"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| failure("Invalid RPC payload"))?;
                let path = reference["reference"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| failure("Invalid RPC payload"))?;
                let _refresh = sessions.secret_refresh.lock().await;
                let snapshot = crate::provider::session_registry::read_provider_settings(Some(
                    settings.path(),
                ))
                .map_err(|_| failure("Could not read provider settings"))?;
                sessions
                    .reconcile_secret_providers(&snapshot)
                    .map_err(|_| failure("Provider refresh failed"))?;
                let Some(value) = crate::mcp_secret::resolve_reference(&snapshot, reference).await
                else {
                    let label = snapshot["secretProviders"][provider]["label"]
                        .as_str()
                        .unwrap_or(provider);
                    return Ok(
                        json!({"_tag":"Failed", "detail":format!("Could not read this secret from \"{label}\". Check the provider's settings and that its store is unlocked.")}),
                    );
                };
                if crate::provider::session_registry::read_provider_settings(Some(settings.path()))
                    .map_err(|_| failure("Could not read provider settings"))?
                    != snapshot
                {
                    return Ok(
                        json!({"_tag":"Failed", "detail":"Settings changed while reading the secret. Try again."}),
                    );
                }
                if sessions
                    .secrets
                    .apply(provider, path, value)
                    .map_err(|_| failure("Secret store unavailable"))?
                {
                    sessions
                        .invalidate_reference(provider, path)
                        .map_err(|_| failure("Provider refresh failed"))?;
                }
                *provider_cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
                return Ok(json!({"_tag":"Resolved"}));
            }
            if request.tag == "server.updateSettings" {
                let _refresh = sessions.secret_refresh.lock().await;
                let old_providers = settings.private_snapshot()["secretProviders"].clone();
                let old_instances = settings.private_snapshot()["providerInstances"].clone();
                if let Some(mutation) = request.payload.get("providerInstanceMutation") {
                    let result = settings.update_with_provider_mutation(&request.payload["patch"], mutation).map_err(|error| {
                        match error {
                            crate::settings::SettingsUpdateError::InvalidMutation => failure("Invalid RPC payload"),
                            crate::settings::SettingsUpdateError::InstanceExists(instance_id) => RpcFailure::Fail(json!({"_tag":"ServerSettingsError", "settingsPath":settings.path().to_string_lossy(), "operation":"create-provider-instance", "providerInstanceId":instance_id})),
                            crate::settings::SettingsUpdateError::Persistence(message) => RpcFailure::Fail(json!({"_tag":"ServerSettingsError", "settingsPath":settings.path().to_string_lossy(), "operation":"write-file", "message":message})),
                            crate::settings::SettingsUpdateError::ManagedSetting(path,organization) => RpcFailure::Fail(json!({"_tag":"ServerSettingsError","settingsPath":settings.path().to_string_lossy(),"operation":"write-managed-setting","managedSetting":path,"managedBy":organization})),
                            crate::settings::SettingsUpdateError::DisallowedProvider(id,label,organization) => RpcFailure::Fail(json!({"_tag":"ServerSettingsError","settingsPath":settings.path().to_string_lossy(),"operation":"use-disallowed-provider","providerInstanceId":id,"providerLabel":label,"managedBy":organization})),
                        }
                    })?;
                    let new_providers = settings.private_snapshot()["secretProviders"].clone();
                    invalidate_changed_secret_providers(&sessions, &old_providers, &new_providers)?;
                    let new_instances = settings.private_snapshot()["providerInstances"].clone();
                    sessions.capture_changed_desktop_instance_environments(&old_instances, &new_instances);
                    if let Ok(mut defaults) = sessions.kiro_defaults.lock() { defaults.retain(|id, _| old_instances.get(id) == new_instances.get(id)); }
                    return Ok(result);
                }
                let result = settings.update_typed(&request.payload["patch"]).map_err(|error|match error {
                    crate::settings::SettingsUpdateError::ManagedSetting(path,organization)=>RpcFailure::Fail(json!({"_tag":"ServerSettingsError","settingsPath":settings.path().to_string_lossy(),"operation":"write-managed-setting","managedSetting":path,"managedBy":organization})),
                    crate::settings::SettingsUpdateError::DisallowedProvider(id,label,organization)=>RpcFailure::Fail(json!({"_tag":"ServerSettingsError","settingsPath":settings.path().to_string_lossy(),"operation":"use-disallowed-provider","providerInstanceId":id,"providerLabel":label,"managedBy":organization})),
                    crate::settings::SettingsUpdateError::Persistence(message)=>RpcFailure::Fail(json!({"_tag":"ServerSettingsError","operation":"write-file","message":message})),
                    _=>failure("Invalid RPC payload"),
                })?;
                let new_providers = settings.private_snapshot()["secretProviders"].clone();
                invalidate_changed_secret_providers(&sessions, &old_providers, &new_providers)?;
                let new_instances = settings.private_snapshot()["providerInstances"].clone();
                sessions.capture_changed_desktop_instance_environments(&old_instances, &new_instances);
                if let Ok(mut defaults) = sessions.kiro_defaults.lock() { defaults.retain(|id, _| old_instances.get(id) == new_instances.get(id)); }
                return Ok(result);
            }
            if matches!(
                request.tag.as_str(),
                "server.upsertKeybinding" | "server.removeKeybinding"
            ) {
                return keybindings.update(&request.payload, request.tag == "server.removeKeybinding").map_err(|detail| RpcFailure::Fail(json!({"_tag":"KeybindingsConfigParseError", "configPath":keybindings.path().to_string_lossy(), "detail":detail})));
            }
            if request.tag == "server.getConfig" || request.tag == "server.refreshProviders" {
                let cwd = client_config["cwd"].as_str().unwrap_or("/").to_owned();
                if request.tag == "server.refreshProviders"
                    && request.payload.get("modelCatalogOnly") == Some(&Value::Bool(true))
                {
                    let state_dir = attachments_dir.parent().map(std::path::Path::to_path_buf);
                    let update_checks = settings
                        .snapshot()
                        .get("enableProviderUpdateChecks")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    let changed = tokio::task::spawn_blocking(move || {
                        crate::provider::claude_capabilities::refresh_model_catalog(
                            state_dir.as_deref(),
                            update_checks,
                        )
                    })
                    .await
                    .unwrap_or(false);
                    if changed {
                        if let Ok(mut guard) = provider_cache.lock() {
                            *guard = None;
                        }
                        let _ = discover_providers(
                            &cwd,
                            settings.path(),
                            &sessions,
                            &provider_cache,
                            true,
                            false,
                        )
                        .await;
                    }
                    return Ok(json!({"providers": []}));
                }
                let instance_id = request
                    .payload
                    .get("instanceId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let req_cwd = request
                    .payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let providers = if request.tag == "server.refreshProviders" {
                    if let (Some(_), Some(target_cwd)) = (instance_id, req_cwd) {
                        if target_cwd == cwd {
                            discover_providers(
                                target_cwd,
                                settings.path(),
                                &sessions,
                                &provider_cache,
                                true,
                                false,
                            )
                            .await
                        } else {
                            discover_providers_uncached(target_cwd, settings.path(), &sessions).await
                        }
                    } else {
                        discover_providers(
                            &cwd,
                            settings.path(),
                            &sessions,
                            &provider_cache,
                            true,
                            false,
                        )
                        .await
                    }
                } else {
                    discover_providers(
                        &cwd,
                        settings.path(),
                        &sessions,
                        &provider_cache,
                        false,
                        false,
                    )
                    .await
                }
                .map_err(|_| failure("Provider discovery failed"))?;
                if request.tag == "server.refreshProviders" {
                    usage_limit_sources.refresh().await;
                    let omit = request.payload.get("omitProviders") == Some(&Value::Bool(true));
                    if omit && (instance_id.is_none() || req_cwd.is_none()) {
                        return Ok(json!({"providers": []}));
                    }
                    if request.payload.get("workspaceSnapshotsOnDemand") != Some(&Value::Bool(true)) {
                        return Ok(json!({"providers": providers}));
                    }
                    let (Some(instance_id), Some(target_cwd)) = (instance_id, req_cwd) else {
                        return Ok(json!({
                            "providers": without_workspace_snapshots(providers, false, false)
                        }));
                    };
                    let catalogs_on_demand = request.payload.get("providerCatalogsOnDemand")
                        == Some(&Value::Bool(true));
                    let machine_catalog =
                        request.payload.get("machineCatalog") == Some(&Value::Bool(true));
                    let filtered: Vec<Value> = providers
                        .into_iter()
                        .filter(|p| p["instanceId"].as_str() == Some(instance_id))
                        .map(|mut provider| {
                            let catalog_on_demand =
                                catalogs_on_demand && supports_snapshot_for_cwd(&provider);
                            let workspace_snapshots = workspace_snapshot_or_catalog(
                                &provider,
                                target_cwd,
                                catalog_on_demand,
                            );
                            let (slash_commands, skills, digest) =
                                if catalog_on_demand && machine_catalog {
                                    let (sc, sk) = machine_catalog_names(&provider);
                                    (sc, sk, Some(machine_catalog_digest(&provider)))
                                } else {
                                    (json!([]), json!([]), None)
                                };
                            if let Some(obj) = provider.as_object_mut() {
                                obj.insert("models".into(), json!([]));
                                obj.insert("slashCommands".into(), slash_commands);
                                obj.insert("skills".into(), skills);
                                if let Some(digest) = digest {
                                    obj.insert("catalogDigest".into(), json!(digest));
                                }
                                obj.insert("workspaceSnapshots".into(), workspace_snapshots);
                            }
                            provider
                        })
                        .collect();
                    return Ok(json!({"providers": filtered}));
                }
                let mut config = client_config;
                config["environment"]["capabilities"]["agentActivityPublishing"] = json!(
                    crate::agent_awareness_relay::read_agent_activity_publishing_active(
                        &auth.replay_dir
                    )
                );
                if let Some(port) = tailscale_serve_port {
                    if let Some(endpoint) = crate::direct_endpoints::discover_tailscale(
                        port,
                        config["environment"]["environmentId"]
                            .as_str()
                            .unwrap_or(""),
                    )
                    .await
                    {
                        if let Some(endpoints) = config["directEndpoints"].as_array_mut() {
                            endpoints.push(endpoint);
                        }
                    }
                }
                config["providers"] = json!(providers);
                config["settings"] = settings.snapshot();
                if let Some(policy) = crate::managed_policy::client_summary().map_err(|_| failure("Invalid managed policy"))? {
                    config["managedPolicy"] = policy;
                }
                let bindings = keybindings.snapshot();
                config["keybindings"] = bindings["keybindings"].clone();
                config["issues"] = bindings["issues"].clone();
                return Ok(config);
            }
            if request.tag == "server.probe" && request.payload.is_object() {
                return Ok(json!({}));
            }
            if request.tag == "server.getHostResources" {
                return tokio::task::spawn_blocking(crate::host_resources::read)
                    .await
                    .map(serde_json::to_value)
                    .map_err(|_| failure("Failed to read host resources"))?
                    .map_err(|_| failure("Failed to encode host resources"));
            }
            if matches!(
                request.tag.as_str(),
                "orchestration.getThreadTitles" | "orchestration.getThreadLinkMetadata"
            ) {
                let ids = request
                    .payload
                    .get("threadIds")
                    .and_then(Value::as_array)
                    .ok_or_else(|| failure("Invalid RPC payload"))?;
                let ids = ids
                    .iter()
                    .map(|id| {
                        id.as_str()
                            .filter(|id| !id.trim().is_empty())
                            .map(|id| id.trim().to_owned())
                    })
                    .collect::<Option<Vec<_>>>()
                    .ok_or_else(|| failure("Invalid RPC payload"))?;
                let message = if request.tag == "orchestration.getThreadTitles" {
                    "Failed to load thread titles"
                } else {
                    "Failed to load thread link metadata"
                };
                let rows = bus.ok_or_else(|| RpcFailure::Fail(json!({"_tag":"OrchestrationV2GetShellSnapshotError","message":message})))?
                    .thread_links(&ids).map_err(|_| RpcFailure::Fail(json!({"_tag":"OrchestrationV2GetShellSnapshotError","message":message})))?;
                let mut result = serde_json::Map::new();
                for (id, title, project_id) in rows {
                    result.insert(
                        id,
                        if request.tag == "orchestration.getThreadTitles" {
                            json!(title)
                        } else {
                            json!({"title":title,"projectId":project_id})
                        },
                    );
                }
                return Ok(Value::Object(result));
            }
            if request.tag == "orchestration.forceStopThread" {
                let thread_id = request
                    .payload
                    .get("threadId")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty())
                    .ok_or_else(|| failure("Invalid RPC payload"))?;
                let run = match request.payload.get("runId") {
                    None => None,
                    Some(Value::String(v)) if !v.trim().is_empty() => Some(v.as_str()),
                    _ => return Err(failure("Invalid RPC payload")),
                };
                let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                let thread_id = thread_id.to_owned();
                let run = run.map(str::to_owned);
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                return tokio::task::spawn_blocking(move || {
                    crate::interrupt_commands::force_stop_thread(
                        &bus,
                        &sessions,
                        &thread_id,
                        run.as_deref(),
                        &now,
                    )
                })
                .await
                .map_err(|_| failure("Force stop worker failed"))?
                .map_err(RpcFailure::Fail);
            }
            if matches!(request.tag.as_str(), "pullRequests.replyToThread" | "pullRequests.setThreadResolution") {
                let resolution = request.tag == "pullRequests.setThreadResolution";
                if !crate::pull_request_thread_write::valid(&request.payload, resolution) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                let result = tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_thread_write::run(projects, &input, resolution).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request thread worker failed"))?;
                if result.is_ok() { pull_request_refreshes.invalidate(&json!({"reference":{}})); }
                return result;
            }
            if matches!(request.tag.as_str(), "pullRequests.reviewerCandidates" | "pullRequests.requestReviewers") {
                let write = request.tag == "pullRequests.requestReviewers";
                if !crate::pull_request_reviewers::valid(&request.payload, write) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                let result = tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_reviewers::run(projects, &input, write).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request reviewers worker failed"))?;
                if write && result.is_ok() { pull_request_refreshes.invalidate(&json!({"reference":{}})); }
                return result;
            }
            if matches!(request.tag.as_str(), "pullRequests.labelCandidates" | "pullRequests.setLabels") {
                let write = request.tag == "pullRequests.setLabels";
                if !crate::pull_request_labels::valid(&request.payload, write) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                let result = tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_labels::run(projects, &input, write).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request labels worker failed"))?;
                if write && result.is_ok() { pull_request_refreshes.invalidate(&json!({"reference":{}})); }
                return result;
            }
            if request.tag == "pullRequests.setReaction" {
                if !crate::pull_request_reaction::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                let result = tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_reaction::run(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request reaction worker failed"))?;
                if result.is_ok() { pull_request_refreshes.invalidate(&json!({"reference":{}})); }
                return result;
            }
            if matches!(request.tag.as_str(), "pullRequests.comment" | "pullRequests.updateComment") {
                let update = request.tag == "pullRequests.updateComment";
                if !crate::pull_request_comment::valid(&request.payload, update) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                let result = tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_comment::run(projects, &input, update).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request comment worker failed"))?;
                if result.is_ok() { pull_request_refreshes.invalidate(&json!({"reference":{}})); }
                return result;
            }
            if request.tag == "pullRequests.submitReview" {
                if !crate::pull_request_submit_review::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                let result = tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_submit_review::run(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request review worker failed"))?;
                if result.is_ok() { pull_request_refreshes.invalidate(&json!({"reference":{}})); }
                return result;
            }
            if request.tag == "pullRequests.runAction" {
                if !crate::pull_request_actions::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                let result = tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_actions::run(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request action worker failed"))?;
                if result.is_ok() { pull_request_refreshes.invalidate(&json!({"reference":{}})); }
                return result;
            }
            if request.tag == "pullRequests.invalidate" {
                if !crate::pull_request_refresh::valid_invalidate(&request.payload) { return Err(failure("Invalid RPC payload")); }
                pull_request_refreshes.invalidate(&request.payload);
                return Ok(Value::Null);
            }
            if request.tag == "pullRequests.reportState" {
                if !crate::pull_request_refresh::valid_report(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    let key = pull_request_refreshes.report(projects.clone(), &input).map_err(RpcFailure::Fail)?;
                    if let (Some(key), Some(bus)) = (key, bus) {
                        pull_request_refreshes.queue_sync(bus, projects, key);
                    }
                    Ok(Value::Null)
                }).await.map_err(|_| failure("Pull request report worker failed"))?;
            }
            if request.tag == "pullRequests.threadComments" {
                let valid_field = |name: &str| request.payload.get(name).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty());
                if !crate::pull_request_links::valid(&request.payload) || !valid_field("threadId") || !valid_field("cursor") { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_thread_comments::read(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request thread comments worker failed"))?;
            }
            if request.tag == "pullRequests.activity" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_activity::read(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request activity worker failed"))?;
            }
            if request.tag == "pullRequests.diffFileContents" {
                let nonempty = |key: &str| request.payload.get(key).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty());
                if !crate::pull_request_links::valid(&request.payload) || !nonempty("oldPath") || !nonempty("newPath") || !matches!(request.payload["changeType"].as_str(), Some("change" | "rename-pure" | "rename-changed" | "new" | "deleted")) || (request.payload.get("commit").is_some() && !nonempty("commit")) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_file_contents::read(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request file contents worker failed"))?;
            }
            if matches!(request.tag.as_str(), "pullRequests.filesViewed" | "pullRequests.setFilesViewed") {
                let write = request.tag == "pullRequests.setFilesViewed";
                if !crate::pull_request_files_viewed::valid(&request.payload, write) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_files_viewed::run(&auth.db, projects, &input, write).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request viewed files worker failed"))?;
            }
            if request.tag == "pullRequests.checks" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_checks::read(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request checks worker failed"))?;
            }
            if request.tag == "pullRequests.preview" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_preview::read(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request preview worker failed"))?;
            }
            if request.tag == "pullRequests.detail" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_detail::read(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request detail worker failed"))?;
            }
            if request.tag == "pullRequests.generateReviewGuide" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let readiness = crate::pull_request_review_guide::ProviderReadiness { sessions, cache: provider_cache, cwd: client_config["cwd"].as_str().unwrap_or("/").to_owned() };
                return crate::pull_request_review_guide::generate(review_guide_runs, auth, settings, readiness, review_guide_worktrees, request.payload).await.map_err(RpcFailure::Fail);
            }
            if request.tag == "pullRequests.reviewGuide" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    let root = projects.iter().find(|(id, _, _)| Some(id.as_str()) == input["projectId"].as_str())
                        .map(|(_, _, root)| root).ok_or_else(|| RpcFailure::Fail(crate::pull_request_review_guide::unidentified()))?;
                    let identity = crate::repository_identity::resolve(root);
                    let key = crate::pull_request_review_guide::key(&input, identity)
                        .ok_or_else(|| RpcFailure::Fail(crate::pull_request_review_guide::unidentified()))?;
                    let guide = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_review_guide::read_stored(&db, &key).map_err(RpcFailure::Fail)?
                    };
                    let detail = crate::pull_request_detail::read(projects, &input).map_err(RpcFailure::Fail)?;
                    Ok(json!({"guide":guide,"run":review_guide_runs.get(&key),"currentHeadSha":detail.get("headSha").cloned().unwrap_or(Value::Null)}))
                }).await.map_err(|_| failure("Pull request review guide worker failed"))?;
            }
            if request.tag == "pullRequests.stack" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_stack::read(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request stack worker failed"))?;
            }
            if request.tag == "pullRequests.summary" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_summary::read(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request summary worker failed"))?;
            }
            if request.tag == "pullRequests.filterOptions" {
                if !crate::pull_request_filter_options::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    Ok(crate::pull_request_filter_options::read(projects, &input))
                }).await.map_err(|_| failure("Pull request filter options worker failed"))?;
            }
            if request.tag == "pullRequests.list" {
                if !crate::pull_request_list::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_list::read(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request list worker failed"))?;
            }
            if request.tag == "pullRequests.listStats" {
                if !crate::pull_request_stats::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    Ok(crate::pull_request_stats::read(projects, &input))
                }).await.map_err(|_| failure("Pull request stats worker failed"))?;
            }
            if request.tag == "pullRequests.routingIdentity" {
                if !crate::pull_request_routing::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let roots = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::project_roots(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_routing::routing_identity(roots, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request routing worker failed"))?;
            }
            if request.tag == "pullRequests.routing" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let projects = {
                        let db = auth.db.lock().map_err(|_| failure("Database unavailable"))?;
                        crate::pull_request_routing::projects(&db).map_err(RpcFailure::Fail)?
                    };
                    crate::pull_request_routing::routing(projects, &input).map_err(RpcFailure::Fail)
                }).await.map_err(|_| failure("Pull request routing worker failed"))?;
            }
            if request.tag == "pullRequests.linkedThreads" {
                if !crate::pull_request_links::valid(&request.payload) { return Err(failure("Invalid RPC payload")); }
                let input = request.payload;
                return tokio::task::spawn_blocking(move || {
                    let operation_error = || RpcFailure::Fail(json!({"_tag":"PullRequestOperationError","operation":"linkedThreads","detail":"Could not load linked threads."}));
                    let root = {
                        let db = auth.db.lock().map_err(|_| operation_error())?;
                        crate::pull_request_links::project_root(&db, &input).map_err(|_| operation_error())?
                    };
                    let identity = root.and_then(|root| crate::repository_identity::resolve(&root));
                    let db = auth.db.lock().map_err(|_| operation_error())?;
                    crate::pull_request_links::linked_threads(&db, &input, identity).map_err(|_| operation_error())
                }).await.map_err(|_| failure("Linked threads worker failed"))?;
            }
            if request.tag == "orchestration.searchThreads" {
                let snapshot = if request.payload.get("olderSettledBefore").is_some() {
                    Some(
                        bus.as_ref()
                            .ok_or_else(|| failure("Orchestration is unavailable"))?
                            .shell_snapshot()
                            .map_err(|_| failure("Failed to load thread search snapshot"))?,
                    )
                } else {
                    None
                };
                let db = auth
                    .db
                    .lock()
                    .map_err(|_| failure("Database unavailable"))?;
                return crate::orchestration_search::search(
                    &db,
                    &request.payload,
                    snapshot.as_ref(),
                )
                .map_err(|message| {
                    RpcFailure::Fail(
                        json!({"_tag":"OrchestrationSearchThreadsError","message":message}),
                    )
                });
            }
            if request.tag != "orchestration.dispatchCommand" {
                return Err(failure(
                    "RPC method is not implemented or has an invalid payload",
                ));
            }
            let payload = &request.payload;
            let required = |key: &str| {
                payload
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
            };
            if required("type") == Some("thread.visit") {
                let invalid = || failure("Unsupported or invalid orchestration command");
                let command_id = required("commandId").ok_or_else(invalid)?;
                let thread_id = required("threadId").ok_or_else(invalid)?;
                let visited_at = required("visitedAt").ok_or_else(invalid)?;
                let opened = match payload.get("opened") {
                    None => false,
                    Some(Value::Bool(v)) => *v,
                    _ => return Err(invalid()),
                };
                let query = match payload.get("searchQuery") {
                    None => None,
                    Some(Value::String(v)) if v.encode_utf16().count() <= 200 => Some(v.as_str()),
                    _ => return Err(invalid()),
                };
                let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                let now: String = auth
                    .db
                    .lock()
                    .map_err(|_| failure("Database unavailable"))?
                    .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                        r.get(0)
                    })
                    .map_err(|_| failure("Database unavailable"))?;
                let result = crate::thread_visit::dispatch(
                    &bus, command_id, thread_id, visited_at, opened, query, &now,
                )
                .map_err(|_| failure("Failed to dispatch orchestration V2 command"))?;
                if result.receipt.status == "rejected" {
                    let detail = result
                        .receipt
                        .error
                        .unwrap_or_else(|| "Command rejected".into());
                    return Err(RpcFailure::Fail(
                        json!({"_tag":"OrchestrationV2DispatchCommandError","commandId":command_id,"commandType":"thread.visit","message":detail,"detail":detail}),
                    ));
                }
                return Ok(json!({"sequence":result.receipt.result_sequence}));
            }
            if required("type") == Some("thread.merge_back") {
                let invalid = || failure("Unsupported or invalid orchestration command");
                let command_id = required("commandId").ok_or_else(invalid)?;
                let source = required("sourceThreadId").ok_or_else(invalid)?;
                let target = required("targetThreadId").ok_or_else(invalid)?;
                let point = payload
                    .get("sourcePoint")
                    .filter(|p| match p["type"].as_str() {
                        Some("latest_stable") => true,
                        Some("run") => p["runId"].as_str().is_some_and(|s| !s.trim().is_empty()),
                        Some("checkpoint") => p["checkpointId"]
                            .as_str()
                            .is_some_and(|s| !s.trim().is_empty()),
                        _ => false,
                    })
                    .ok_or_else(invalid)?;
                let created_by = required("createdBy")
                    .filter(|v| ["user", "agent", "system"].contains(v))
                    .ok_or_else(invalid)?;
                required("creationSource")
                    .filter(|v| ["web", "mobile", "mcp", "provider", "server"].contains(v))
                    .ok_or_else(invalid)?;
                let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let result = crate::merge_commands::dispatch(
                    &bus,
                    crate::merge_commands::Merge {
                        command_id,
                        source,
                        target,
                        source_point: point,
                        created_by,
                    },
                    &now,
                )
                .map_err(|_| failure("Failed to dispatch orchestration V2 command"))?;
                if result.receipt.status == "rejected" {
                    let detail = result
                        .receipt
                        .error
                        .unwrap_or_else(|| "Command rejected".into());
                    return Err(RpcFailure::Fail(
                        json!({"_tag":"OrchestrationV2DispatchCommandError","commandId":command_id,"commandType":"thread.merge_back","message":detail,"detail":detail}),
                    ));
                }
                return Ok(json!({"sequence":result.receipt.result_sequence}));
            }
            if required("type") == Some("thread.fork") {
                let invalid = || failure("Unsupported or invalid orchestration command");
                let command_id = required("commandId").ok_or_else(invalid)?;
                let source_thread_id = required("sourceThreadId").ok_or_else(invalid)?;
                let target_thread_id = required("targetThreadId").ok_or_else(invalid)?;
                let point = payload
                    .get("sourcePoint")
                    .filter(|p| match p["type"].as_str() {
                        Some("latest_stable") => true,
                        Some("run") => p["runId"].as_str().is_some_and(|s| !s.trim().is_empty()),
                        Some("checkpoint") => p["checkpointId"]
                            .as_str()
                            .is_some_and(|s| !s.trim().is_empty()),
                        _ => false,
                    })
                    .ok_or_else(invalid)?;
                let created_by = required("createdBy")
                    .filter(|v| ["user", "agent", "system"].contains(v))
                    .ok_or_else(invalid)?;
                let creation_source = payload
                    .get("creationSource")
                    .filter(|v| {
                        v.as_str().is_some_and(|v| {
                            ["web", "mobile", "mcp", "provider", "server"].contains(&v)
                        })
                    })
                    .ok_or_else(invalid)?;
                let side_chat = match payload.get("sideChat") {
                    None => false,
                    Some(Value::Bool(v)) => *v,
                    _ => return Err(invalid()),
                };
                let title = match payload.get("title") {
                    None => None,
                    Some(Value::String(v)) if !v.trim().is_empty() => Some(v.as_str()),
                    _ => return Err(invalid()),
                };
                let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                let now: String = auth
                    .db
                    .lock()
                    .map_err(|_| failure("Database unavailable"))?
                    .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                        r.get(0)
                    })
                    .map_err(|_| failure("Database unavailable"))?;
                let ids = [
                    uuid::Uuid::new_v4().to_string(),
                    uuid::Uuid::new_v4().to_string(),
                ];
                let transfer_id = uuid::Uuid::new_v4().to_string();
                let result = crate::fork_commands::fork_thread_ordered(
                    &bus,
                    crate::fork_commands::ForkThread {
                        command_id,
                        source_thread_id,
                        target_thread_id,
                        source_point: point,
                        title,
                        side_chat,
                        created_by,
                        creation_source,
                    },
                    [&ids[0], &ids[1]],
                    &transfer_id,
                    &now,
                )
                .map_err(|_| failure("Failed to dispatch orchestration V2 command"))?;
                if result.receipt.status == "rejected" {
                    let detail = result
                        .receipt
                        .error
                        .unwrap_or_else(|| "Command rejected".into());
                    return Err(RpcFailure::Fail(
                        json!({"_tag":"OrchestrationV2DispatchCommandError","commandId":command_id,"commandType":"thread.fork","message":detail,"detail":detail}),
                    ));
                }
                return Ok(json!({"sequence":result.receipt.result_sequence}));
            }
            if matches!(
                required("type"),
                Some(
                    "message.dispatch"
                        | "prepared-run.release"
                        | "prepared-run.progress"
                        | "prepared-run.fail"
                        | "prepared-run.retry"
                        | "queue.resume"
                        | "queued-run.start"
                        | "queued-run.reorder"
                        | "queued-run.cancel"
                        | "queued-run.edit"
                        | "queued-message.promote-to-steer"
                        | "runtime-request.respond"
                        | "thread.user-input.dismiss"
                        | "run.interrupt"
                        | "thread.stop"
                        | "checkpoint.rollback"
                        | "thread.archive"
                        | "thread.unarchive"
                        | "thread.settle"
                        | "thread.unsettle"
                        | "thread.mark-unread"
                        | "thread.snooze"
                        | "thread.unsnooze"
                        | "thread.pin"
                        | "thread.unpin"
                        | "thread.pin.reorder"
                        | "thread.active.reorder"
                        | "thread.tag.set"
                        | "thread.auto-settle.set"
                        | "thread.metadata.update"
                        | "thread.title.regeneration.complete"
                        | "thread.delete"
                        | "thread.runtime-mode.set"
                        | "thread.interaction-mode.set"
                        | "thread.model-selection.set"
                        | "provider.switch"
                )
            ) {
                let invalid = || failure("Unsupported or invalid orchestration command");
                let command_type = required("type").ok_or_else(invalid)?;
                let command_id = required("commandId").ok_or_else(invalid)?;
                let thread_id = required("threadId").ok_or_else(invalid)?;
                let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                let now: String = auth
                    .db
                    .lock()
                    .map_err(|_| failure("Database unavailable"))?
                    .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                        r.get(0)
                    })
                    .map_err(|_| failure("Database unavailable"))?;
                let result = if command_type == "message.dispatch" {
                    crate::legacy_transcript::ensure_transcript(&bus, thread_id).map_err(|_| failure("Unable to hydrate migrated thread transcript"))?;
                    let message_id = required("messageId").ok_or_else(invalid)?;
                    let text = payload.get("text").and_then(Value::as_str).ok_or_else(invalid)?;
                    let attachments = payload.get("attachments").and_then(Value::as_array).ok_or_else(invalid)?;
                    let source = required("creationSource").filter(|v| ["web", "mobile", "mcp", "provider", "server"].contains(v)).ok_or_else(invalid)?;
                    required("createdBy").filter(|v| ["user", "agent", "system"].contains(v)).ok_or_else(invalid)?;
                    let mode = payload.pointer("/dispatchMode/type").and_then(Value::as_str).ok_or_else(invalid)?;
                    // These features require transport attachment claiming or decider paths not yet implemented.
                    if !matches!(mode, "queue_after_active" | "start_immediately" | "steer_active" | "restart_active" | "defer_start")
                        || ["guestMessageId", "sourcePlanRef", "restartContinuationOfRunId", "usageLimitContinuationOfRunId", "manualContinuationOfRunId", "steerFollowUpOfRunId", "steerFollowUpAfterRunOrdinal", "usageLimitRecoveryRequestId", "delegatedCompletion", "titleSeed"].iter().any(|k| payload.get(*k).is_some()) {
                        return Err(failure("Unsupported message dispatch options"));
                    }
                    let selection = if let Some(value) = payload.get("modelSelection") {
                        let obj = value.as_object().ok_or_else(invalid)?;
                        let instance = obj.get("instanceId").or_else(|| obj.get("provider")).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty() && v.len() <= 64 && v.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')).ok_or_else(invalid)?;
                        let model = obj.get("model").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).ok_or_else(invalid)?;
                        let snapshot = settings.snapshot();
                        let driver = snapshot["providerInstances"][instance]["driver"].as_str().unwrap_or(instance);
                        if driver == "codex" {
                            crate::provider::instance::resolve_codex_identity(Some(settings.path()), instance, crate::provider::CodexLaunch::default()).map_err(|e| failure(&e))?;
                        } else if snapshot["providerInstances"][instance]["enabled"] == false || snapshot["providerInstances"][instance]["config"]["enabled"] == false {
                            return Err(failure("Provider instance is disabled"));
                        }
                        let mut normalized = json!({"instanceId":instance,"model":model});
                        if let Some(options) = obj.get("options") { normalized["options"] = normalize_provider_options(options).ok_or_else(invalid)?; }
                        Some(normalized)
                    } else { None };
                    // ACP adapters with unreadable configured credentials are unavailable at dispatch.
                    let selected_instance = if let Some(instance) = selection.as_ref().and_then(|v| v["instanceId"].as_str()) {
                        Some(instance.to_owned())
                    } else {
                        bus.commit(|tx| {
                            let instance: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.modelSelection.instanceId') FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread_id], |row| row.get(0)).optional()?.flatten();
                            Ok((instance, vec![]))
                        }).map_err(|_| failure("Database unavailable"))?
                    };
                    if let Some(instance) = selected_instance.as_deref() {
                        let snapshot = crate::provider::session_registry::read_provider_settings(Some(settings.path())).map_err(|e| failure(&e))?;
                        let entry = &snapshot["providerInstances"][instance];
                        let live_thread = bus.commit(|tx| {
                            let selected = crate::conversation_provider::select(tx, thread_id)?;
                            let matching = if let Some(ref provider_thread) = selected { tx.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?1 AND provider_instance_id=?2)", rusqlite::params![provider_thread, instance], |row| row.get::<_, bool>(0))? } else { false };
                            Ok((selected.filter(|_| matching), vec![]))
                        }).map_err(|_| failure("Database unavailable"))?;
                        let attached = live_thread.as_deref().is_some_and(|id| crate::provider::acp_executor::has_provider_thread(id, thread_id));
                        if !attached && matches!(entry["driver"].as_str(), Some("fx" | "grok" | "kiro" | "acpRegistry" | "antigravity")) {
                            if let Some(vars) = entry["environment"].as_array() {
                                for reference in vars.iter().filter_map(|value| value.get("secret").filter(|value| !value.is_null())) {
                                    if crate::mcp_secret::resolve_reference(&snapshot, reference).await.is_none() {
                                        let detail = format!("No orchestration provider adapter is registered for {instance}.");
                                        return Err(RpcFailure::Fail(json!({"_tag":"OrchestrationV2DispatchCommandError","commandId":command_id,"commandType":"message.dispatch","message":detail,"detail":detail,"cause":{"name":"OrchestratorProviderAdapterError","message":format!("Provider adapter failed while dispatching orchestration command {command_id}."),"cause":{"name":"ProviderAdapterRegistryLookupError","message":detail}}})));
                                    }
                                }
                            }
                        }
                    }
                    let fresh = match payload.get("freshContext") {None=>false,Some(Value::Bool(v))=>*v,_=>return Err(invalid())};
                    let workspace_strategy = if mode == "defer_start" {
                        let strategy = payload.pointer("/dispatchMode/workspaceStrategy");
                        if let Some(value) = strategy {
                            let obj = value.as_object().ok_or_else(invalid)?;
                            let nonempty = |k: &str| value.get(k).and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty());
                            let valid = match value["type"].as_str() {
                                Some("root") => obj.keys().all(|k| ["type","branch"].contains(&k.as_str())),
                                Some("existing_worktree") => nonempty("worktreePath") && obj.keys().all(|k| ["type","branch","worktreePath"].contains(&k.as_str())),
                                Some("worktree") => nonempty("baseRef") && value.get("startFromOrigin").is_none_or(Value::is_boolean) && obj.keys().all(|k| ["type","branch","baseRef","startFromOrigin"].contains(&k.as_str())),
                                _ => false,
                            };
                            if !valid || (value.get("branch").is_some() && !nonempty("branch")) { return Err(invalid()); }
                        }
                        strategy
                    } else { None };
                    let intent = match payload.get("deliveryIntent") {
                        None => None,
                        Some(Value::String(s)) if s == "auto" => Some(s.as_str()),
                        Some(_) => return Err(failure("Unsupported message dispatch options")),
                    };
                    let cwd: Option<String> = bus.commit(|tx| {
                        let cwd = tx.query_row("SELECT COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root) FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1", [thread_id], |r| r.get(0)).optional()?;
                        Ok((cwd, vec![]))
                    }).map_err(|_| failure("Database unavailable"))?;
                    // The decider returns the domain rejection for an unknown thread.
                    let cwd = cwd.unwrap_or_default();
                    let target = if matches!(mode, "steer_active" | "restart_active") && intent.is_none() {
                        Some(payload.pointer("/dispatchMode/targetRunId").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).ok_or_else(invalid)?)
                    } else { None };
                    let mut message_context=payload.get("context").map(crate::composer_context::normalize).transpose().map_err(|_|invalid())?;
                    if let Some(context)=message_context.as_mut().and_then(Value::as_object_mut){context.remove("guest");}
                    let parsed: Vec<crate::attachment_store::Attachment> = serde_json::from_value(Value::Array(attachments.clone())).map_err(|_| invalid())?;
                    let (claimed, claimed_paths) = crate::attachment_store::claim(&attachments_dir, thread_id, &parsed).map_err(|e| failure(&e))?;
                    let claimed_values: Vec<Value> = claimed.iter().map(|a| serde_json::to_value(a).expect("attachment serialization")).collect();
                    if let Some(records)=message_context.as_mut().and_then(|context|context["records"].as_array_mut()) {for record in records {if matches!(record["kind"].as_str(),Some("image"|"file")){if let Some(index)=record["attachmentId"].as_str().and_then(|id|parsed.iter().position(|a|a.id==id)){record["attachmentId"]=json!(claimed[index].id);}}}}

                    let instance = if let Some(selection) = selection.as_ref() {
                        selection["instanceId"].as_str().map(str::to_owned)
                    } else {
                        bus.commit(|tx| {
                            let instance: Option<String> = tx.query_row("SELECT json_extract(payload_json,'$.providerInstanceId') FROM orchestration_v2_projection_threads WHERE thread_id=?1", [thread_id], |r|r.get(0)).optional()?.flatten();
                            Ok((instance,vec![]))
                        }).map_err(|_| failure("Database unavailable"))?
                    };
                    let snapshot = settings.snapshot();
                    let instance = instance.as_deref().unwrap_or("codex");
                    let driver = snapshot["providerInstances"][instance]["driver"].as_str().unwrap_or(instance);
                    let command = crate::message_commands::DispatchMessage { context: message_context.as_ref(),
                        command_id, thread_id, message_id, text, attachments: &claimed_values, creation_source: source, cwd: &cwd, driver,
                    };
                    let dispatch = if let Some(selection) = selection.as_ref().filter(|_| fresh || mode == "defer_start") {
                        crate::message_commands::dispatch_selected_context(&bus, command, &now, fresh, if mode == "defer_start" { Some(workspace_strategy) } else { None }, Some(&sessions), selection)
                    } else if fresh && mode == "defer_start" {
                        crate::message_commands::dispatch_fresh_deferred_message(&bus, command, &now, workspace_strategy, Some(&sessions))
                    } else if fresh {
                        crate::message_commands::dispatch_fresh_message(&bus, command, &now, Some(&sessions))
                    } else if intent.is_some() {
                        crate::message_commands::dispatch_auto_selected(&bus, command, &now, selection.as_ref())
                    } else if mode == "steer_active" {
                        if let Some(selection) = selection.as_ref() { crate::message_commands::steer_selected(&bus, command, target.expect("validated target"), &now, selection, false) } else { crate::message_commands::steer_message(&bus, command, target.expect("validated target"), &now) }
                    } else if mode == "restart_active" {
                        if let Some(selection) = selection.as_ref() { crate::message_commands::steer_selected(&bus, command, target.expect("validated target"), &now, selection, true) } else { crate::message_commands::restart_message(&bus, command, target.expect("validated target"), &now) }
                    } else if mode == "defer_start" {
                        crate::message_commands::dispatch_deferred_message(&bus, command, &now, workspace_strategy)
                    } else if let Some(selection) = selection.as_ref() {
                        crate::message_commands::dispatch_with_selection(&bus, command, &now, mode == "start_immediately", selection)
                    } else {
                        crate::message_commands::dispatch_message_with_mode(&bus, command, &now, mode == "start_immediately")
                    };
                    // A replay can return an existing accepted receipt without using the new copies.
                    // Keep copies only when the committed message actually references them.
                    let retained = dispatch.as_ref().is_ok_and(|r| r.receipt.status != "rejected") && bus.commit(|tx| {
                        let stored: Option<String> = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?1 AND thread_id=?2", [message_id, thread_id], |r| r.get(0)).optional()?;
                        let matches = stored.and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.get("attachments").cloned()).is_some_and(|v| v == Value::Array(claimed_values.clone()));
                        Ok((matches, vec![]))
                    }).unwrap_or(true);
                    if !retained { crate::attachment_store::release(&claimed_paths); }
                    dispatch
                } else if matches!(command_type, "prepared-run.release" | "prepared-run.progress" | "prepared-run.fail" | "prepared-run.retry") {
                    required("runId").ok_or_else(invalid)?;
                    if command_type == "prepared-run.progress" && !matches!(payload.get("phase").and_then(Value::as_str), Some("worktree" | "setup")) {return Err(invalid());}
                    if command_type == "prepared-run.fail" {
                        let f = payload.get("failure").and_then(Value::as_object).ok_or_else(invalid)?;
                        let valid = f.get("class").and_then(Value::as_str).is_some_and(|v| ["usage_limit","provider_error","transport_error","permission_error","validation_error","unknown"].contains(&v)) && f.get("message").and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty() && v.encode_utf16().count() <= 4096) && f.get("code").is_some_and(|v| v.is_null() || v.as_str().is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 128)) && f.get("retryable").is_some_and(|v| v.is_null() || v.is_boolean()) && f.get("resetAt").is_none_or(|v| v.is_null() || v.is_string());
                        if !valid {return Err(invalid());}
                    }
                    let cwd: Option<String> = bus.commit(|tx| { let cwd=tx.query_row("SELECT COALESCE(json_extract(t.payload_json,'$.worktreePath'),p.workspace_root) FROM orchestration_v2_projection_threads t LEFT JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=?1",[thread_id],|r|r.get(0)).optional()?.flatten(); Ok((cwd,vec![])) }).map_err(|_| failure("Database unavailable"))?;
                    let cwd = cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/")).to_string_lossy().into_owned());
                    crate::message_commands::prepared_run_command(&bus,payload,&cwd,&now)
                } else if command_type == "queued-message.promote-to-steer" {
                    let queued = required("queuedRunId").ok_or_else(invalid)?;
                    let target = required("targetRunId").ok_or_else(invalid)?;
                    crate::queue_steer::dispatch(&bus, command_id, thread_id, queued, target, &now).map_err(crate::message_commands::DispatchError::from)
                } else if matches!(command_type,"queued-run.cancel"|"queued-run.edit") {
                    let run_id=required("runId").ok_or_else(invalid)?;
                    let text=if command_type=="queued-run.edit" {Some(payload.get("text").and_then(Value::as_str).ok_or_else(invalid)?)}else{None};
                    let context=match payload.get("context") {None=>None,Some(v) if v.is_object()=>Some(v),_=>return Err(invalid())};
                    let (claimed,paths)=match payload.get("attachments") {
                        None=>(None,vec![]),
                        Some(v) if command_type=="queued-run.edit"=>{
                            let parsed:Vec<crate::attachment_store::Attachment>=serde_json::from_value(v.clone()).map_err(|_|invalid())?;
                            let (items,paths)=crate::attachment_store::claim(&attachments_dir,thread_id,&parsed).map_err(|e|failure(&e))?;
                            (Some(json!(items)),paths)
                        },
                        _=>return Err(invalid()),
                    };
                    let op=if let Some(text)=text {crate::queue_ops::QueueOp::Edit{text,attachments:claimed.as_ref(),context}}else{crate::queue_ops::QueueOp::Cancel};
                    let result=crate::queue_ops::dispatch(&bus,command_id,thread_id,run_id,op,&now).map_err(crate::message_commands::DispatchError::from);
                    let keep=result.as_ref().is_ok_and(|r|r.receipt.status!="rejected") && claimed.as_ref().is_some_and(|claimed|bus.commit(|tx| {let stored:Option<String>=tx.query_row("SELECT m.payload_json FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_messages m ON m.message_id=json_extract(r.payload_json,'$.userMessageId') WHERE r.thread_id=?1 AND r.run_id=?2",rusqlite::params![thread_id,run_id],|r|r.get(0)).optional()?; Ok((stored.and_then(|s|serde_json::from_str::<Value>(&s).ok()).is_some_and(|v|v["attachments"]==*claimed),vec![]))}).unwrap_or(true));
                    if !keep {crate::attachment_store::release(&paths);}
                    result
                } else if command_type == "queued-run.reorder" {
                    let run_id=required("runId").ok_or_else(invalid)?;
                    let before=match payload.get("beforeRunId") {Some(Value::Null)=>None,Some(Value::String(v)) if !v.trim().is_empty()=>Some(v.as_str()),_=>return Err(invalid())};
                    crate::queue_reorder::dispatch(&bus,command_id,thread_id,run_id,before,&now).map_err(crate::message_commands::DispatchError::from)
                } else if command_type == "queue.resume" || command_type == "queued-run.start" {
                    let selected = if command_type == "queued-run.start" { Some(required("runId").ok_or_else(invalid)?) } else { None };
                    crate::queue_promotion::resume(&bus, command_id, thread_id, selected, &now)
                } else if command_type == "checkpoint.rollback" {
                    let checkpoint_id = required("checkpointId").ok_or_else(invalid)?;
                    let scope_id = required("scopeId").ok_or_else(invalid)?;
                    let restore_files = match payload.get("restoreFiles") { None => None, Some(Value::Bool(v)) => Some(*v), _ => return Err(invalid()) };
                    crate::rollback_commands::admit(&bus, crate::rollback_commands::RollbackCommand { command_id, thread_id, checkpoint_id, scope_id, restore_files }, &now)
                } else if command_type == "run.interrupt" {
                    let run_id = required("runId").ok_or_else(invalid)?;
                    let reason = match payload.get("reason") {
                        None => None,
                        Some(Value::String(reason)) => Some(reason.as_str()),
                        _ => return Err(invalid()),
                    };
                    let hold_queue = match payload.get("holdQueue") {
                        None => false,
                        Some(Value::Bool(value)) => *value,
                        _ => return Err(invalid()),
                    };
                    crate::interrupt_commands::interrupt_run(&bus, &sessions, command_id, thread_id, run_id, reason, hold_queue, &now)
                } else if command_type == "thread.stop" {
                    let reason = match payload.get("reason") {None => None, Some(Value::String(reason)) => Some(reason.as_str()), _ => return Err(invalid())};
                    let stop_delegated = match payload.get("stopDelegatedTasks") {None => true, Some(Value::Bool(value)) => *value, _ => return Err(invalid())};
                    crate::interrupt_commands::stop_thread(&bus, &sessions, command_id, thread_id, reason, stop_delegated, &now)
                } else if command_type == "thread.user-input.dismiss" {
                    let request_id = required("requestId").ok_or_else(invalid)?;
                    crate::thread_question_dismiss::dispatch(&bus, command_id, thread_id, request_id, &now).map_err(crate::message_commands::DispatchError::from)
                } else if command_type == "thread.mark-unread" {
                    crate::thread_visit::mark_unread(&bus, command_id, thread_id, &now).map_err(crate::message_commands::DispatchError::from)
                } else if command_type == "thread.metadata.update" {
                    if !crate::thread_metadata::validate(payload) { return Err(invalid()); }
                    crate::thread_metadata::dispatch(&bus, command_id, thread_id, payload, &now).map_err(crate::message_commands::DispatchError::from)
                } else if command_type == "thread.title.regeneration.complete" {
                    if !crate::thread_title_command::valid(payload) { return Err(invalid()); }
                    crate::thread_title_command::dispatch(&bus,command_id,thread_id,payload,&now).map_err(crate::message_commands::DispatchError::from)
                } else if command_type == "thread.delete" {
                    let only_if_unused=match payload.get("onlyIfUnused") {None=>false,Some(Value::Bool(v))=>*v,_=>return Err(invalid())};
                    crate::thread_deletion::dispatch(&bus,command_id,thread_id,only_if_unused,&now).map_err(crate::message_commands::DispatchError::from)
                } else if matches!(command_type, "thread.runtime-mode.set" | "thread.interaction-mode.set") {
                    let mode = if command_type == "thread.runtime-mode.set" { crate::thread_modes::Mode::Runtime(required("runtimeMode").ok_or_else(invalid)?) } else { crate::thread_modes::Mode::Interaction(required("interactionMode").ok_or_else(invalid)?) };
                    if !crate::thread_modes::valid(mode) { return Err(invalid()); }
                    if let crate::thread_modes::Mode::Runtime(value)=mode {crate::managed_policy::check_runtime_mode(value).map_err(|e|RpcFailure::Fail(json!({"_tag":"OrchestrationV2DispatchCommandError","commandId":command_id,"commandType":command_type,"message":e,"detail":e,"cause":{"name":"OrchestratorRuntimeModeAboveCeilingError","message":e}})))?;}
                    crate::thread_modes::dispatch(&bus,command_id,thread_id,mode,&now,|id,_| sessions.has_pending_background_work(id).map_err(|_| ())).map_err(crate::message_commands::DispatchError::from)
                } else if matches!(command_type, "thread.model-selection.set" | "provider.switch") {
                    let selection = payload.get("modelSelection").and_then(Value::as_object).ok_or_else(invalid)?;
                    let instance = selection.get("instanceId").or_else(|| selection.get("provider")).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty() && v.len() <= 64 && v.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')).ok_or_else(invalid)?;
                    let model = selection.get("model").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).ok_or_else(invalid)?;
                    let mut normalized = json!({"instanceId":instance,"model":model});
                    if let Some(options) = selection.get("options") { normalized["options"] = normalize_provider_options(options).ok_or_else(invalid)?; }
                    crate::provider_selection::dispatch(&bus, command_id, thread_id, &normalized, command_type == "provider.switch", &now, |tx, thread| crate::provider_selection::codex_decision(tx, thread, &normalized, settings.path(), &sessions)).map_err(crate::message_commands::DispatchError::from)
                } else if matches!(command_type, "thread.snooze" | "thread.unsnooze" | "thread.pin" | "thread.unpin" | "thread.pin.reorder" | "thread.active.reorder" | "thread.tag.set" | "thread.auto-settle.set") {
                    let trimmed = |key: &str| payload.get(key).and_then(Value::as_str).map(str::trim).filter(|s|!s.is_empty());
                    let command = match command_type {
                        "thread.snooze" => crate::thread_controls::Control::Snooze { until: trimmed("snoozedUntil").ok_or_else(invalid)? },
                        "thread.unsnooze" => { if payload.get("reason") != Some(&json!("user")) { return Err(invalid()); } crate::thread_controls::Control::Unsnooze },
                        "thread.pin" => { let order_key = match payload.get("orderKey") { None => None, Some(_) => Some(trimmed("orderKey").ok_or_else(invalid)?) }; crate::thread_controls::Control::Pin {order_key} },
                        "thread.unpin" => crate::thread_controls::Control::Unpin,
                        "thread.pin.reorder" => crate::thread_controls::Control::PinReorder {order_key:trimmed("orderKey").ok_or_else(invalid)?},
                        "thread.active.reorder" => crate::thread_controls::Control::ActiveReorder {order_key:trimmed("orderKey").ok_or_else(invalid)?},
                        "thread.auto-settle.set" => crate::thread_controls::Control::AutoSettle {enabled:payload.get("enabled").and_then(Value::as_bool).ok_or_else(invalid)?},
                        _ => { let tag=trimmed("tag").filter(|s|s.encode_utf16().count()<=64 && !s.chars().any(char::is_control)).ok_or_else(invalid)?; let tagged=payload.get("tagged").and_then(Value::as_bool).ok_or_else(invalid)?; crate::thread_controls::Control::Tag{tag,tagged} }
                    };
                    crate::thread_controls::dispatch(&bus,command_id,thread_id,command,&now).map_err(crate::message_commands::DispatchError::from)
                } else if matches!(command_type, "thread.archive" | "thread.unarchive" | "thread.settle" | "thread.unsettle") {
                    let command = match command_type {
                        "thread.archive" => crate::thread_lifecycle::Lifecycle::Archive,
                        "thread.unarchive" => crate::thread_lifecycle::Lifecycle::Unarchive,
                        "thread.unsettle" => {
                            if payload.get("reason") != Some(&json!("user")) { return Err(invalid()); }
                            crate::thread_lifecycle::Lifecycle::Unsettle
                        }
                        _ => {
                            let expected_latest_run_id = match payload.get("expectedLatestRunId") { None => None, Some(Value::String(s)) if !s.trim().is_empty() => Some(s.as_str()), _ => return Err(invalid()) };
                            let settled_at = match payload.get("settledAt") { None => None, Some(Value::String(s)) if chrono::DateTime::parse_from_rfc3339(s).is_ok() => Some(s.as_str()), _ => return Err(invalid()) };
                            crate::thread_lifecycle::Lifecycle::Settle { expected_latest_run_id, settled_at }
                        }
                    };
                    crate::thread_lifecycle::dispatch(&bus, command_id, thread_id, command, &now).map_err(crate::message_commands::DispatchError::from)
                } else {
                    let request_id = required("requestId").ok_or_else(invalid)?;
                    let decision = match payload.get("decision") {
                        None => None,
                        Some(Value::String(v)) if ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"].contains(&v.as_str()) => Some(v.as_str()),
                        _ => return Err(invalid()),
                    };
                    let answers = match payload.get("answers") { None => None, Some(v) if v.is_object() => Some(v), _ => return Err(invalid()) };
                    if payload.get("feedback").is_some() {
                        return Err(failure("Unsupported runtime response options"));
                    }
                    let (effective_answers, claimed_by_question_id, claimed_paths) =
                        match payload.get("attachmentsByQuestionId") {
                            None => (answers.cloned(), None, Vec::new()),
                            Some(raw) => {
                                let (updated_answers, claimed_map, paths) =
                                    prepare_question_attachments(
                                        &attachments_dir,
                                        thread_id,
                                        answers,
                                        raw,
                                    )?;
                                (Some(updated_answers), Some(claimed_map), paths)
                            }
                        };
                    let dispatch = crate::provider::codex_requests::respond_command_with_settings_and_attachments(
                        &bus,
                        command_id,
                        thread_id,
                        request_id,
                        decision,
                        effective_answers.as_ref(),
                        claimed_by_question_id.as_ref(),
                        &now,
                        &settings,
                    );
                    if !claimed_paths.is_empty() {
                        let retained = dispatch.as_ref().is_ok_and(|r| r.receipt.status != "rejected")
                            && claimed_by_question_id.as_ref().is_some_and(|claimed| {
                                bus.commit(|tx| {
                                    let stored: Option<String> = tx
                                        .query_row(
                                            "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type='user_input_request' AND json_extract(payload_json,'$.requestId')=?2 LIMIT 1",
                                            rusqlite::params![thread_id, request_id],
                                            |r| r.get(0),
                                        )
                                        .optional()?;
                                    let matches = stored
                                        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                                        .and_then(|v| v.pointer("/questionAnswer/attachmentsByQuestionId").cloned())
                                        .is_some_and(|v| v == *claimed);
                                    Ok((matches, vec![]))
                                })
                                .unwrap_or(true)
                            });
                        if !retained {
                            crate::attachment_store::release(&claimed_paths);
                        }
                    }
                    dispatch
                }.map_err(|_| failure("Failed to dispatch orchestration V2 command"))?;
                if result.receipt.status == "rejected" {
                    let detail = result
                        .receipt
                        .error
                        .unwrap_or_else(|| "Failed to dispatch orchestration V2 command".into());
                    return Err(RpcFailure::Fail(
                        json!({"_tag":"OrchestrationV2DispatchCommandError","commandId":command_id,"commandType":command_type,"message":detail,"detail":detail}),
                    ));
                }
                return Ok(json!({"sequence":result.receipt.result_sequence}));
            }
            if required("type") == Some("thread.create") {
                let invalid = || failure("Unsupported or invalid orchestration command");
                let command_id = required("commandId").ok_or_else(invalid)?;
                let thread_id = required("threadId").ok_or_else(invalid)?;
                let project_id = required("projectId").ok_or_else(invalid)?;
                if let Some(message)=clones.blocked(project_id){return Err(RpcFailure::Fail(json!({"_tag":"OrchestrationDispatchCommandError","message":message})));}
                let title = required("title").ok_or_else(invalid)?.trim();
                let created_by = required("createdBy")
                    .filter(|v| ["user", "agent", "system"].contains(v))
                    .ok_or_else(invalid)?;
                let _ = created_by; // Client provenance is validated but always stamped as user.
                let source = required("creationSource")
                    .filter(|v| ["web", "mobile", "mcp", "provider", "server"].contains(v))
                    .ok_or_else(invalid)?;
                let runtime_mode = required("runtimeMode")
                    .filter(|v| {
                        [
                            "approval-required",
                            "auto-accept-edits",
                            "auto",
                            "full-access",
                        ]
                        .contains(v)
                    })
                    .ok_or_else(invalid)?;
                crate::managed_policy::check_runtime_mode(runtime_mode).map_err(|e|RpcFailure::Fail(json!({"_tag":"OrchestrationV2DispatchCommandError","commandId":command_id,"commandType":"thread.create","message":e,"detail":e,"cause":{"name":"OrchestratorRuntimeModeAboveCeilingError","message":e}})))?;
                let interaction_mode = required("interactionMode")
                    .filter(|v| ["default", "plan"].contains(v))
                    .ok_or_else(invalid)?;
                let nullable = |key: &str| -> Result<Option<&str>, RpcFailure> {
                    match payload.get(key) {
                        Some(Value::Null) => Ok(None),
                        Some(Value::String(value)) if !value.trim().is_empty() => {
                            Ok(Some(value.trim()))
                        }
                        _ => Err(invalid()),
                    }
                };
                let branch = nullable("branch")?;
                let worktree_path = nullable("worktreePath")?;
                let mut imported = payload.get("importedNativeThread").cloned();
                if let Some(imported) = imported.as_mut() {
                    let reference = &imported["ref"];
                    let valid_string = |v: &Value| v.as_str().is_some_and(|s| !s.trim().is_empty());
                    let valid_metadata = imported.get("metadata").is_none_or(|m| {
                        m.as_object().is_some_and(|obj| obj.iter().all(|(k, v)| match k.as_str() {
                            "cursorStoreCwd" | "forkHeadMessageId" => valid_string(v),
                            "title" | "updatedAt" => v.is_null() || valid_string(v),
                            "itemIdentityVersion" => v.as_u64() == Some(2),
                            "modelSelection" => v.is_object() && v.get("instanceId").or_else(|| v.get("provider")).is_some_and(valid_string) && valid_string(&v["model"]),
                            "claudeAttachmentBudget" => v.is_object() && v["bytesUsed"].as_u64().is_some() && v["pagesUsed"].as_u64().is_some(),
                            _ => true,
                        }))
                    });
                    let driver = reference["driver"].as_str().map(str::trim).filter(|s| s.len() <= 64 && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
                    if !imported.is_object() || !reference.is_object() || driver.is_none() || !valid_string(&reference["nativeId"]) || reference["strength"] != "strong" || !valid_metadata { return Err(invalid()); }
                    let driver = driver.unwrap().to_owned();
                    let native = reference["nativeId"].as_str().unwrap().trim().to_owned();
                    imported["ref"] = json!({"driver":driver,"nativeId":native,"strength":"strong"});
                    if let Some(metadata) = imported.get_mut("metadata") {
                        let fields = metadata.as_object().ok_or_else(invalid)?;
                        let mut normalized_metadata = serde_json::Map::new();
                        for key in ["cursorStoreCwd", "forkHeadMessageId", "title", "updatedAt"] {
                            if let Some(value) = fields.get(key) {
                                normalized_metadata.insert(key.into(), if value.is_null() { Value::Null } else { json!(value.as_str().ok_or_else(invalid)?.trim()) });
                            }
                        }
                        if let Some(value) = fields.get("itemIdentityVersion") { normalized_metadata.insert("itemIdentityVersion".into(), value.clone()); }
                        if let Some(value) = fields.get("claudeAttachmentBudget") {
                            normalized_metadata.insert("claudeAttachmentBudget".into(), json!({"bytesUsed":value["bytesUsed"],"pagesUsed":value["pagesUsed"]}));
                        }
                        if let Some(value) = fields.get("modelSelection") {
                            let instance = value.get("instanceId").or_else(|| value.get("provider")).and_then(Value::as_str).map(str::trim).filter(|s| s.len() <= 64 && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')).ok_or_else(invalid)?;
                            let model = value["model"].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(invalid)?;
                            let mut selection = json!({"instanceId":instance,"model":model});
                            if let Some(options) = value.get("options") {
                                selection["options"] = if let Some(fields) = options.as_object() {
                                    Value::Array(fields.iter().filter_map(|(key, value)| {
                                        let id = key.trim();
                                        if id.is_empty() { return None; }
                                        match value {
                                            Value::String(s) if !s.trim().is_empty() => Some(json!({"id":id,"value":s.trim()})),
                                            Value::Bool(_) => Some(json!({"id":id,"value":value})),
                                            _ => None,
                                        }
                                    }).collect())
                                } else { normalize_provider_options(options).ok_or_else(invalid)? };
                            }
                            normalized_metadata.insert("modelSelection".into(), selection);
                        }
                        *metadata = Value::Object(normalized_metadata);
                    }
                }
                let selection = payload
                    .get("modelSelection")
                    .and_then(Value::as_object)
                    .ok_or_else(invalid)?;
                let instance = selection
                    .get("instanceId")
                    .or_else(|| selection.get("provider"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|v| {
                        !v.is_empty()
                            && v.len() <= 64
                            && v.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                            && v.chars()
                                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                    })
                    .ok_or_else(invalid)?;
                let model = selection
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .ok_or_else(invalid)?;
                let mut normalized = json!({"instanceId":instance,"model":model});
                if let Some(options) = selection.get("options") {
                    let options = normalize_provider_options(options).ok_or_else(invalid)?;
                    normalized["options"] = options;
                }
                let source = json!(source);
                let bus = bus.ok_or_else(|| failure("Orchestration is unavailable"))?;
                let now: String = auth
                    .db
                    .lock()
                    .map_err(|_| failure("Database unavailable"))?
                    .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
                        row.get(0)
                    })
                    .map_err(|_| failure("Database unavailable"))?;
                let result = create_thread_with_import(
                    &bus,
                    CreateThread {
                        command_id,
                        thread_id,
                        project_id,
                        title,
                        model_selection: &normalized,
                        runtime_mode,
                        interaction_mode,
                        branch,
                        worktree_path,
                        created_by: "user",
                        creation_source: &source,
                        link_origin: None,
                        delegated_from: None,
                    },
                    &uuid::Uuid::new_v4().to_string(),
                    &now,
                    imported.as_ref(),
                )
                .map_err(|_| failure("Failed to dispatch orchestration V2 command"))?;
                if result.receipt.status == "rejected" {
                    let detail = result
                        .receipt
                        .error
                        .unwrap_or_else(|| "Failed to dispatch orchestration V2 command".into());
                    return Err(RpcFailure::Fail(
                        json!({"_tag":"OrchestrationV2DispatchCommandError","commandId":command_id,"commandType":"thread.create","message":detail,"detail":detail}),
                    ));
                }
                return Ok(json!({"sequence":result.receipt.result_sequence}));
            }
            Err(failure("Unsupported or invalid orchestration command"))
            }.await;
            if let (Some(writer), Some(start)) = (trace_writer, start) {
                if let Err(error) = writer.finish(&trace_tag, start, result.is_ok()) {
                    eprintln!("Warning: could not write local trace: {error}");
                }
            }
            result
        })
    }
    fn stream(
        &self,
        principal: Principal,
        request: &Request,
    ) -> Option<tokio::sync::mpsc::Receiver<Result<Vec<Value>, Value>>> {
        if request.tag == "orchestration.subscribeCommandOutput" {
            if let Some(bus) = self.event_bus.clone() { return Some(crate::command_output::stream(bus, &request.payload)); }
            let (tx,rx) = tokio::sync::mpsc::channel(1);
            let thread = request.payload["threadId"].as_str().unwrap_or("").to_owned();
            tokio::spawn(async move { let _=tx.send(Err(json!({"_tag":"OrchestrationV2CommandOutputError","threadId":thread,"message":"Failed to read command output."}))).await; });
            return Some(rx);
        }
        if request.tag == "cloud.installRelayClient" {
            if let Ok(Some(message)) = crate::managed_policy::connect_denial() {
                let (tx, rx) = tokio::sync::mpsc::channel(1);
                tokio::spawn(async move {
                    let _ = tx.send(Err(json!({"_tag":"RelayClientInstallFailedError","reason":"managed_by_policy","message":message}))).await;
                });
                return Some(rx);
            }
        }
        if request.tag == "subscribeResourceTelemetry" {
            return Some(self.resource_telemetry.subscribe_stream());
        }
        if request.tag == "subscribeProjectClones" {
            let mut updates = self.clones.subscribe();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                loop {
                    let snapshot = updates.borrow_and_update().clone();
                    if tx.send(Ok(vec![json!(snapshot)])).await.is_err() {
                        break;
                    }
                    tokio::select! { _=tx.closed()=>break, changed=updates.changed()=>if changed.is_err(){break} }
                }
            });
            return Some(rx);
        }
        if request.tag == "subscribeDiscoveredLocalServers" {
            let urls = crate::preview_discovery::configured(&request.payload);
            let terminals = self.terminals.clone();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                let Some(urls) = urls else {
                    let _ = tx
                        .send(Err(json!({"name":"Error","message":"Invalid RPC payload"})))
                        .await;
                    return;
                };
                let mut previous: Option<Vec<Value>> = None;
                let mut cache = crate::preview_discovery::ProbeCache::default();
                let mut timer = tokio::time::interval(std::time::Duration::from_secs(3));
                loop {
                    tokio::select! { _=tx.closed()=>break, _=timer.tick()=>{
                        let servers=crate::preview_discovery::scan(&urls, &terminals, &mut cache).await;
                        if previous.as_ref()!=Some(&servers) {previous=Some(servers.clone());let stamp=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);if tx.send(Ok(vec![json!({"servers":servers,"scannedAt":stamp,"configuredUrlProbing":true})])).await.is_err(){break;}}
                    } }
                }
            });
            return Some(rx);
        }
        if request.tag == "subscribePreviewEvents" {
            let mut events = self.preview_manager.subscribe();
            let (tx, rx) = tokio::sync::mpsc::channel(32);
            tokio::spawn(async move {
                loop {
                    tokio::select! { _=tx.closed()=>break, event=events.recv()=>match event { Ok(event)=>if tx.send(Ok(vec![event])).await.is_err(){break}, Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>continue,Err(_)=>break } }
                }
            });
            return Some(rx);
        }
        if request.tag == "subscribeDeviceState" {
            let device = self.device_status.clone();
            let settings = self.settings.clone();
            let mut changes = device.subscribe();
            let mut settings_changes = settings.subscribe();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                match device.read(&settings.snapshot(), false) {
                    Ok(state) => {
                        if tx.send(Ok(vec![state])).await.is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(Err(error)).await;
                        return;
                    }
                }
                loop {
                    tokio::select! {
                        _ = tx.closed() => break,
                        item = changes.recv() => match item { Ok(state) => if tx.send(Ok(vec![state])).await.is_err() { break; }, Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => if let Ok(state)=device.read(&settings.snapshot(),false) { if tx.send(Ok(vec![state])).await.is_err() { break; } }, Err(_) => break },
                        item = settings_changes.recv() => match item { Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => if let Err(error)=device.read(&settings.snapshot(),false) { let _=tx.send(Err(error)).await; break; }, Err(_) => break }
                    }
                }
            });
            return Some(rx);
        }
        if request.tag == "pullRequests.subscribeRefreshes" {
            let mut changes = self.pull_request_refreshes.subscribe();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                loop {
                    let revision = *changes.borrow_and_update();
                    if revision > 0 && tx.send(Ok(vec![json!(revision)])).await.is_err() {
                        break;
                    }
                    if changes.changed().await.is_err() {
                        break;
                    }
                }
            });
            return Some(rx);
        }
        if request.tag == "provider.install.subscribe" {
            let installer = self.installer.clone();
            let settings = self.settings.clone();
            let payload = request.payload.clone();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                if !crate::provider_install::valid("provider.install.subscribe", &payload) {
                    let _ = tx
                        .send(Err(json!({"name":"Error","message":"Invalid RPC payload"})))
                        .await;
                    return;
                }
                let mut sub = match installer.subscribe(&payload, settings.path()).await {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                };
                loop {
                    let state = sub.borrow_and_update().clone();
                    if tx.send(Ok(vec![state])).await.is_err() {
                        break;
                    }
                    tokio::select! { _ = tx.closed() => break, changed = sub.changed() => if changed.is_err() { break; } }
                }
            });
            return Some(rx);
        }
        if request.tag == "provider.auth.subscribe" {
            if !crate::provider_auth::validate(&request.tag, &request.payload) {
                let (tx, rx) = tokio::sync::mpsc::channel(1);
                tokio::spawn(async move {
                    let _ = tx
                        .send(Err(json!({"name":"Error","message":"Invalid RPC payload"})))
                        .await;
                });
                return Some(rx);
            }
            let instance = request.payload["instanceId"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let is_cursor = crate::provider::session_registry::read_provider_settings(Some(
                self.settings.path(),
            ))
            .is_ok_and(|value| value["providerInstances"][&instance]["driver"] == "cursor")
                && crate::managed_policy::check_provider_allowed("cursor").is_ok();
            if is_cursor {
                let auth = self.cursor_auth.clone();
                let owner = principal.session_id.clone();
                let mut changes = auth.subscribe_updates();
                let (tx, rx) = tokio::sync::mpsc::channel(1);
                tokio::spawn(async move {
                    loop {
                        if tx
                            .send(Ok(vec![auth.state(&instance, &owner)]))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        tokio::select! { _ = tx.closed() => break, changed = changes.changed() => if changed.is_err() { break; } }
                    }
                });
                return Some(rx);
            }
            let managed =
                crate::provider_auth::ManagedFlows::managed(&request.payload, self.settings.path());
            let error =
                crate::provider_auth::error(&request.tag, &request.payload, self.settings.path());
            let flows = self.managed_flows.clone();
            let secrets_dir = self.secrets_dir.clone();
            let owner = principal.session_id.clone();
            let instance = request.payload["instanceId"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                if !managed {
                    let _ = tx.send(Err(error)).await;
                    return;
                }
                let mut subscription = match flows.subscribe(&instance, &owner).await {
                    Ok(sub) => sub,
                    Err(cause) => {
                        let _ = tx
                            .send(Err(crate::provider_auth::managed_error(
                                "provider.auth.subscribe",
                                &instance,
                                cause,
                            )))
                            .await;
                        return;
                    }
                };
                loop {
                    tokio::select! {
                        _ = tx.closed() => break,
                        state = subscription.next() => match state {
                            Some(state) => {
                                let rendered = crate::provider_auth::ManagedFlows::render_state(&state, &instance, &secrets_dir).await;
                                let item = rendered.map(|value| vec![value]).map_err(|cause| crate::provider_auth::managed_error("provider.auth.subscribe", &instance, cause));
                                if tx.send(item).await.is_err() { break; }
                            },
                            None => break,
                        }
                    }
                }
            });
            return Some(rx);
        }
        if request.tag == "server.getDatabaseStorage" {
            let mut updates = self.database_storage.subscribe();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                loop {
                    let status = updates.borrow_and_update().clone().unwrap_or(Value::Null);
                    if tx.send(Ok(vec![status])).await.is_err() {
                        break;
                    }
                    tokio::select! { _ = tx.closed() => break, changed = updates.changed() => if changed.is_err() { break; } }
                }
            });
            return Some(rx);
        }
        if request.tag == "server.getStorageCleanupReport" {
            let mut reports = self.storage_cleanup.subscribe();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                loop {
                    let report = reports.borrow_and_update().clone().unwrap_or(Value::Null);
                    if tx.send(Ok(vec![report])).await.is_err() {
                        break;
                    }
                    tokio::select! {
                        _ = tx.closed() => break,
                        changed = reports.changed() => if changed.is_err() { break; },
                    }
                }
            });
            return Some(rx);
        }
        if request.tag == "scheduledTasks.subscribe" {
            let auth = self.auth.clone();
            let can_operate = principal
                .scopes
                .iter()
                .any(|scope| scope == "orchestration:operate");
            let webhook_policy_block = self.webhook_policy_block.clone();
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                let mut previous: Option<Value> = None;
                let mut interval = tokio::time::interval(Duration::from_millis(250));
                loop {
                    tokio::select! {
                        _ = tx.closed() => break,
                        _ = interval.tick() => {}
                    }
                    let snapshot = auth
                        .db
                        .lock()
                        .map_err(|e| e.to_string())
                        .and_then(|db| crate::scheduled_tasks::list(&db));
                    match snapshot {
                        Ok(mut tasks) => {
                            if !can_operate {
                                for task in &mut tasks {
                                    if let Some(object) = task.as_object_mut() {
                                        object.remove("webhook");
                                    }
                                }
                            }
                            if let Some(message) = &webhook_policy_block {
                                for task in &mut tasks {
                                    if task["schedule"]["type"] == "webhook" {
                                        task["blockedByPolicy"] = json!(message);
                                    }
                                }
                            }
                            let mut value = json!({"tasks":tasks});
                            let timezone = std::env::var("TZ")
                                .ok()
                                .filter(|s| !s.trim().is_empty())
                                .or_else(|| iana_time_zone::get_timezone().ok());
                            if let Some(timezone) = timezone {
                                value["timeZone"] = json!(timezone.trim_start_matches(':'));
                            }
                            if previous.as_ref() != Some(&value) {
                                previous = Some(value.clone());
                                if tx.send(Ok(vec![value])).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(error) => {
                            let _ = tx
                                .send(Err(json!({"_tag":"ScheduledTaskError","message":error})))
                                .await;
                            break;
                        }
                    }
                }
            });
            return Some(rx);
        }
        if matches!(
            request.tag.as_str(),
            "subscribeVcsStatus" | "subscribeVcsBranch"
        ) {
            return Some(crate::vcs_status::stream(&request.tag, &request.payload));
        }
        if request.tag == "subscribeAuthAccess" {
            return Some(crate::auth_access::stream(self.auth.clone(), principal));
        }
        if matches!(
            request.tag.as_str(),
            "terminal.attach" | "terminal.observe" | "subscribeTerminalMetadata"
        ) {
            return Some(
                self.terminals.stream_for_viewer(
                    &request.tag,
                    &request.payload,
                    request
                        .headers
                        .iter()
                        .find(|(name, _)| name == "x-t3-internal-viewer")
                        .map(|(_, value)| value.as_str()),
                ),
            );
        }
        if matches!(
            request.tag.as_str(),
            "subscribeServerConfig" | "subscribeServerLifecycle"
        ) {
            let config = self.client_config.clone();
            let replay_dir = self.auth.replay_dir.clone();
            let tailscale_serve_port = self.tailscale_serve_port;
            let settings = self.settings.clone();
            let mut settings_changes = settings.subscribe();
            let keybindings = self.keybindings.clone();
            let mut keybinding_changes = keybindings.subscribe();
            let environment_themes = self.themes.clone();
            let mut theme_changes = environment_themes.subscribe();
            let usage_limit_sources = self.usage_limit_sources.clone();
            let mut usage_source_changes = usage_limit_sources.subscribe();
            let provider_cache = self.provider_cache.clone();
            let sessions = self.sessions.clone();
            let lifecycle = request.tag == "subscribeServerLifecycle";
            let ready_at = self.ready_at.clone();
            let mut migration_lifecycle = self.migration_lifecycle.clone();
            let themes = request.payload.get("environmentThemes") == Some(&Value::Bool(true));
            let usage_sources =
                request.payload.get("usageLimitSources") == Some(&Value::Bool(true));
            let workspace_snapshots_on_demand =
                request.payload.get("workspaceSnapshotsOnDemand") == Some(&Value::Bool(true));
            let provider_catalogs_on_demand =
                request.payload.get("providerCatalogsOnDemand") == Some(&Value::Bool(true));
            let provider_catalog_digests =
                request.payload.get("providerCatalogDigests") == Some(&Value::Bool(true));
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            tokio::spawn(async move {
                let mut config = config;
                config["environment"]["capabilities"]["agentActivityPublishing"] = json!(
                    crate::agent_awareness_relay::read_agent_activity_publishing_active(
                        &replay_dir
                    )
                );
                config["settings"] = settings.snapshot();
                if let Ok(Some(policy)) = crate::managed_policy::client_summary() {
                    config["managedPolicy"] = policy;
                }
                let bindings = keybindings.snapshot();
                config["keybindings"] = bindings["keybindings"].clone();
                config["issues"] = bindings["issues"].clone();
                if !lifecycle {
                    if let Some(port) = tailscale_serve_port {
                        if let Some(endpoint) = crate::direct_endpoints::discover_tailscale(
                            port,
                            config["environment"]["environmentId"]
                                .as_str()
                                .unwrap_or(""),
                        )
                        .await
                        {
                            if let Some(endpoints) = config["directEndpoints"].as_array_mut() {
                                endpoints.push(endpoint);
                            }
                        }
                    }
                    let cwd = config["cwd"].as_str().unwrap_or("/").to_owned();
                    if let Ok(providers) = discover_providers(
                        &cwd,
                        settings.path(),
                        &sessions,
                        &provider_cache,
                        false,
                        false,
                    )
                    .await
                    {
                        let providers = if workspace_snapshots_on_demand {
                            without_workspace_snapshots(
                                providers,
                                provider_catalogs_on_demand,
                                provider_catalog_digests,
                            )
                        } else {
                            providers
                        };
                        config["providers"] = json!(providers);
                    }
                }
                let events = if lifecycle {
                    let cwd = config["cwd"].as_str().unwrap_or("/");
                    let name = std::path::Path::new(cwd)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .filter(|n| !n.is_empty())
                        .unwrap_or(cwd);
                    let migration = migration_lifecycle.borrow_and_update().clone();
                    let ready_sequence = if migration.is_some() { 3 } else { 2 };
                    let mut events = vec![
                        json!({"version":1,"sequence":1,"type":"welcome","payload":{"environment":config["environment"],"cwd":cwd,"projectName":name}}),
                    ];
                    if migration.as_ref().is_some_and(|v| v["sequence"] == 2) {
                        events.push(migration.clone().unwrap());
                    }
                    events.push(json!({"version":1,"sequence":ready_sequence,"type":"ready","payload":{"at":ready_at,"environment":config["environment"]}}));
                    if migration.as_ref().is_some_and(|v| v["sequence"] == 4) {
                        events.push(migration.unwrap());
                    }
                    events
                } else {
                    vec![json!({"version":1,"type":"snapshot","config":config})]
                };
                if tx.send(Ok(events)).await.is_err() {
                    return;
                }
                if !lifecycle && themes && tx.send(Ok(vec![json!({"version":1,"type":"environmentThemesUpdated","payload":{"themes":environment_themes.snapshot()}})])).await.is_err() { return; }
                if !lifecycle && usage_sources && tx.send(Ok(vec![json!({"version":1,"type":"usageLimitSourcesUpdated","payload":{"sources":usage_limit_sources.current()}})])).await.is_err() { return; }
                if lifecycle {
                    loop {
                        tokio::select! {
                            _ = tx.closed() => break,
                            changed = migration_lifecycle.changed() => {
                                if changed.is_err() { tx.closed().await; break; }
                                let event = migration_lifecycle.borrow_and_update().clone();
                                if let Some(event) = event { if tx.send(Ok(vec![event])).await.is_err() { break; } }
                            }
                        }
                    }
                    return;
                }
                loop {
                    tokio::select! {
                        _ = tx.closed() => break,
                        change = settings_changes.recv() => match change {
                            Ok(settings) => if tx.send(Ok(vec![json!({"version":1,"type":"settingsUpdated","payload":{"settings":settings}})])).await.is_err() { break; },
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => if tx.send(Ok(vec![json!({"version":1,"type":"settingsUpdated","payload":{"settings":settings.snapshot()}})])).await.is_err() { break; },
                            Err(_) => break,
                        },
                        change = keybinding_changes.recv() => match change {
                            Ok(bindings) => if tx.send(Ok(vec![json!({"version":1,"type":"keybindingsUpdated","payload":bindings})])).await.is_err() { break; },
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => if tx.send(Ok(vec![json!({"version":1,"type":"keybindingsUpdated","payload":keybindings.snapshot()})])).await.is_err() { break; },
                            Err(_) => break,
                        },
                        change = theme_changes.recv(), if themes => match change {
                            Ok(themes) => if tx.send(Ok(vec![json!({"version":1,"type":"environmentThemesUpdated","payload":{"themes":themes}})])).await.is_err() { break; },
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => if tx.send(Ok(vec![json!({"version":1,"type":"environmentThemesUpdated","payload":{"themes":environment_themes.snapshot()}})])).await.is_err() { break; },
                            Err(_) => break,
                        },
                        changed = usage_source_changes.changed(), if usage_sources => {
                            if changed.is_err() { break; }
                            let sources = usage_source_changes.borrow_and_update().clone();
                            if tx.send(Ok(vec![json!({"version":1,"type":"usageLimitSourcesUpdated","payload":{"sources":sources}})])).await.is_err() { break; }
                        }
                    }
                }
            });
            return Some(rx);
        }
        let shell = match request.tag.as_str() {
            "orchestration.subscribeShell" => true,
            "orchestration.subscribeThread" => false,
            _ => return None,
        };
        let payload = request.payload.clone();
        let bus = self.event_bus.clone();
        let identities = self.repository_identities.clone();
        let mut identity_changes = identities.subscribe();
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        tokio::spawn(async move {
            let thread_id = payload
                .get("threadId")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::trim)
                .map(str::to_owned);
            let fail = || {
                if shell {
                    json!({"_tag":"OrchestrationV2GetShellSnapshotError","message":"Failed to load orchestration V2 shell"})
                } else {
                    json!({"_tag":"OrchestrationV2GetThreadProjectionError","threadId":thread_id.clone().unwrap_or_default(),"message":"Failed to load orchestration V2 thread"})
                }
            };
            let Some(bus) = bus else {
                let _ = tx.send(Err(fail())).await;
                return;
            };
            if !shell && thread_id.is_none() {
                let _ = tx.send(Err(fail())).await;
                return;
            }
            let after = match payload.get("afterSequence") {
                None => None,
                Some(v) => match v.as_i64().filter(|v| *v >= 0) {
                    Some(n) => Some(n),
                    None => {
                        let _ = tx.send(Err(fail())).await;
                        return;
                    }
                },
            };
            let (_, mut live) = match bus.subscribe_application() {
                Ok(v) => v,
                Err(_) => {
                    let _ = tx.send(Err(fail())).await;
                    return;
                }
            };
            let mut items = Vec::new();
            let mut cursor;
            if shell {
                let omit_idle_subagents =
                    payload.get("omitIdleSubagents") == Some(&json!(true));
                let omit_older_settled =
                    payload.get("omitOlderSettled") == Some(&json!(true));
                let known_project_identities = payload
                    .get("knownProjectIdentities")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let resumed = match after {
                    Some(after) => match bus.shell_resume(after) {
                        Ok(value) => value,
                        Err(_) => {
                            let _ = tx.send(Err(fail())).await;
                            return;
                        }
                    },
                    None => None,
                };
                if let Some((seq, mut deltas)) = resumed {
                    cursor = seq;
                    for delta in &mut deltas {
                        if delta["kind"] == "project.updated" {
                            enrich_project_identity(&identities, &mut delta["project"]);
                        }
                    }
                    items.extend(deltas);
                } else {
                    if after.is_some() && payload.get("httpSnapshotFallback") == Some(&json!(true))
                    {
                        let _ = tx.send(Ok(vec![json!({"kind":"snapshot-required"})])).await;
                        return;
                    }
                    let mut snapshot = match bus
                        .shell_snapshot_with_options(omit_idle_subagents, omit_older_settled)
                    {
                        Ok(v) => v,
                        Err(_) => {
                            let _ = tx.send(Err(fail())).await;
                            return;
                        }
                    };
                    cursor = snapshot["snapshotSequence"].as_i64().unwrap_or(0);
                    let resolved = enrich_shell_snapshot(&identities, &mut snapshot);
                    let marker = identity_marker(snapshot.clone(), &resolved);
                    items.push(json!({"kind":"snapshot","snapshot":snapshot}));
                    if !resolved.is_empty() {
                        if let Some(marker) = marker {
                            items.push(marker);
                        }
                    }
                }
                // Resume paths also need a fresh enrichment pass, including
                // known-null markers that clear stale client-side identities.
                if after.is_some() {
                    if let Ok(mut snapshot) = bus.shell_snapshot() {
                        let roots = enrich_shell_snapshot(&identities, &mut snapshot);
                        let digest = snapshot["projects"]
                            .as_array()
                            .map(|projects| crate::event_bus::project_identities_digest(projects));
                        let filtered_roots = if known_project_identities.is_some()
                            && known_project_identities == digest
                        {
                            let without_identity: std::collections::HashSet<String> = snapshot
                                ["projects"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter(|p| p["repositoryIdentity"].is_null())
                                .filter_map(|p| {
                                    p["workspaceRoot"].as_str().map(str::to_owned)
                                })
                                .collect();
                            roots
                                .into_iter()
                                .filter(|root| without_identity.contains(root))
                                .collect()
                        } else {
                            roots
                        };
                        if !filtered_roots.is_empty() {
                            if let Some(marker) = identity_marker(snapshot, &filtered_roots) {
                                items.push(marker);
                            }
                        }
                    }
                }
            } else {
                let id = thread_id.as_deref().unwrap();
                let resumed = match after {
                    Some(after) => match bus.thread_resume(id, after) {
                        Ok(v) => v,
                        Err(_) => {
                            let _ = tx.send(Err(fail())).await;
                            return;
                        }
                    },
                    None => None,
                };
                if let Some((seq, events)) = resumed {
                    cursor = seq;
                    for event in events {
                        let mut e = event.event;
                        if e.event_type == "context-handoff.updated" {
                            crate::context_handoff::project_for_wire(&mut e.payload);
                        }
                        let mut item = json!({"kind":"event","sequence":event.sequence,"event":{"id":e.id,"threadId":e.stream_id,"type":e.event_type,"occurredAt":e.occurred_at,"payload":e.payload}});
                        if let Some(instance) = e
                            .metadata
                            .get("providerInstanceId")
                            .filter(|v| !v.is_null())
                        {
                            item["event"]["providerInstanceId"] = instance.clone();
                        }
                        items.push(item);
                    }
                } else {
                    let (seq, projection) = match bus.thread_snapshot(id) {
                        Ok(Some(v)) => v,
                        _ => {
                            let _ = tx.send(Err(fail())).await;
                            return;
                        }
                    };
                    cursor = seq;
                    let mut item = json!({"kind":"snapshot","snapshotSequence":cursor,"projection":projection});
                    if payload.get("acceptBoundedSnapshot") == Some(&json!(true)) {
                        item["historyCursor"] = Value::Null;
                        item["hasMoreHistory"] = json!(false);
                        item["latestLocalTurnOrdinal"] = json!(0);
                    }
                    items.push(item);
                }
            }
            if payload.get("requestCompletionMarker") == Some(&json!(true)) {
                items.push(json!({"kind":"synchronized"}));
            }
            if !items.is_empty() && tx.send(Ok(items)).await.is_err() {
                return;
            }
            loop {
                let event = tokio::select! {
                    _ = tx.closed() => return,
                    change = identity_changes.recv(), if shell => {
                        match change {
                            Ok(change) => {
                                if let Ok(mut snapshot) = bus.shell_snapshot() {
                                    enrich_shell_snapshot(&identities, &mut snapshot);
                                    if let Some(marker) = identity_marker(snapshot, &[change.root]) {
                                        if tx.send(Ok(vec![marker])).await.is_err() { return; }
                                    }
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                if let Ok(mut snapshot) = bus.shell_snapshot() {
                                    let roots = enrich_shell_snapshot(&identities, &mut snapshot);
                                    if let Some(marker) = identity_marker(snapshot, &roots) {
                                        if tx.send(Ok(vec![marker])).await.is_err() { return; }
                                    }
                                }
                            }
                            Err(_) => {}
                        }
                        continue;
                    }
                    event = live.recv() => match event {
                        Ok(e) => e,
                        Err(_) => {
                            let _ = tx.send(Err(fail())).await;
                            return;
                        }
                    }
                };
                if event.sequence <= cursor {
                    continue;
                }
                if shell {
                    // Give a burst time to settle; shell_resume reads the newest
                    // projection for each aggregate through an atomic cursor.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let (seq, mut deltas) = match bus.shell_resume(cursor) {
                        Ok(Some(v)) => v,
                        _ => {
                            let _ = tx.send(Err(fail())).await;
                            return;
                        }
                    };
                    cursor = seq;
                    for delta in &mut deltas {
                        if delta["kind"] == "project.updated" {
                            enrich_project_identity(&identities, &mut delta["project"]);
                        }
                    }
                    if !deltas.is_empty() && tx.send(Ok(deltas)).await.is_err() {
                        return;
                    }
                } else if event.event.aggregate_kind == "thread"
                    && Some(event.event.stream_id.as_str()) == thread_id.as_deref()
                {
                    let mut batch = vec![event];
                    if crate::event_bus::thread_event_coalescible(&batch[0]) {
                        let deadline = tokio::time::Instant::now() + Duration::from_millis(50);
                        while batch.len() < 512 {
                            let next = tokio::select! {
                                _ = tx.closed() => return,
                                result = tokio::time::timeout_at(deadline, live.recv()) => result,
                            };
                            let event = match next {
                                Err(_) => break,
                                Ok(Ok(event)) => event,
                                Ok(Err(_)) => {
                                    let _ = tx.send(Err(fail())).await;
                                    return;
                                }
                            };
                            if event.sequence <= cursor
                                || event.event.aggregate_kind != "thread"
                                || Some(event.event.stream_id.as_str()) != thread_id.as_deref()
                            {
                                continue;
                            }
                            let barrier = !crate::event_bus::thread_event_coalescible(&event);
                            batch.push(event);
                            if barrier {
                                break;
                            }
                        }
                    }
                    cursor = batch.last().unwrap().sequence;
                    let items = crate::event_bus::coalesce_thread_events(batch).into_iter().map(|event| {
                        let mut e = event.event;
                        if e.event_type == "context-handoff.updated" { crate::context_handoff::project_for_wire(&mut e.payload); }
                        let mut item = json!({"kind":"event","sequence":event.sequence,"event":{"id":e.id,"threadId":e.stream_id,"type":e.event_type,"occurredAt":e.occurred_at,"payload":e.payload}});
                        if let Some(instance) = e.metadata.get("providerInstanceId").filter(|v| !v.is_null()) { item["event"]["providerInstanceId"] = instance.clone(); }
                        item
                    }).collect();
                    if tx.send(Ok(items)).await.is_err() {
                        return;
                    }
                }
            }
        });
        Some(rx)
    }
    fn connected(&self, session: &Principal) {
        if let Ok(db) = self.auth.db.lock() {
            let _ = db.execute("UPDATE auth_sessions SET last_connected_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id=?1", [&session.session_id]);
        }
        self.auth.lifecycle.connect(&session.session_id);
    }
    fn disconnected(&self, session: &Principal) {
        self.auth.lifecycle.disconnect(&session.session_id);
    }
    fn invalidated(&self, session: Principal) -> BoxFuture<()> {
        let auth = self.auth.clone();
        Box::pin(async move {
            let mut changes = auth.lifecycle.subscribe();
            loop {
                if !session_current(&auth, &session) {
                    return;
                }
                let remaining = auth.db.lock().ok().and_then(|db| db.query_row("SELECT max(0, (julianday(expires_at)-julianday('now'))*86400) FROM auth_sessions WHERE session_id=?1", [&session.session_id], |r| r.get::<_, f64>(0)).ok()).unwrap_or(0.0);
                tokio::select! { result = changes.changed() => if result.is_err() { return; }, _ = tokio::time::sleep(Duration::from_secs_f64((remaining + 0.01).max(0.01))) => {} }
            }
        })
    }
}

async fn retire_auth_sessions(
    bus: Option<&crate::event_bus::EventBus>,
    sessions: &std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    instance: &str,
) -> Result<(), String> {
    sessions
        .remove_instance_wait(instance)
        .await
        .map_err(|e| e.to_string())?;
    let Some(bus) = bus else {
        return Ok(());
    };
    let ids = bus.commit(|tx| {
        let mut query = tx.prepare("SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions WHERE json_extract(payload_json, '$.providerInstanceId') = ?1")?;
        let ids = query.query_map([instance], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok((ids, vec![]))
    }).map_err(|e| e.to_string())?;
    for id in ids {
        sessions
            .remove_for_auth(&id)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn worktree_submodule_setting(bus: &EventBus, settings: &Value, cwd: &str) -> Option<String> {
    let canonical = std::fs::canonicalize(cwd).ok();
    let project = bus.with_autocommit(|db| -> rusqlite::Result<Option<String>> {
        let mut stmt = db.prepare("SELECT project_id,workspace_root FROM projection_projects WHERE deleted_at IS NULL")?;
        let projects = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        for project in projects {
            let (id, root) = project?;
            if root == cwd || canonical.as_ref().is_some_and(|p| std::fs::canonicalize(&root).ok().as_ref() == Some(p)) {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }).ok().and_then(Result::ok).flatten();
    project
        .as_deref()
        .and_then(|id| settings["projectSettingsOverrides"][id]["worktreeSubmodules"].as_str())
        .or_else(|| settings["worktreeSubmodules"].as_str())
        .map(str::to_owned)
}

fn resolve_worktrees_root(
    configured: &str,
    default: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let path = if configured.is_empty() {
        default.to_owned()
    } else {
        let expanded =
            if configured == "~" || configured.starts_with("~/") || configured.starts_with("~\\") {
                let home = std::path::PathBuf::from(
                    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?,
                );
                if configured == "~" {
                    home
                } else {
                    home.join(&configured[2..])
                }
            } else {
                std::path::PathBuf::from(configured)
            };
        if !expanded.is_absolute() {
            return None;
        }
        crate::runtime::resolve_base_dir(
            Some(&expanded.to_string_lossy()),
            std::path::Path::new("/"),
            std::path::Path::new("/"),
        )
    };
    if !path.is_absolute() || path.parent().is_none() || path.parent() == Some(path.as_path()) {
        return None;
    }
    if std::fs::canonicalize(&path)
        .ok()
        .is_some_and(|p| p.parent().is_none() || p.parent() == Some(p.as_path()))
    {
        return None;
    }
    Some(path)
}

fn invalidate_changed_secret_providers(
    sessions: &std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    old: &Value,
    new: &Value,
) -> Result<(), RpcFailure> {
    let mut ids = std::collections::HashSet::new();
    if let Some(map) = old.as_object() {
        ids.extend(map.keys().cloned());
    }
    if let Some(map) = new.as_object() {
        ids.extend(map.keys().cloned());
    }
    for id in ids {
        if crate::provider::session_registry::secret_provider_changed(old.get(&id), new.get(&id)) {
            sessions
                .secrets
                .remove_provider(&id)
                .map_err(|_| failure("Secret store unavailable"))?;
            sessions
                .invalidate_provider(&id)
                .map_err(|_| failure("Provider refresh failed"))?;
        }
    }
    Ok(())
}

async fn refresh_selected_providers(
    cwd: &str,
    path: &std::path::Path,
    sessions: &Arc<crate::provider::session_registry::SessionRegistry>,
    cache: &Arc<std::sync::Mutex<Option<Vec<Value>>>>,
    selected: Vec<String>,
) -> Result<(), String> {
    let _refresh = sessions.secret_refresh.lock().await;
    let snapshot = crate::provider::session_registry::read_provider_settings(Some(path))?;
    sessions.reconcile_secret_providers(&snapshot)?;
    sessions.hydrate_secrets(&snapshot, None).await?;
    let probe_cwd = cwd.to_owned();
    let probe_path = path.to_owned();
    let probe_sessions = sessions.clone();
    let probe_snapshot = snapshot.clone();
    let results = tokio::task::spawn_blocking(move || {
        crate::provider::acp_executor::refresh_kiro_defaults(
            &probe_snapshot,
            &probe_path,
            std::path::Path::new(&probe_cwd),
            &probe_sessions,
            Some(&selected),
            true,
        );
        selected
            .iter()
            .filter_map(|id| {
                let fallback = json!({"driver":"codex"});
                let entry = probe_snapshot["providerInstances"]
                    .get(id)
                    .or_else(|| (id == "codex").then_some(&fallback))?;
                Some(crate::provider::discovery::discover_instance(
                    std::path::Path::new(&probe_cwd),
                    id,
                    entry,
                    Some(&probe_path),
                    Some(&probe_sessions.secrets),
                ))
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|_| "Provider discovery failed")?;
    if crate::provider::session_registry::read_provider_settings(Some(path))? == snapshot {
        if let Some(current) = cache
            .lock()
            .map_err(|_| "Provider cache unavailable")?
            .as_mut()
        {
            for result in results {
                if let Some(id) = result["instanceId"].as_str() {
                    if let Some(existing) = current.iter_mut().find(|v| v["instanceId"] == id) {
                        *existing = result;
                    }
                }
            }
        }
    }
    Ok(())
}

fn supports_snapshot_for_cwd(provider: &Value) -> bool {
    matches!(
        provider["driver"].as_str(),
        Some("codex" | "claudeAgent" | "antigravity")
    ) || provider.get("workspaceSnapshots").is_some()
}

fn machine_catalog_names(provider: &Value) -> (Value, Value) {
    let slash_commands = provider["slashCommands"]
        .as_array()
        .map(|items| {
            Value::Array(
                items
                    .iter()
                    .map(|item| json!({"name": item["name"]}))
                    .collect(),
            )
        })
        .unwrap_or_else(|| json!([]));
    let skills = provider["skills"]
        .as_array()
        .map(|items| {
            Value::Array(
                items
                    .iter()
                    .map(|item| {
                        let mut obj = item.as_object().cloned().unwrap_or_default();
                        obj.remove("description");
                        obj.remove("shortDescription");
                        Value::Object(obj)
                    })
                    .collect(),
            )
        })
        .unwrap_or_else(|| json!([]));
    (slash_commands, skills)
}

fn machine_catalog_digest(provider: &Value) -> String {
    use sha2::Digest as _;
    let payload = json!([provider["slashCommands"], provider["skills"]]).to_string();
    let digest = sha2::Sha256::digest(payload.as_bytes());
    let mut hex = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn without_workspace_snapshots(
    providers: Vec<Value>,
    catalogs_per_cwd: bool,
    catalog_digests: bool,
) -> Vec<Value> {
    providers
        .into_iter()
        .map(|mut provider| {
            let strip_catalog = catalogs_per_cwd && supports_snapshot_for_cwd(&provider);
            let digest = if strip_catalog && catalog_digests {
                Some(machine_catalog_digest(&provider))
            } else {
                None
            };
            let names = if strip_catalog && !catalog_digests {
                Some(machine_catalog_names(&provider))
            } else {
                None
            };
            if let Some(obj) = provider.as_object_mut() {
                obj.remove("workspaceSnapshots");
                if let Some(digest) = digest {
                    obj.insert("slashCommands".into(), json!([]));
                    obj.insert("skills".into(), json!([]));
                    obj.insert("catalogDigest".into(), json!(digest));
                } else if let Some((slash_commands, skills)) = names {
                    obj.insert("slashCommands".into(), slash_commands);
                    obj.insert("skills".into(), skills);
                }
            }
            provider
        })
        .collect()
}

fn workspace_snapshot_or_catalog(provider: &Value, cwd: &str, catalog_on_demand: bool) -> Value {
    let snapshots: Vec<Value> = provider
        .get("workspaceSnapshots")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|snapshot| snapshot["cwd"].as_str() == Some(cwd))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if !snapshots.is_empty() || !catalog_on_demand {
        return Value::Array(snapshots);
    }
    json!([{
        "cwd": cwd,
        "checkedAt": provider["checkedAt"],
        "slashCommands": provider["slashCommands"],
        "slashCommandsPending": true,
        "skills": provider["skills"],
    }])
}

fn prepare_question_attachments(
    attachments_dir: &std::path::Path,
    thread_id: &str,
    answers: Option<&Value>,
    raw_by_question: &Value,
) -> Result<(Value, Value, Vec<std::path::PathBuf>), RpcFailure> {
    let invalid = || failure("Unsupported or invalid orchestration command");
    let by_question = raw_by_question.as_object().ok_or_else(invalid)?;
    let mut parsed_entries = Vec::with_capacity(by_question.len());
    let mut total_count = 0usize;
    let mut total_images = 0usize;
    for (question_id, value) in by_question {
        let list: Vec<crate::attachment_store::Attachment> =
            serde_json::from_value(value.clone()).map_err(|_| invalid())?;
        total_count += list.len();
        total_images += list
            .iter()
            .filter(|a| {
                a.kind == "image"
                    || ["image/gif", "image/jpeg", "image/png", "image/webp"]
                        .contains(&a.mime_type.to_ascii_lowercase().as_str())
            })
            .count();
        parsed_entries.push((question_id.clone(), list));
    }
    if total_count > 100 {
        return Err(failure(
            "You can attach up to 100 files per message or question response.",
        ));
    }
    if total_images > 20 {
        return Err(failure(
            "You can attach up to 20 images per message or question response.",
        ));
    }

    let mut claimed_paths = Vec::new();
    let mut claimed_map = serde_json::Map::new();
    for (question_id, list) in parsed_entries {
        let (claimed, paths) = match crate::attachment_store::claim(attachments_dir, thread_id, &list) {
            Ok(result) => result,
            Err(err) => {
                crate::attachment_store::release(&claimed_paths);
                return Err(failure(&err));
            }
        };
        claimed_paths.extend(paths);
        claimed_map.insert(
            question_id,
            serde_json::to_value(&claimed).expect("attachment serialization"),
        );
    }

    let mut answers_map = answers
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (question_id, value) in &claimed_map {
        let list: Vec<crate::attachment_store::Attachment> =
            serde_json::from_value(value.clone()).expect("claimed attachment deserialization");
        if list.is_empty() {
            continue;
        }
        let mut references = Vec::with_capacity(list.len());
        for attachment in &list {
            let Some(path) = crate::attachment_paths::find_by_id(attachments_dir, &attachment.id)
            else {
                crate::attachment_store::release(&claimed_paths);
                return Err(failure(&format!(
                    "Attachment '{}' is no longer available. Attach it again.",
                    attachment.name
                )));
            };
            let extracted = crate::document_text::ensure(&path);
            let quoted_name = serde_json::to_string(&attachment.name).unwrap_or_default();
            let quoted_path =
                serde_json::to_string(&path.to_string_lossy().as_ref()).unwrap_or_default();
            let extracted_suffix = extracted
                .map(|p| {
                    let quoted =
                        serde_json::to_string(&p.to_string_lossy().as_ref()).unwrap_or_default();
                    format!(" (text extracted to: {quoted})")
                })
                .unwrap_or_default();
            references.push(format!(
                "Attached {} {quoted_name}: {quoted_path}{extracted_suffix}",
                attachment.kind
            ));
        }
        let text = references.join("\n");
        let updated = match answers_map.get(question_id.as_str()) {
            Some(Value::Array(arr)) => {
                let mut next = arr.clone();
                next.push(Value::String(text));
                Value::Array(next)
            }
            Some(Value::String(existing)) if !existing.is_empty() => {
                Value::String(format!("{existing}\n\n{text}"))
            }
            _ => Value::String(text),
        };
        answers_map.insert(question_id.clone(), updated);
    }

    Ok((
        Value::Object(answers_map),
        Value::Object(claimed_map),
        claimed_paths,
    ))
}

async fn discover_providers_uncached(
    cwd: &str,
    path: &std::path::Path,
    sessions: &std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
) -> Result<Vec<Value>, String> {
    let _refresh = sessions.secret_refresh.lock().await;
    let snapshot = crate::provider::session_registry::read_provider_settings(Some(path))?;
    sessions.reconcile_secret_providers(&snapshot)?;
    sessions.hydrate_secrets(&snapshot, None).await?;
    let probe_cwd = cwd.to_owned();
    let probe_path = path.to_owned();
    let probe_sessions = sessions.clone();
    tokio::task::spawn_blocking(move || {
        crate::provider::discovery::discover_all_with_secrets(
            std::path::Path::new(&probe_cwd),
            Some(&probe_path),
            Some(&probe_sessions.secrets),
        )
    })
    .await
    .map_err(|_| "Provider discovery failed".to_owned())
}

pub(crate) async fn discover_providers(
    cwd: &str,
    path: &std::path::Path,
    sessions: &std::sync::Arc<crate::provider::session_registry::SessionRegistry>,
    cache: &std::sync::Arc<std::sync::Mutex<Option<Vec<Value>>>>,
    force: bool,
    periodic: bool,
) -> Result<Vec<Value>, String> {
    let _refresh = sessions.secret_refresh.lock().await;
    loop {
        let snapshot = crate::provider::session_registry::read_provider_settings(Some(path))?;
        sessions.reconcile_secret_providers(&snapshot)?;
        let fingerprint = json!({"providerInstances":snapshot.get("providerInstances"), "secretProviders":snapshot.get("secretProviders")});
        if !force
            && sessions
                .discovery_settings
                .lock()
                .map_err(|_| "Provider cache unavailable")?
                .as_ref()
                == Some(&fingerprint)
        {
            if let Some(cached) = cache
                .lock()
                .map_err(|_| "Provider cache unavailable")?
                .as_ref()
            {
                return Ok(cached.clone());
            }
        }
        sessions.hydrate_secrets(&snapshot, None).await?;
        if crate::provider::session_registry::read_provider_settings(Some(path))? != snapshot {
            continue;
        }
        let probe_cwd = cwd.to_owned();
        let probe_path = path.to_owned();
        let probe_sessions = sessions.clone();
        let probe_snapshot = snapshot.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::provider::acp_executor::refresh_kiro_defaults(
                &probe_snapshot,
                &probe_path,
                std::path::Path::new(&probe_cwd),
                &probe_sessions,
                None,
                periodic,
            );
            crate::provider::discovery::discover_all_with_secrets(
                std::path::Path::new(&probe_cwd),
                Some(&probe_path),
                Some(&probe_sessions.secrets),
            )
        })
        .await
        .map_err(|_| "Provider discovery failed")?;
        if crate::provider::session_registry::read_provider_settings(Some(path))? == snapshot {
            {
                let mut last = sessions
                    .last_provider_refresh
                    .lock()
                    .map_err(|_| "Provider cache unavailable")?;
                let now = std::time::Instant::now();
                last.insert("*".into(), now);
                for provider in &result {
                    if let Some(id) = provider["instanceId"].as_str() {
                        last.insert(id.to_owned(), now);
                    }
                }
            }
            *cache.lock().map_err(|_| "Provider cache unavailable")? = Some(result.clone());
            *sessions
                .discovery_settings
                .lock()
                .map_err(|_| "Provider cache unavailable")? = Some(fingerprint);
            return Ok(result);
        }
    }
}

const CLOUDFLARED_PINNED_VERSION: &str = "2026.10.4";
const CLOUDFLARED_MIN_VERSION: (u32, u32, u32) = (2025, 6, 1);

fn parse_cloudflared_version(text: &str) -> Option<(String, (u32, u32, u32))> {
    for token in text.split_whitespace() {
        let trimmed = token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.');
        let mut parts = trimmed.split('.');
        if let (Some(a), Some(b), Some(c), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        {
            if let (Ok(major), Ok(minor), Ok(patch)) =
                (a.parse::<u32>(), b.parse::<u32>(), c.parse::<u32>())
            {
                return Some((trimmed.to_owned(), (major, minor, patch)));
            }
        }
    }
    None
}

async fn compatible_cloudflared_candidate(
    executable: &std::path::Path,
    source: &str,
) -> Option<Value> {
    if !executable.is_file() {
        return None;
    }
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(executable)
            .arg("version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let (version, parsed) = parse_cloudflared_version(&combined)?;
    if parsed < CLOUDFLARED_MIN_VERSION {
        return None;
    }
    Some(json!({
        "status": "available",
        "executablePath": executable.to_string_lossy(),
        "source": source,
        "version": version,
    }))
}

async fn resolve_relay_client_status(secrets_dir: &std::path::Path) -> Value {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let exe_name = if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };

    if let Some(override_path) =
        std::env::var_os("T3CODE_CLOUDFLARED_PATH").filter(|value| !value.is_empty())
    {
        if let Some(available) =
            compatible_cloudflared_candidate(std::path::Path::new(&override_path), "override").await
        {
            return available;
        }
        return json!({
            "status": "missing",
            "version": CLOUDFLARED_PINNED_VERSION,
        });
    }

    if let Some(base) = secrets_dir.parent().and_then(std::path::Path::parent) {
        let managed = base
            .join("tools")
            .join("cloudflared")
            .join(CLOUDFLARED_PINNED_VERSION)
            .join(format!("{platform}-{arch}"))
            .join(exe_name);
        if let Some(available) = compatible_cloudflared_candidate(&managed, "managed").await {
            return available;
        }
    }

    if let Some(path_env) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let candidate = dir.join(exe_name);
            if let Some(available) = compatible_cloudflared_candidate(&candidate, "path").await {
                return available;
            }
        }
    }

    let supported = matches!(
        (platform, arch),
        ("darwin", "arm64")
            | ("darwin", "x64")
            | ("linux", "arm64")
            | ("linux", "x64")
            | ("win32", "x64")
    );
    if supported {
        json!({
            "status": "missing",
            "version": CLOUDFLARED_PINNED_VERSION,
        })
    } else {
        json!({
            "status": "unsupported",
            "platform": platform,
            "arch": arch,
            "version": CLOUDFLARED_PINNED_VERSION,
        })
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[tokio::test]
    async fn auth_retirement_stops_only_bound_sessions() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Arc;
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT, payload_json TEXT); INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('b', '{\"providerInstanceId\":\"two\"}');").unwrap();
        let bus = crate::event_bus::EventBus::new(db, 8);
        let sessions = Arc::new(crate::provider::session_registry::SessionRegistry::default());
        let path = std::env::temp_dir().join(format!("auth-retire-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\ncat >/dev/null\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        // a has opened but its projection has not yet been written.
        for (id, instance) in [("a", "one"), ("b", "two")] {
            sessions
                .open_for_instance(
                    id,
                    crate::provider::CodexLaunch {
                        binary: Some(path.clone()),
                        ..Default::default()
                    },
                    vec![],
                    Some(instance),
                )
                .unwrap();
        }
        let guard = sessions.secret_refresh.lock().await;
        super::retire_auth_sessions(Some(&bus), &sessions, "one")
            .await
            .unwrap();
        assert!(sessions.get("a").unwrap().is_none());
        assert!(sessions.get("b").unwrap().is_some());
        assert!(sessions.secret_refresh.try_lock().is_err());
        drop(guard);
        sessions
            .remove_wait("b", std::time::Duration::from_secs(3))
            .await
            .unwrap();
        std::fs::remove_file(path).unwrap();
    }
    use super::*;
    use crate::rpc::RequestId;
    use rusqlite::Connection;
    use std::sync::Mutex;
    #[tokio::test]
    async fn pull_request_diff_authenticates_before_reading_invalid_json() {
        let (app, _) = setup();
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/api/pull-requests/diff")
            .body(axum::body::Body::from("{"))
            .unwrap();
        assert_eq!(
            app.pull_request_diff(request).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn shell_stream_receives_repository_identity_enrichment() {
        let root = std::env::temp_dir().join(format!("t3-shell-identity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for args in [
            vec!["init", "-q"],
            vec![
                "remote",
                "add",
                "origin",
                "https://github.com/Example/Repository.git",
            ],
        ] {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .status()
                .unwrap()
                .success());
        }
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Project',?1,'[]','2026','2026')", [root.to_string_lossy().as_ref()]).unwrap();
        let (mut app, principal) = setup();
        app.event_bus = Some(EventBus::new(db, 32));
        let req = request("orchestration.subscribeShell", json!({}));
        let mut stream = app.stream(principal, &req).unwrap();
        let first = stream.recv().await.unwrap().unwrap();
        assert_eq!(first[0]["kind"], "snapshot");
        let root_text = root.to_string_lossy().into_owned();
        let marker = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let items = stream.recv().await.unwrap().unwrap();
                if let Some(marker) = items.into_iter().find(|item| {
                    item["resolvedRepositoryIdentityRoots"]
                        .as_array()
                        .is_some_and(|roots| roots.contains(&json!(root_text)))
                }) {
                    break marker;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            marker["snapshot"]["projects"][0]["repositoryIdentity"]["canonicalKey"],
            "github.com/example/repository"
        );
        assert_eq!(marker["snapshot"]["threads"], json!([]));
        drop(stream);
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn database_storage_stream_and_manual_reclaim_authorization() {
        let (app, mut principal) = setup();
        let subscribe = request("server.getDatabaseStorage", json!({}));
        assert!(app.authorize(&principal, &subscribe).is_ok());
        let mut stream = app.stream(principal.clone(), &subscribe).unwrap();
        assert_eq!(stream.recv().await.unwrap().unwrap(), vec![Value::Null]);
        let reclaim = request("server.reclaimDatabaseSpace", json!({}));
        assert!(app.authorize(&principal, &reclaim).is_err());
        principal.scopes.push("environment:maintain".into());
        app.auth.db.lock().unwrap().execute("UPDATE auth_sessions SET scopes='[\"orchestration:read\",\"environment:maintain\"]' WHERE session_id='s'", []).unwrap();
        assert!(app.authorize(&principal, &reclaim).is_ok());
        let error = app.dispatch(principal, reclaim).await.unwrap_err();
        match error {
            RpcFailure::Fail(value) => {
                assert_eq!(value["_tag"], "DatabaseReclaimError");
                assert!(value["reason"]
                    .as_str()
                    .unwrap()
                    .contains("t3 doctor --base-dir"));
            }
            _ => panic!("unexpected error"),
        }
    }
    #[tokio::test]
    async fn storage_cleanup_report_stream_and_manual_scope() {
        let (mut app, mut principal) = setup();
        let root = std::env::temp_dir().join(format!("t3-cleanup-rpc-{}", uuid::Uuid::new_v4()));
        app.settings = Arc::new(crate::settings::Settings::new(root.join("settings.json")));
        app.storage_cleanup = crate::storage_cleanup::StorageCleanup::new(
            app.settings.clone(),
            root.join("browser-artifacts"),
            root.join("logs"),
        );
        let subscribe = request("server.getStorageCleanupReport", json!({}));
        assert!(app.authorize(&principal, &subscribe).is_ok());
        let mut stream = app.stream(principal.clone(), &subscribe).unwrap();
        assert_eq!(stream.recv().await.unwrap().unwrap(), vec![Value::Null]);
        let manual = request("server.runStorageCleanup", json!({}));
        assert!(app.authorize(&principal, &manual).is_err());
        principal.scopes.push("settings:write".into());
        app.auth.db.lock().unwrap().execute("UPDATE auth_sessions SET scopes='[\"orchestration:read\",\"settings:write\"]' WHERE session_id='s'", []).unwrap();
        assert!(app.authorize(&principal, &manual).is_ok());
        let report = app.dispatch(principal, manual).await.unwrap();
        assert_eq!(report["trigger"], "manual");
        assert_eq!(stream.recv().await.unwrap().unwrap(), vec![report]);
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn worktree_root_requires_a_non_root_absolute_directory() {
        let default = std::env::temp_dir().join("t3-worktrees");
        assert_eq!(resolve_worktrees_root("", &default), Some(default.clone()));
        assert!(resolve_worktrees_root("relative/worktrees", &default).is_none());
        assert!(resolve_worktrees_root(std::path::MAIN_SEPARATOR_STR, &default).is_none());
        assert_eq!(
            resolve_worktrees_root(&default.to_string_lossy(), &default),
            Some(default)
        );
    }
    fn setup() -> (Application, Principal) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, subject TEXT, scopes TEXT, method TEXT, expires_at TEXT, revoked_at TEXT); INSERT INTO auth_sessions VALUES ('s','user','[\"orchestration:read\"]','bearer-access-token','2999-01-01T00:00:00Z',NULL);").unwrap();
        let state = Arc::new(AuthHttpState {
            replay_dir: std::env::temp_dir().join(format!("t3-dpop-test-{}", uuid::Uuid::new_v4())),
            environment_descriptor: std::sync::OnceLock::new(),
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: crate::cloud_connector::Connector::default(),
            listen_address: std::sync::OnceLock::new(),
            lifecycle: Default::default(),
            db: Mutex::new(db),
            signing_key: [1; 32],
            descriptor: json!({"sessionCookieName":"t3"}),
            trusted_origins: vec![],
            accept_legacy_cookie: false,
            desktop_bootstrap: None,
        });
        let principal = Principal {
            session_id: "s".into(),
            subject: "user".into(),
            scopes: vec!["orchestration:read".into()],
            method: "bearer-access-token".into(),
            jkt: None,
            rtc: None,
            peer_link: false,
        };
        (
            Application::new(state, "test".into(), "host".into()),
            principal,
        )
    }
    fn request(tag: &str, payload: Value) -> Request {
        Request {
            id: RequestId::String("1".into()),
            tag: tag.into(),
            payload,
            headers: vec![],
            is_notification: false,
            discard: false,
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }
    #[tokio::test]
    async fn managed_auth_rpc_enforces_scope_and_owner_isolation() {
        let (mut app, mut alice) = setup();
        let root = std::env::temp_dir().join(format!("managed-rpc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.json");
        std::fs::write(&settings, r#"{"providerInstances":{"managed":{"driver":"codex","config":{"setupMode":"managed"}}}}"#).unwrap();
        app.settings = Arc::new(crate::settings::Settings::new(settings));
        app.secrets_dir = root.join("secrets");
        app.managed_flows = Arc::new(crate::provider_auth::ManagedFlows::for_test());
        let start = request(
            "provider.auth.start",
            json!({"instanceId":"managed", "callbackMode":"client"}),
        );
        assert!(app.authorize(&alice, &start).is_err());
        alice.scopes = vec!["providers:manage".into()];
        let mut bob = alice.clone();
        bob.session_id = "bob".into();
        {
            let db = app.auth.db.lock().unwrap();
            db.execute(
                "UPDATE auth_sessions SET scopes='[\"providers:manage\"]' WHERE session_id='s'",
                [],
            )
            .unwrap();
            db.execute("INSERT INTO auth_sessions VALUES ('bob','user','[\"providers:manage\"]','bearer-access-token','2999-01-01T00:00:00Z',NULL)", []).unwrap();
        }
        assert!(app.authorize(&alice, &start).is_ok());
        let subscribe = request("provider.auth.subscribe", json!({"instanceId":"managed"}));
        let mut alice_stream = app.stream(alice.clone(), &subscribe).unwrap();
        let mut bob_stream = app.stream(bob.clone(), &subscribe).unwrap();
        assert_eq!(
            alice_stream.recv().await.unwrap().unwrap()[0]["phase"],
            "idle"
        );
        bob_stream.recv().await.unwrap().unwrap();
        let state = app.dispatch(alice.clone(), start.clone()).await.unwrap();
        assert_eq!(state["phase"], "waiting");
        let seen = alice_stream.recv().await.unwrap().unwrap();
        assert_eq!(seen[0]["flowId"], state["flowId"]);
        let hidden = bob_stream.recv().await.unwrap().unwrap();
        assert!(hidden[0]["flowId"].is_null() && hidden[0]["interaction"].is_null());
        assert!(app.dispatch(bob.clone(), start).await.is_err());
        let cancel = request(
            "provider.auth.cancel",
            json!({"instanceId":"managed", "flowId": state["flowId"]}),
        );
        assert!(app.dispatch(bob, cancel.clone()).await.is_err());
        assert_eq!(
            app.dispatch(alice, cancel).await.unwrap()["phase"],
            "cancelled"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn keybinding_rpc_publishes_config_change() {
        let (mut app, mut principal) = setup();
        let dir = std::env::temp_dir().join(format!("rpc-keys-{}", uuid::Uuid::new_v4()));
        app.keybindings = Arc::new(crate::keybindings::Keybindings::new(
            dir.join("keybindings.json"),
            true,
        ));
        let subscription = request("subscribeServerConfig", json!({}));
        let mut stream = app.stream(principal.clone(), &subscription).unwrap();
        stream.recv().await.unwrap().unwrap();
        let update = request(
            "server.upsertKeybinding",
            json!({"key":"ctrl+x","command":"test.action"}),
        );
        assert!(app.authorize(&principal, &update).is_err());
        principal.scopes.push("settings:write".into());
        app.auth.db.lock().unwrap().execute("UPDATE auth_sessions SET scopes='[\"orchestration:read\",\"settings:write\"]' WHERE session_id='s'", []).unwrap();
        assert!(app.authorize(&principal, &update).is_ok());
        app.dispatch(principal, update).await.unwrap();
        let events = tokio::time::timeout(Duration::from_secs(3), stream.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(events[0]["type"], "keybindingsUpdated");
        assert!(events[0]["payload"]["keybindings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["command"] == "test.action"));
        drop(stream);
        drop(app);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn theme_stream_is_opt_in_and_emits_current_and_new_themes() {
        let (mut app, principal) = setup();
        let dir = std::env::temp_dir().join(format!("rpc-themes-{}", uuid::Uuid::new_v4()));
        app.themes = Arc::new(crate::environment_theme::Themes::new(dir.clone(), true));
        let mut stream = app
            .stream(
                principal,
                &request("subscribeServerConfig", json!({"environmentThemes":true})),
            )
            .unwrap();
        assert_eq!(stream.recv().await.unwrap().unwrap()[0]["type"], "snapshot");
        let initial = stream.recv().await.unwrap().unwrap();
        assert_eq!(initial[0]["type"], "environmentThemesUpdated");
        assert_eq!(initial[0]["payload"]["themes"], json!([]));
        std::fs::write(
            dir.join("custom.json"),
            r##"{"name":"Custom","appearance":"dark","colors":{"canvas":"#111"}}"##,
        )
        .unwrap();
        let event = tokio::time::timeout(Duration::from_secs(3), stream.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(event[0]["payload"]["themes"][0]["id"], "custom");
        drop(stream);
        drop(app);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn workspace_write_rpc_requires_filesystem_write_scope() {
        let (app, mut principal) = setup();
        let write = request(
            "projects.writeFile",
            json!({"cwd":"/tmp","relativePath":"x","contents":"a"}),
        );
        assert!(app.authorize(&principal, &write).is_err());
        principal.scopes.push("filesystem:write".into());
        app.auth.db.lock().unwrap().execute("UPDATE auth_sessions SET scopes='[\"orchestration:read\",\"filesystem:write\"]' WHERE session_id='s'", []).unwrap();
        assert!(app.authorize(&principal, &write).is_ok());
    }
    #[tokio::test]
    async fn fork_dispatch_reaches_decider_and_replays_rejection() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let app = app.with_event_bus(EventBus::new(db, 16));
        let command = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.fork","commandId":"fork-cmd","sourceThreadId":"missing","targetThreadId":"new","sourcePoint":{"type":"latest_stable"},"createdBy":"user","creationSource":"web"}),
        );
        for _ in 0..2 {
            match app
                .dispatch(principal.clone(), command.clone())
                .await
                .unwrap_err()
            {
                RpcFailure::Fail(error) => {
                    assert_eq!(error["commandType"], "thread.fork");
                    assert_eq!(error["detail"], "Thread missing was not found.");
                }
                _ => panic!("expected fork rejection"),
            }
        }
    }
    #[tokio::test]
    async fn thread_lifecycle_dispatch_reaches_decider() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let app = app.with_event_bus(EventBus::new(db, 16));
        let command = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.archive","commandId":"archive","threadId":"missing"}),
        );
        match app.dispatch(principal, command).await.unwrap_err() {
            RpcFailure::Fail(error) => {
                assert_eq!(error["commandType"], "thread.archive");
                assert_eq!(error["detail"], "Thread missing does not exist.");
            }
            _ => panic!("expected lifecycle rejection"),
        }
    }
    #[tokio::test]
    async fn thread_delete_dispatch_tombstones_and_replays() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let thread = json!({"id":"t","title":"T","updatedAt":"2026","deletedAt":null});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[thread.to_string()]).unwrap();
        let app = app.with_event_bus(EventBus::new(db, 16));
        let request = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.delete","commandId":"delete","threadId":"t"}),
        );
        let first = app
            .dispatch(principal.clone(), request.clone())
            .await
            .unwrap();
        assert_eq!(app.dispatch(principal, request).await.unwrap(), first);
        app.event_bus.as_ref().unwrap().commit(|tx| {let deleted:Option<String>=tx.query_row("SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|r.get(0))?;assert!(deleted.is_some());Ok(((),vec![]))}).unwrap();
    }
    #[tokio::test]
    async fn thread_visit_dispatch_records_read_watermark() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[json!({"id":"t","lastVisitedAt":null,"opens":null}).to_string()]).unwrap();
        let app = app.with_event_bus(EventBus::new(db, 16));
        let command = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.visit","commandId":"visit","threadId":"t","visitedAt":"2026-01-01T00:00:00Z","opened":true,"searchQuery":"Search"}),
        );
        let first = app
            .dispatch(principal.clone(), command.clone())
            .await
            .unwrap();
        assert_eq!(app.dispatch(principal, command).await.unwrap(), first);
        let bus = app.event_bus.as_ref().unwrap();
        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let thread: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(thread["lastVisitedAt"], "2026-01-01T00:00:00Z");
            assert_eq!(thread["opens"]["picks"][0]["query"], "search");
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[tokio::test]
    async fn sidebar_commands_are_dispatched_and_idempotent() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let initial = json!({"id":"t","updatedAt":"2026-01-01T00:00:00Z","pinnedAt":null,"archivedAt":null,"deletedAt":null,"tags":[]});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[initial.to_string()]).unwrap();
        let app = app.with_event_bus(EventBus::new(db, 16));
        let pin = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.pin","commandId":"pin","threadId":"t","orderKey":" alpha "}),
        );
        let result = app.dispatch(principal.clone(), pin.clone()).await.unwrap();
        assert_eq!(app.dispatch(principal.clone(), pin).await.unwrap(), result);
        app.dispatch(principal,request("orchestration.dispatchCommand",json!({"type":"thread.tag.set","commandId":"tag","threadId":"t","tag":" priority ","tagged":true}))).await.unwrap();
        app.event_bus.as_ref().unwrap().commit(|tx| { let raw:String=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|r.get(0))?; let value:Value=serde_json::from_str(&raw).unwrap(); assert_eq!(value["pinOrderKey"],"alpha"); assert_eq!(value["tags"],json!(["priority"])); Ok(((),vec![])) }).unwrap();
    }
    #[tokio::test]
    async fn mode_commands_update_thread_projection() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let initial = json!({"id":"t","runtimeMode":"full-access","interactionMode":"default","updatedAt":"2026"});
        db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('t','p','T','codex','full-access','default','2026','2026',?1)",[initial.to_string()]).unwrap();
        let app = app.with_event_bus(EventBus::new(db, 16));
        let command = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.interaction-mode.set","commandId":"mode","threadId":"t","interactionMode":"plan"}),
        );
        let result = app
            .dispatch(principal.clone(), command.clone())
            .await
            .unwrap();
        assert_eq!(app.dispatch(principal, command).await.unwrap(), result);
        app.event_bus.as_ref().unwrap().commit(|tx| { let mode:String=tx.query_row("SELECT interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id='t'",[],|r|r.get(0))?; assert_eq!(mode,"plan"); Ok(((),vec![])) }).unwrap();
    }
    #[tokio::test]
    async fn project_update_rpc_returns_committed_project() {
        let root = std::env::temp_dir().join(format!("t3-project-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("db.sqlite");
        let mut db = crate::database::open_writer(&path).unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Old',?1,'[]','2026','2026')",[root.to_string_lossy().as_ref()]).unwrap();
        db.execute("INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at) VALUES('s','user','[\"orchestration:operate\"]','bearer-access-token','2026','2999-01-01T00:00:00Z')",[]).unwrap();
        let auth = Arc::new(AuthHttpState {
            replay_dir: root.join("secrets"),
            environment_descriptor: std::sync::OnceLock::new(),
            cloud_action_lock: tokio::sync::Mutex::new(()),
            cloud_generation: std::sync::atomic::AtomicU64::new(0),
            cloud_connector: crate::cloud_connector::Connector::default(),
            listen_address: std::sync::OnceLock::new(),
            lifecycle: Default::default(),
            db: Mutex::new(db),
            signing_key: [1; 32],
            descriptor: json!({"sessionCookieName":"t3"}),
            trusted_origins: vec![],
            accept_legacy_cookie: false,
            desktop_bootstrap: None,
        });
        let principal = Principal {
            session_id: "s".into(),
            subject: "user".into(),
            scopes: vec!["orchestration:operate".into()],
            method: "bearer-access-token".into(),
            jkt: None,
            rtc: None,
            peer_link: false,
        };
        let mut app = Application::new(auth, "test".into(), "host".into()).with_event_bus(
            EventBus::new(crate::database::open_writer(&path).unwrap(), 16),
        );
        app.settings = Arc::new(crate::settings::Settings::new(root.join("settings.json")));
        let update = request(
            "projects.mutate",
            json!({"type":"project.update","commandId":"update","projectId":"p","title":"New"}),
        );
        app.authorize(&principal, &update).unwrap();
        let result = app
            .dispatch(principal.clone(), update.clone())
            .await
            .unwrap();
        assert_eq!(result["title"], "New");
        assert_eq!(
            app.dispatch(principal.clone(), update).await.unwrap()["title"],
            "New"
        );
        let workspace = root.join("new-workspace");
        let create = request(
            "projects.mutate",
            json!({"type":"project.create","commandId":"create","projectId":"new","title":"Created","workspaceRoot":workspace.to_str().unwrap(),"createWorkspaceRootIfMissing":true}),
        );
        app.authorize(&principal, &create).unwrap();
        let created = app
            .dispatch(principal.clone(), create.clone())
            .await
            .unwrap();
        assert_eq!(created["id"], "new");
        assert_eq!(created["title"], "Created");
        assert!(workspace.is_dir());
        assert_eq!(
            app.dispatch(principal.clone(), create).await.unwrap(),
            created
        );
        app.settings
            .update(&json!({"projectSettingsOverrides":{"new":{"defaultAutoPull":false}}}))
            .unwrap();
        let delete = request(
            "projects.mutate",
            json!({"type":"project.delete","commandId":"delete","projectId":"new"}),
        );
        let deleted = app
            .dispatch(principal.clone(), delete.clone())
            .await
            .unwrap();
        assert_eq!(deleted["id"], "new");
        assert!(deleted["deletedAt"].is_string());
        assert_eq!(app.dispatch(principal, delete).await.unwrap(), deleted);
        assert!(app.settings.snapshot()["projectSettingsOverrides"]
            .get("new")
            .is_none());
        assert!(workspace.is_dir());
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn provider_mutation_rpc_returns_duplicate_error() {
        let (mut app, principal) = setup();
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        app.settings = Arc::new(crate::settings::Settings::new(dir.join("settings.json")));
        let create = request(
            "server.updateSettings",
            json!({"patch":{},"providerInstanceMutation":{"operation":"create","instanceId":"work","instance":{"driver":"codex"}}}),
        );
        let result = app
            .dispatch(principal.clone(), create.clone())
            .await
            .unwrap();
        assert_eq!(result["providerInstances"]["work"]["driver"], "codex");
        match app.dispatch(principal, create).await.unwrap_err() {
            RpcFailure::Fail(error) => {
                assert_eq!(error["operation"], "create-provider-instance");
                assert_eq!(error["providerInstanceId"], "work");
                assert_eq!(
                    error["settingsPath"],
                    dir.join("settings.json").to_string_lossy().as_ref()
                );
            }
            _ => panic!("expected settings domain error"),
        }
        drop(app);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn upload_rpc_issues_usable_token_and_deletes_pending_file() {
        let (mut app, mut principal) = setup();
        let create_request = request(
            "attachments.createUploadUrl",
            json!({"type":"file","name":"x.txt","mimeType":"text/plain","sizeBytes":3}),
        );
        assert!(app.authorize(&principal, &create_request).is_err());
        principal.scopes.push("orchestration:operate".into());
        app.auth.db.lock().unwrap().execute("UPDATE auth_sessions SET scopes='[\"orchestration:read\",\"orchestration:operate\"]' WHERE session_id='s'", []).unwrap();
        assert!(app.authorize(&principal, &create_request).is_ok());
        assert!(app
            .authorize(
                &principal,
                &request("attachments.delete", json!({"attachmentId":"pending"}))
            )
            .is_ok());
        let dir = std::env::temp_dir().join(format!("rpc-upload-{}", uuid::Uuid::new_v4()));
        app.attachments_dir = dir.clone();
        let created = app
            .dispatch(principal.clone(), create_request)
            .await
            .unwrap();
        let token = created["relativeUrl"]
            .as_str()
            .unwrap()
            .strip_prefix("/api/attachments/upload/")
            .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let claims =
            crate::attachment_store::verify_upload(&app.auth.signing_key, token, now).unwrap();
        assert_eq!(claims.attachment_id, created["attachmentId"]);
        crate::attachment_store::publish_upload(&dir, &claims, b"abc").unwrap();
        app.dispatch(
            principal.clone(),
            request(
                "attachments.delete",
                json!({"attachmentId":claims.attachment_id}),
            ),
        )
        .await
        .unwrap();
        assert!(crate::attachment_paths::find_by_id(&dir, &claims.attachment_id).is_none());
        assert!(app
            .dispatch(
                principal,
                request(
                    "attachments.createUploadUrl",
                    json!({"name":"x","mimeType":"image/png","sizeBytes":0})
                )
            )
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn managed_policy_blocks_webhook_activation() {
        let (app, principal) = setup();
        let app = app.with_webhook_policy(Some(
            "Example's policy does not allow webhook tasks.".into(),
        ));
        let input = json!({"commandId":"hook","title":"t","prompt":"p","enabled":true,"schedule":{"type":"webhook"},"projectId":"p","workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"i","model":"m"},"runtimeMode":"full-access","interactionMode":"default"});
        assert!(app
            .dispatch(principal, request("scheduledTasks.upsert", input))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn trace_diagnostics_requires_scope_and_uses_runtime_path() {
        let (mut app, mut principal) = setup();
        let path = std::env::temp_dir().join(format!("trace-rpc-{}", uuid::Uuid::new_v4()));
        app.trace_path = path.clone();
        let req = request("server.getTraceDiagnostics", json!({}));
        assert!(app.authorize(&principal, &req).is_err());
        principal.scopes.push("diagnostics:read".into());
        app.auth
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET scopes=?1 WHERE session_id='s'",
                [json!(principal.scopes).to_string()],
            )
            .unwrap();
        assert!(app.authorize(&principal, &req).is_ok());
        let result = app.dispatch(principal, req).await.unwrap();
        assert_eq!(result["traceFilePath"], path.to_string_lossy().as_ref());
        assert_eq!(result["error"]["value"]["kind"], "trace-file-not-found");
    }
    #[tokio::test]
    async fn direct_endpoints_appear_in_config_and_subscription() {
        let (app, principal) = setup();
        let endpoints = vec![json!({"kind":"lan", "httpBaseUrl":"http://192.168.1.8:3773/"})];
        let app = app.with_direct_endpoints(endpoints.clone());
        let config = app
            .dispatch(principal.clone(), request("server.getConfig", json!({})))
            .await
            .unwrap();
        assert_eq!(config["directEndpoints"], json!(endpoints));
        let mut stream = app
            .stream(principal, &request("subscribeServerConfig", json!({})))
            .unwrap();
        let frame = stream.recv().await.unwrap().unwrap();
        assert_eq!(
            frame[0]["config"]["directEndpoints"],
            config["directEndpoints"]
        );
    }
    #[tokio::test]
    async fn config_and_lifecycle_begin_with_consistent_snapshots() {
        let (app, principal) = setup();
        let unary = request("server.getConfig", json!({}));
        assert!(app.authorize(&principal, &unary).is_ok());
        let config = app.dispatch(principal.clone(), unary).await.unwrap();
        assert_eq!(config["environment"], app.descriptor());
        let subscription = request("subscribeServerConfig", json!({}));
        assert!(app.authorize(&principal, &subscription).is_ok());
        let mut stream = app.stream(principal.clone(), &subscription).unwrap();
        assert_eq!(
            stream.recv().await.unwrap().unwrap(),
            vec![json!({"version":1,"type":"snapshot","config":config})]
        );
        let lifecycle = request("subscribeServerLifecycle", json!({}));
        assert!(app.authorize(&principal, &lifecycle).is_ok());
        let mut stream = app.stream(principal, &lifecycle).unwrap();
        let events = stream.recv().await.unwrap().unwrap();
        assert_eq!(events[0]["type"], "welcome");
        assert_eq!(events[1]["type"], "ready");
        assert_eq!(events[1]["sequence"], 2);
        assert_eq!(events[1]["payload"]["environment"], app.descriptor());
    }
    #[tokio::test]
    async fn lifecycle_stream_replays_latest_migration_and_delivers_completion() {
        let (app, principal) = setup();
        let running = json!({"version":1,"sequence":2,"type":"legacyThreadMigration","payload":{"status":"running","totalThreadCount":2}});
        let complete = json!({"version":1,"sequence":4,"type":"legacyThreadMigration","payload":{"status":"complete","totalThreadCount":2}});
        let (sender, receiver) = tokio::sync::watch::channel(Some(running.clone()));
        let app = app.with_migration_lifecycle(receiver);
        let request = request("subscribeServerLifecycle", json!({}));
        let mut stream = app.stream(principal.clone(), &request).unwrap();
        let events = stream.recv().await.unwrap().unwrap();
        assert_eq!(events[1], running);
        assert_eq!(events[2]["sequence"], 3);
        sender.send(Some(complete.clone())).unwrap();
        assert_eq!(
            stream.recv().await.unwrap().unwrap(),
            vec![complete.clone()]
        );
        let mut late = app.stream(principal, &request).unwrap();
        let events = late.recv().await.unwrap().unwrap();
        assert_eq!(events[1]["type"], "ready");
        assert_eq!(events[1]["sequence"], 3);
        assert_eq!(events[2], complete);
    }
    #[tokio::test]
    async fn webhook_delivery_rpc_requires_operate_scope() {
        let (app, mut principal) = setup();
        app.auth.db.lock().unwrap().execute_batch("CREATE TABLE scheduled_task_webhook_deliveries(delivery_id TEXT,task_id TEXT,received_at TEXT,method TEXT,query TEXT,headers_json TEXT,body TEXT,body_bytes INTEGER,body_truncated INTEGER,outcome TEXT,signature_verified INTEGER,missing_fields_json TEXT,rendered_prompt TEXT,error TEXT); CREATE TABLE scheduled_task_webhook_pending(delivery_id TEXT,state TEXT); INSERT INTO scheduled_task_webhook_deliveries VALUES('d','t','2026','POST','','{}','',0,0,'accepted',0,'[]',NULL,NULL);").unwrap();
        let req = request("scheduledTasks.listWebhookDeliveries", json!({"id":"t"}));
        assert!(app.authorize(&principal, &req).is_err());
        principal.scopes.push("orchestration:operate".into());
        app.auth.db.lock().unwrap().execute("UPDATE auth_sessions SET scopes='[\"orchestration:read\",\"orchestration:operate\"]' WHERE session_id='s'", []).unwrap();
        assert!(app.authorize(&principal, &req).is_ok());
        assert_eq!(
            app.dispatch(principal.clone(), req).await.unwrap()["deliveries"][0]["id"],
            "d"
        );
        let detail = request(
            "scheduledTasks.getWebhookDelivery",
            json!({"id":"t","deliveryId":"d"}),
        );
        assert_eq!(
            app.dispatch(principal, detail).await.unwrap()["delivery"]["id"],
            "d"
        );
    }
    #[tokio::test]
    async fn scheduled_mutations_enforce_scope_and_update_list() {
        let (app, mut principal) = setup();
        {
            let db = app.auth.db.lock().unwrap();
            db.execute_batch(&format!(
                "{};{};{}",
                include_str!("../migrations/055-scheduled-tasks.sql"),
                include_str!("../migrations/057.sql"),
                include_str!("../migrations/080.sql")
            ))
            .unwrap();
        }
        let payload = json!({"id":"task","title":"Task","prompt":"hello","enabled":true,"schedule":{"type":"interval","everyMs":60000},"projectId":"p","workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"codex","model":"gpt"},"runtimeMode":"auto","interactionMode":"default"});
        let req = request("scheduledTasks.upsert", payload);
        assert!(app.authorize(&principal, &req).is_err());
        principal.scopes.push("orchestration:operate".into());
        app.auth.db.lock().unwrap().execute("UPDATE auth_sessions SET scopes='[\"orchestration:read\",\"orchestration:operate\"]' WHERE session_id='s'", []).unwrap();
        assert!(app.authorize(&principal, &req).is_ok());
        assert_eq!(
            app.dispatch(principal.clone(), req).await.unwrap()["task"]["id"],
            "task"
        );
        let toggle = request(
            "scheduledTasks.setEnabled",
            json!({"id":"task","enabled":false}),
        );
        assert_eq!(
            app.dispatch(principal.clone(), toggle).await.unwrap()["task"]["enabled"],
            false
        );
        assert_eq!(
            app.dispatch(
                principal,
                request("scheduledTasks.delete", json!({"id":"task"}))
            )
            .await
            .unwrap(),
            json!({"id":"task"})
        );
        assert!(crate::scheduled_tasks::list(&app.auth.db.lock().unwrap())
            .unwrap()
            .is_empty());
    }
    #[tokio::test]
    async fn scheduled_subscription_sends_snapshot_and_changes() {
        let (app, mut principal) = setup();
        {
            let db = app.auth.db.lock().unwrap();
            db.execute_batch(&format!(
                "{};{};{}",
                include_str!("../migrations/055-scheduled-tasks.sql"),
                include_str!("../migrations/057.sql"),
                include_str!("../migrations/080.sql")
            ))
            .unwrap();
        }
        let req = request("scheduledTasks.subscribe", json!({}));
        assert!(app.authorize(&principal, &req).is_ok());
        let mut stream = app.stream(principal.clone(), &req).unwrap();
        assert_eq!(stream.recv().await.unwrap().unwrap()[0]["tasks"], json!([]));
        app.auth.db.lock().unwrap().execute("INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count) VALUES('s','title','prompt',0,'{\"type\":\"interval\",\"everyMs\":60000}','p','{}','{}','auto','default','user','web','now','now','never',0)", []).unwrap();
        let changed = tokio::time::timeout(Duration::from_secs(2), stream.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(changed[0]["tasks"][0]["id"], "s");
        app.auth.db.lock().unwrap().execute("UPDATE scheduled_tasks SET schedule_json='{\"type\":\"webhook\",\"signature\":null}',webhook_token='private-token',webhook_secret='private-secret' WHERE task_id='s'", []).unwrap();
        let changed = tokio::time::timeout(Duration::from_secs(2), stream.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(!changed[0].to_string().contains("private-token"));
        assert!(!changed[0].to_string().contains("private-secret"));
        assert!(changed[0]["tasks"][0].get("webhook").is_none());
        principal.scopes.push("orchestration:operate".into());
        let mut operator = app.stream(principal, &req).unwrap();
        let visible = operator.recv().await.unwrap().unwrap();
        assert_eq!(
            visible[0]["tasks"][0]["webhook"]["path"],
            "/api/hooks/s/private-token"
        );
        assert!(!visible[0].to_string().contains("private-secret"));
    }
    #[tokio::test]
    async fn otlp_check_requires_settings_scope() {
        let (app, mut principal) = setup();
        let probe = request(
            "server.checkOtlpEndpoint",
            json!({"signal":"logs","url":"http://127.0.0.1:1"}),
        );
        assert!(app.authorize(&principal, &probe).is_err());
        principal.scopes.push("settings:write".into());
        app.auth.db.lock().unwrap().execute("UPDATE auth_sessions SET scopes='[\"orchestration:read\",\"settings:write\"]' WHERE session_id='s'", []).unwrap();
        assert!(app.authorize(&principal, &probe).is_ok());
        assert_eq!(
            app.dispatch(principal, probe).await.unwrap()["_tag"],
            "Unreachable"
        );
    }
    #[tokio::test]
    async fn probe_requires_live_session_and_scope() {
        let (app, principal) = setup();
        let probe = request("server.probe", json!({}));
        assert!(app.authorize(&principal, &probe).is_ok());
        assert_eq!(
            app.dispatch(principal.clone(), probe).await.unwrap(),
            json!({})
        );
        assert!(app
            .authorize(&principal, &request("server.probe", Value::Null))
            .is_err());
        assert!(app
            .authorize(&principal, &request("terminal.open", json!({})))
            .is_err());
        let capabilities = &app.descriptor()["capabilities"];
        assert_eq!(capabilities["connectionProbe"], json!(true));
        assert_eq!(capabilities["peerLinks"], json!(true));
        assert_eq!(capabilities["mcpModeLimitHeader"], json!(true));
        assert_eq!(capabilities["linkFence"], json!(true));
        assert_eq!(capabilities["sideChats"], json!(true));
        assert_eq!(capabilities["commandOutputStreaming"], json!(true));
        assert_eq!(capabilities["databaseStorage"], json!(true));
        assert_eq!(capabilities["storageCleanup"], json!(true));
        assert_eq!(capabilities["storageCleanupRun"], json!(true));
        assert_eq!(
            capabilities["fileAttachments"],
            json!({"maxUploadBytes": 50 * 1024 * 1024})
        );
        assert_eq!(capabilities["repositoryIdentity"], json!(true));
        assert_eq!(capabilities["pullRequests"], json!(true));
        assert_eq!(capabilities["pullRequestChecks"], json!(true));
        assert_eq!(capabilities["pullRequestStackActions"], json!(true));
        assert_eq!(capabilities["scheduledTaskThreadModes"], json!(true));
        assert_eq!(capabilities["worktreesDirectory"], json!(true));
        assert_eq!(capabilities["voiceTranscription"], json!(true));
        assert_eq!(capabilities["serverBrowser"], json!(true));
        assert_eq!(capabilities["requiredWorktreeBootstrap"], json!(true));
        assert_eq!(capabilities["mcpHostedApproval"], json!(true));
        assert_eq!(capabilities["agentActivityPublishing"], json!(false));
        assert_eq!(capabilities["triage"], json!(true));
        assert_eq!(capabilities["shellOlderSettled"], json!(true));
        assert_eq!(capabilities["shellThreadFamilies"], json!(true));
        if cfg!(not(target_os = "windows")) {
            assert_eq!(capabilities["localServerStop"], json!(true));
        }
        assert_eq!(capabilities["modelCatalogRefresh"], json!(true));
        assert_eq!(capabilities["providerWorkspaceSnapshotsOnDemand"], json!(true));
        assert_eq!(capabilities["questionAttachments"], json!(true));
        std::fs::create_dir_all(&app.auth.replay_dir).unwrap();
        std::fs::write(
            app.auth.replay_dir.join("cloud-publish-agent-activity.bin"),
            "true",
        )
        .unwrap();
        std::fs::write(
            app.auth.replay_dir.join("cloud-relay-url.bin"),
            "https://relay.example.com",
        )
        .unwrap();
        std::fs::write(
            app.auth.replay_dir.join("cloud-relay-environment-credential.bin"),
            "cred",
        )
        .unwrap();
        assert_eq!(
            app.descriptor()["capabilities"]["agentActivityPublishing"],
            json!(true)
        );
        std::fs::remove_file(app.auth.replay_dir.join("cloud-publish-agent-activity.bin")).unwrap();
        std::fs::remove_file(app.auth.replay_dir.join("cloud-relay-url.bin")).unwrap();
        std::fs::remove_file(
            app.auth
                .replay_dir
                .join("cloud-relay-environment-credential.bin"),
        )
        .unwrap();
        app.auth
            .db
            .lock()
            .unwrap()
            .execute("UPDATE auth_sessions SET revoked_at='2020-01-01'", [])
            .unwrap();
        assert!(app
            .authorize(&principal, &request("server.probe", json!({})))
            .is_err());
        tokio::time::timeout(Duration::from_millis(100), app.invalidated(principal))
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cloud_get_relay_client_status_resolves_override_and_missing() {
        use std::os::unix::fs::PermissionsExt as _;
        let (app, mut principal) = setup();
        let req = request("cloud.getRelayClientStatus", json!({}));
        assert!(app.authorize(&principal, &req).is_err());
        principal.scopes.push("relay:read".into());
        app.auth
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET scopes='[\"orchestration:read\",\"relay:read\"]' WHERE session_id='s'",
                [],
            )
            .unwrap();
        assert!(app.authorize(&principal, &req).is_ok());
        assert!(app
            .authorize(
                &principal,
                &request("cloud.getRelayClientStatus", Value::Null),
            )
            .is_err());

        let dir = std::env::temp_dir().join(format!("t3-relay-status-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("cloudflared");
        std::fs::write(
            &exe,
            "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'cloudflared version 2026.10.4'; exit 0; fi\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();

        let previous = std::env::var_os("T3CODE_CLOUDFLARED_PATH");
        unsafe {
            std::env::set_var("T3CODE_CLOUDFLARED_PATH", &exe);
        }
        let available = app.dispatch(principal.clone(), req.clone()).await.unwrap();
        assert_eq!(available["status"], "available");
        assert_eq!(available["source"], "override");
        assert_eq!(available["version"], "2026.10.4");
        assert_eq!(available["executablePath"], exe.to_string_lossy().as_ref());

        unsafe {
            std::env::set_var("T3CODE_CLOUDFLARED_PATH", dir.join("nonexistent"));
        }
        let missing = app.dispatch(principal, req).await.unwrap();
        assert_eq!(
            missing,
            json!({"status": "missing", "version": "2026.10.4"})
        );
        match previous {
            Some(value) => unsafe { std::env::set_var("T3CODE_CLOUDFLARED_PATH", value) },
            None => unsafe { std::env::remove_var("T3CODE_CLOUDFLARED_PATH") },
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn host_resources_rpc_returns_a_snapshot() {
        let (app, principal) = setup();
        let request = request("server.getHostResources", json!({}));
        assert!(app.authorize(&principal, &request).is_ok());
        let result = app.dispatch(principal, request).await.unwrap();
        assert!(result["sampledAt"].as_u64().is_some());
        assert!(result["cpuCount"].as_u64().is_some());
        assert!(result["availableMemoryBytes"].as_u64().is_some());
        assert!(result["totalMemoryBytes"].as_u64().is_some());
    }
    #[test]
    fn descriptor_reports_database_migration_head() {
        let (app, _) = setup();
        {
            let db = app.auth.db.lock().unwrap();
            db.execute_batch("CREATE TABLE effect_sql_migrations(migration_id INTEGER); INSERT INTO effect_sql_migrations VALUES (120);").unwrap();
        }
        let next = Application::new(app.auth.clone(), "env".into(), "host".into());
        assert_eq!(next.descriptor()["databaseMigration"], 120);
    }
    #[tokio::test]
    async fn project_create_is_not_a_v2_orchestration_command() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let app = app.with_event_bus(bus.clone());
        let command = request(
            "orchestration.dispatchCommand",
            json!({"type":"project.create","commandId":"c","projectId":"p","title":"Project","workspaceRoot":"/work"}),
        );
        assert!(app.dispatch(principal, command).await.is_err());
        bus.commit(|tx| {
            let count: i64 =
                tx.query_row("SELECT count(*) FROM projection_projects", [], |r| r.get(0))?;
            assert_eq!(count, 0);
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[tokio::test]
    async fn thread_title_and_link_reads_filter_deleted_and_unknown() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        for (id, archived, deleted) in [
            ("active", None, None),
            ("archived", Some("date"), None),
            ("deleted", None, Some("date")),
        ] {
            db.execute("INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,archived_at,deleted_at,payload_json) VALUES (?1,'p',?2,'codex','full-access','default','now','now',?3,?4,'{}')", rusqlite::params![id, format!("Title {id}"), archived, deleted]).unwrap();
        }
        let app = app.with_event_bus(EventBus::new(db, 16));
        let payload = json!({"threadIds":["active", "archived", "deleted", "missing"]});
        let titles = request("orchestration.getThreadTitles", payload.clone());
        app.authorize(&principal, &titles).unwrap();
        assert_eq!(
            app.dispatch(principal.clone(), titles).await.unwrap(),
            json!({"active":"Title active","archived":"Title archived"})
        );
        let links = request("orchestration.getThreadLinkMetadata", payload);
        app.authorize(&principal, &links).unwrap();
        assert_eq!(
            app.dispatch(principal.clone(), links).await.unwrap(),
            json!({"active":{"title":"Title active","projectId":"p"},"archived":{"title":"Title archived","projectId":"p"}})
        );
        assert_eq!(
            app.dispatch(
                principal.clone(),
                request("orchestration.getThreadTitles", json!({"threadIds":[]}))
            )
            .await
            .unwrap(),
            json!({})
        );
        assert!(app
            .dispatch(
                principal,
                request("orchestration.getThreadTitles", json!({"threadIds":[null]}))
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn launch_root_thread_dispatches_initial_message_and_replays() {
        let (app, mut principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')",[]).unwrap();
        let bus = EventBus::new(db, 16);
        let app = app.with_event_bus(bus.clone());
        principal.scopes.push("orchestration:operate".into());
        let launch = request(
            "orchestration.launchThread",
            json!({"commandId":"launch","threadId":"t","projectId":"p","title":"Hello","generateTitle":true,"creationSource":"web","modelSelection":{"instanceId":"codex","model":"gpt"},"runtimeMode":"full-access","interactionMode":"default","workspaceStrategy":{"type":"root"},"initialMessage":{"messageId":"m","text":"hello","attachments":[]}}),
        );
        let first = app
            .dispatch(principal.clone(), launch.clone())
            .await
            .unwrap();
        assert_eq!(first["threadId"], "t");
        assert_eq!(first["resumed"], false);
        assert_eq!(first["projection"]["messages"][0]["id"], "m");
        let second = app.dispatch(principal, launch).await.unwrap();
        assert_eq!(second["resumed"], true);
        assert_eq!(second["sequence"], first["sequence"]);
        let count=bus.with_autocommit(|db|db.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='thread-title.generate'",[],|r|r.get::<_,i64>(0))).unwrap().unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            second["projection"]["messages"].as_array().unwrap().len(),
            1
        );
    }
    #[tokio::test]
    async fn launch_worktree_prepares_once_and_replays() {
        let root = std::env::temp_dir().join(format!("launch-tree-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .current_dir(&repo)
                .args(args)
                .status()
                .unwrap()
                .success())
        };
        run(&["init", "-q"]);
        run(&["config", "user.name", "Test"]);
        run(&["config", "user.email", "test@example.invalid"]);
        std::fs::write(repo.join("a"), "hello").unwrap();
        run(&["add", "a"]);
        run(&["commit", "-qm", "initial"]);
        let (app, mut principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P',?1,'[]','now','now')",[repo.to_string_lossy().as_ref()]).unwrap();
        let bus = EventBus::new(db, 16);
        bus.set_worktrees_dir(root.join("trees"));
        let app = app.with_event_bus(bus.clone());
        principal.scopes.push("orchestration:operate".into());
        let launch = request(
            "orchestration.launchThread",
            json!({"commandId":"launch-wt","threadId":"t","projectId":"p","title":"Hello","modelSelection":{"instanceId":"codex","model":"gpt"},"runtimeMode":"full-access","interactionMode":"default","workspaceStrategy":{"type":"worktree","baseRef":"HEAD"},"initialMessage":{"messageId":"m","text":"hello","attachments":[]}}),
        );
        let first = app
            .dispatch(principal.clone(), launch.clone())
            .await
            .unwrap();
        let path = first["projection"]["thread"]["worktreePath"]
            .as_str()
            .unwrap();
        assert!(std::path::Path::new(path).join("a").exists());
        let second = app.dispatch(principal, launch).await.unwrap();
        assert_eq!(second["resumed"], true);
        assert_eq!(second["projection"]["thread"]["worktreePath"], path);
        assert_eq!(
            second["projection"]["messages"].as_array().unwrap().len(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn thread_create_dispatch_stamps_provenance_and_replays() {
        let (app, mut principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let app = app.with_event_bus(bus.clone());
        principal.scopes.push("orchestration:operate".into());
        app.auth
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET scopes=?1",
                [serde_json::to_string(&principal.scopes).unwrap()],
            )
            .unwrap();
        let command = request(
            "orchestration.dispatchCommand",
            json!({
                "type":"thread.create", "commandId":"c", "threadId":"t", "projectId":"p", "title":"New",
                "createdBy":"agent", "creationSource":"mobile", "modelSelection":{"provider":"codex","model":"gpt"},
                "runtimeMode":"full-access", "interactionMode":"default", "branch":null, "worktreePath":null,
                "linkOrigin":{"forged":true}, "delegatedFrom":{"forged":true}
            }),
        );
        app.authorize(&principal, &command).unwrap();
        assert_eq!(
            app.dispatch(principal.clone(), command.clone())
                .await
                .unwrap(),
            json!({"sequence":1})
        );
        assert_eq!(
            app.dispatch(principal.clone(), command).await.unwrap(),
            json!({"sequence":1})
        );
        bus.commit(|tx| {
            let payload: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            let payload: Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(payload["createdBy"], "user");
            assert_eq!(payload["creationSource"], "mobile");
            assert_eq!(
                payload["modelSelection"],
                json!({"instanceId":"codex","model":"gpt"})
            );
            assert!(payload.get("linkOrigin").is_none());
            assert!(payload.get("delegatedFrom").is_none());
            Ok(((), vec![]))
        })
        .unwrap();
        let mut bad = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.create", "commandId":"bad", "threadId":"x", "projectId":"p", "title":"X", "createdBy":"user", "creationSource":"web", "modelSelection":{"instanceId":"codex","model":"gpt"}, "runtimeMode":"full-access", "interactionMode":"default", "branch":null, "worktreePath":null, "importedNativeThread":{}}),
        );
        assert!(app.dispatch(principal.clone(), bad.clone()).await.is_err());
        bad.payload
            .as_object_mut()
            .unwrap()
            .remove("importedNativeThread");
        bad.payload["runtimeMode"] = json!("invalid");
        assert!(app.dispatch(principal, bad).await.is_err());
    }
    #[tokio::test]
    async fn deferred_dispatch_and_release_use_public_commands() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')",[]).unwrap();
        let bus = EventBus::new(db, 16);
        let app = app.with_event_bus(bus.clone());
        app.dispatch(principal.clone(),request("orchestration.dispatchCommand",json!({"type":"thread.create","commandId":"create","threadId":"t","projectId":"p","title":"T","createdBy":"user","creationSource":"web","modelSelection":{"instanceId":"codex","model":"m"},"runtimeMode":"auto","interactionMode":"default","branch":null,"worktreePath":null}))).await.unwrap();
        app.dispatch(principal.clone(),request("orchestration.dispatchCommand",json!({"type":"message.dispatch","commandId":"send","threadId":"t","messageId":"m","text":"hello","attachments":[],"createdBy":"user","creationSource":"web","dispatchMode":{"type":"defer_start","workspaceStrategy":{"type":"root"}}}))).await.unwrap();
        let run=bus.commit(|tx| {let (id,status):(String,String)=tx.query_row("SELECT run_id,status FROM orchestration_v2_projection_runs WHERE thread_id='t'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(status,"preparing");Ok((id,vec![]))}).unwrap();
        app.dispatch(principal,request("orchestration.dispatchCommand",json!({"type":"prepared-run.release","commandId":"release","threadId":"t","runId":run}))).await.unwrap();
        bus.commit(|tx| {
            let status: String = tx.query_row(
                "SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(status, "starting");
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[tokio::test]
    async fn fresh_deferred_dispatch_and_release_keep_context_boundary() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]','now','now')",[]).unwrap();
        let bus = EventBus::new(db, 16);
        let app = app.with_event_bus(bus.clone());
        app.dispatch(principal.clone(),request("orchestration.dispatchCommand",json!({"type":"thread.create","commandId":"create","threadId":"t","projectId":"p","title":"T","createdBy":"user","creationSource":"web","modelSelection":{"instanceId":"codex","model":"m"},"runtimeMode":"auto","interactionMode":"default","branch":null,"worktreePath":null}))).await.unwrap();
        app.dispatch(principal.clone(),request("orchestration.dispatchCommand",json!({"type":"message.dispatch","commandId":"send","threadId":"t","messageId":"m","text":"hello","attachments":[],"createdBy":"user","creationSource":"web","freshContext":true,"dispatchMode":{"type":"defer_start","workspaceStrategy":{"type":"root"}}}))).await.unwrap();
        let run=bus.commit(|tx| {let (id,status):(String,String)=tx.query_row("SELECT run_id,status FROM orchestration_v2_projection_runs WHERE thread_id='t'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(status,"preparing");let fresh:bool=tx.query_row("SELECT json_extract(payload_json,'$.freshContext') FROM orchestration_v2_projection_runs WHERE run_id=?1",[&id],|r|r.get(0))?;assert!(fresh);let starts:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.start'",[],|r|r.get(0))?;assert_eq!(starts,0);Ok((id,vec![]))}).unwrap();
        app.dispatch(principal,request("orchestration.dispatchCommand",json!({"type":"prepared-run.release","commandId":"release","threadId":"t","runId":run}))).await.unwrap();
        bus.commit(|tx| {
            let status: String = tx.query_row(
                "SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(status, "starting");
            let fresh:bool=tx.query_row("SELECT json_extract(payload_json,'$.freshContext') FROM orchestration_v2_projection_runs WHERE thread_id='t'",[],|r|r.get(0))?;assert!(fresh);
            let count:i64=tx.query_row("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.start' AND status='pending'",[],|r|r.get(0))?;assert_eq!(count,1);
            Ok(((), vec![]))
        })
        .unwrap();
    }
    #[tokio::test]
    async fn model_selection_command_updates_thread_and_rejects_unknown_instance() {
        let (mut app, principal) = setup();
        app.settings = Arc::new(crate::settings::Settings::new(
            std::env::temp_dir().join(format!("t3-model-selection-{}.json", uuid::Uuid::new_v4())),
        ));
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        app = app.with_event_bus(bus.clone());
        let create = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.create","commandId":"create","threadId":"t","projectId":"p","title":"T","createdBy":"user","creationSource":"web","modelSelection":{"instanceId":"codex","model":"old"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null}),
        );
        app.dispatch(principal.clone(), create).await.unwrap();
        let change = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.model-selection.set","commandId":"change","threadId":"t","modelSelection":{"instanceId":"codex","model":"new"}}),
        );
        let first = app
            .dispatch(principal.clone(), change.clone())
            .await
            .unwrap();
        assert_eq!(
            app.dispatch(principal.clone(), change).await.unwrap(),
            first
        );
        bus.commit(|tx| { let model:String=tx.query_row("SELECT json_extract(payload_json,'$.modelSelection.model') FROM orchestration_v2_projection_threads WHERE thread_id='t'", [], |r| r.get(0))?; assert_eq!(model,"new"); Ok(((), vec![])) }).unwrap();
        let missing = request(
            "orchestration.dispatchCommand",
            json!({"type":"provider.switch","commandId":"missing","threadId":"t","modelSelection":{"instanceId":"missing","model":"x"}}),
        );
        assert!(app.dispatch(principal, missing).await.is_err());
    }
    #[tokio::test]
    async fn message_and_response_rpc_use_receipts_and_reject_unsupported_options() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let app = app.with_event_bus(bus.clone());
        let project = request(
            "orchestration.dispatchCommand",
            json!({"type":"project.create","commandId":"p","projectId":"p","title":"P","workspaceRoot":"/tmp"}),
        );
        assert!(app.dispatch(principal.clone(), project).await.is_err());
        crate::project_sink::create_project_ordered(
            &bus,
            crate::project_commands::CreateProject {
                command_id: "p",
                project_id: "p",
                title: "P",
                workspace_root: "/tmp",
                scripts: None,
            },
            "event",
            "2026-01-01T00:00:00Z",
        )
        .unwrap();
        let thread = request(
            "orchestration.dispatchCommand",
            json!({"type":"thread.create","commandId":"t","threadId":"t","projectId":"p","title":"T","createdBy":"user","creationSource":"web","modelSelection":{"instanceId":"codex","model":"gpt"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null}),
        );
        app.dispatch(principal.clone(), thread).await.unwrap();
        let send = request(
            "orchestration.dispatchCommand",
            json!({"type":"message.dispatch","commandId":"send","threadId":"t","messageId":"m","text":"hello","attachments":[],"createdBy":"agent","creationSource":"web","dispatchMode":{"type":"queue_after_active"}}),
        );
        let first = app.dispatch(principal.clone(), send.clone()).await.unwrap();
        assert_eq!(
            app.dispatch(principal.clone(), send.clone()).await.unwrap(),
            first
        );
        bus.commit(|tx| {
            let raw: String = tx.query_row("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id='m'", [], |r| r.get(0))?;
            assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["createdBy"], "user");
            assert_eq!(crate::outbox::list_by_command_id(tx, "send")?.len(), 1);
            Ok(((), vec![]))
        }).unwrap();
        let mut selected = send.clone();
        selected.payload["commandId"] = json!("selected");
        selected.payload["messageId"] = json!("selected-message");
        selected.payload["modelSelection"] =
            json!({"instanceId":"codex","model":"different-model"});
        app.dispatch(principal.clone(), selected.clone())
            .await
            .unwrap();
        app.dispatch(principal.clone(), selected).await.unwrap();
        bus.commit(|tx| {
            let selection: String = tx.query_row("SELECT json_extract(payload_json,'$.modelSelection.model') FROM orchestration_v2_projection_runs WHERE thread_id='t' AND json_extract(payload_json,'$.userMessageId')='selected-message'", [], |r| r.get(0))?;
            let default: String = tx.query_row("SELECT json_extract(payload_json,'$.modelSelection.model') FROM orchestration_v2_projection_threads WHERE thread_id='t'", [], |r| r.get(0))?;
            assert_eq!(selection, "different-model");
            assert_eq!(default, "gpt");
            Ok(((), vec![]))
        }).unwrap();
        let mut invalid_selection = send.clone();
        invalid_selection.payload["commandId"] = json!("invalid-selection");
        invalid_selection.payload["messageId"] = json!("invalid-selection-message");
        invalid_selection.payload["modelSelection"] = json!({"instanceId":"codex","model":""});
        assert!(app
            .dispatch(principal.clone(), invalid_selection)
            .await
            .is_err());
        let mut immediate = send.clone();
        immediate.payload["commandId"] = json!("immediate");
        immediate.payload["messageId"] = json!("m2");
        immediate.payload["dispatchMode"] = json!({"type":"start_immediately"});
        match app
            .dispatch(principal.clone(), immediate)
            .await
            .unwrap_err()
        {
            RpcFailure::Fail(e) => assert_eq!(
                e["detail"],
                "Immediate dispatch while a run is active is not supported."
            ),
            _ => panic!("expected domain rejection"),
        }
        let stop = request(
            "orchestration.dispatchCommand",
            json!({"type":"run.interrupt","commandId":"stop","threadId":"t","runId":"run:thread:t:ordinal:1"}),
        );
        let stopped = app.dispatch(principal.clone(), stop.clone()).await.unwrap();
        assert_eq!(
            app.dispatch(principal.clone(), stop).await.unwrap(),
            stopped
        );
        bus.commit(|tx| {
            let status: String = tx.query_row(
                "SELECT status FROM orchestration_v2_projection_runs WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(status, "interrupted");
            Ok(((), vec![]))
        })
        .unwrap();
        let mut bad = send;
        bad.payload["attachments"] = json!([{}]);
        assert!(app.dispatch(principal.clone(), bad).await.is_err());
        let response = request(
            "orchestration.dispatchCommand",
            json!({"type":"runtime-request.respond","commandId":"reply","threadId":"t","requestId":"missing","decision":"accept"}),
        );
        match app.dispatch(principal.clone(), response).await.unwrap_err() {
            RpcFailure::Fail(e) => {
                assert_eq!(e["detail"], "This question has already been answered.")
            }
            _ => panic!("expected domain rejection"),
        }
        let accept_always = request(
            "orchestration.dispatchCommand",
            json!({"type":"runtime-request.respond","commandId":"reply-always","threadId":"t","requestId":"missing","decision":"acceptAlways"}),
        );
        match app.dispatch(principal, accept_always).await.unwrap_err() {
            RpcFailure::Fail(e) => {
                assert_eq!(e["detail"], "This question has already been answered.")
            }
            _ => panic!("expected domain rejection"),
        }
    }
    #[tokio::test]
    async fn shell_and_thread_subscriptions_capture_snapshots_and_live_changes() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let app = app.with_event_bus(bus.clone());
        let shell = request(
            "orchestration.subscribeShell",
            json!({"requestCompletionMarker":true}),
        );
        app.authorize(&principal, &shell).unwrap();
        let mut stream = app.stream(principal.clone(), &shell).unwrap();
        let initial = stream.recv().await.unwrap().unwrap();
        assert_eq!(
            initial,
            vec![
                json!({"kind":"snapshot","snapshot":{"schemaVersion":2,"snapshotSequence":0,"projects":[],"threads":[],"archivedThreads":[]}}),
                json!({"kind":"synchronized"})
            ]
        );
        crate::project_sink::create_project_ordered(
            &bus,
            crate::project_commands::CreateProject {
                command_id: "p-cmd",
                project_id: "p",
                title: "Project",
                workspace_root: "/work",
                scripts: None,
            },
            "p-event",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let live = stream.recv().await.unwrap().unwrap();
        assert_eq!(live[0]["kind"], "project.updated");
        assert_eq!(live[0]["sequence"], 1);
        assert_eq!(live[0]["project"]["id"], "p");
        crate::thread_commands::create_thread_ordered(
            &bus,
            crate::thread_commands::CreateThread {
                command_id: "t-cmd",
                thread_id: "t",
                project_id: "p",
                title: "Thread",
                model_selection: &json!({"instanceId":"codex","model":"gpt"}),
                runtime_mode: "full-access",
                interaction_mode: "default",
                branch: None,
                worktree_path: None,
                created_by: "user",
                creation_source: &json!("web"),
                link_origin: None,
                delegated_from: None,
            },
            "t-event",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        let replay_shell = request(
            "orchestration.subscribeShell",
            json!({"afterSequence":0,"httpSnapshotFallback":true,"requestCompletionMarker":true}),
        );
        let mut replay_shell = app.stream(principal.clone(), &replay_shell).unwrap();
        let replayed_shell = replay_shell.recv().await.unwrap().unwrap();
        assert_eq!(replayed_shell[0]["kind"], "project.updated");
        assert_eq!(replayed_shell[0]["sequence"], 1);
        assert_eq!(replayed_shell[1]["kind"], "thread.updated");
        assert_eq!(replayed_shell[1]["sequence"], 2);
        assert_eq!(replayed_shell.last(), Some(&json!({"kind":"synchronized"})));
        let stale_shell = request(
            "orchestration.subscribeShell",
            json!({"afterSequence":100,"httpSnapshotFallback":true}),
        );
        let mut stale_shell = app.stream(principal.clone(), &stale_shell).unwrap();
        assert_eq!(
            stale_shell.recv().await.unwrap().unwrap(),
            vec![json!({"kind":"snapshot-required"})]
        );
        let request = request(
            "orchestration.subscribeThread",
            json!({"threadId":"t","requestCompletionMarker":true,"acceptBoundedSnapshot":true}),
        );
        let mut thread = app.stream(principal.clone(), &request).unwrap();
        let initial = thread.recv().await.unwrap().unwrap();
        assert_eq!(initial[0]["snapshotSequence"], 2);
        assert_eq!(initial[0]["projection"]["thread"]["id"], "t");
        assert_eq!(initial[0]["hasMoreHistory"], false);
        assert_eq!(initial[1], json!({"kind":"synchronized"}));
        bus.commit(|tx| {
            let event = crate::event_store::Event {
                id: "update-event".into(),
                aggregate_kind: "thread".into(),
                stream_id: "t".into(),
                event_type: "thread.updated".into(),
                occurred_at: "2026-01-01T00:00:01.000Z".into(),
                command_id: None,
                causation_event_id: None,
                correlation_id: None,
                actor_kind: "server".into(),
                payload: json!({"title":"Updated"}),
                metadata: json!({}),
            };
            let events = crate::event_store::append(tx, &[event])?;
            Ok(((), events))
        })
        .unwrap();
        let replay = super::tests::request(
            "orchestration.subscribeThread",
            json!({"threadId":"t","afterSequence":2,"requestCompletionMarker":true}),
        );
        let mut replayed = app.stream(principal.clone(), &replay).unwrap();
        let replayed = replayed.recv().await.unwrap().unwrap();
        assert_eq!(replayed[0]["kind"], "event");
        assert_eq!(replayed[0]["sequence"], 3);
        assert_eq!(replayed[0]["event"]["payload"]["title"], "Updated");
        assert_eq!(replayed[1], json!({"kind":"synchronized"}));
        let resume = super::tests::request(
            "orchestration.subscribeThread",
            json!({"threadId":"t","afterSequence":3,"requestCompletionMarker":true}),
        );
        let mut resumed = app.stream(principal, &resume).unwrap();
        assert_eq!(
            resumed.recv().await.unwrap().unwrap(),
            vec![json!({"kind":"synchronized"})]
        );
    }
    #[tokio::test]
    async fn unreadable_secret_check_returns_safe_failure() {
        let (app, principal) = setup();
        let response = app
            .dispatch(
                principal,
                request(
                    "server.checkSecretSource",
                    json!({"source":{"provider":"unknown", "reference":"op://v/i/f"}}),
                ),
            )
            .await
            .unwrap();
        assert_eq!(response["_tag"], "Failed");
        assert!(response["detail"].as_str().unwrap().contains("unknown"));
        assert!(!response.to_string().contains("op://"));
    }

    #[test]
    fn missing_credentials_fail_closed() {
        let (app, _) = setup();
        let e = app
            .authenticate(&HeaderMap::new(), &HashMap::new())
            .unwrap_err();
        assert_eq!(e.status, 401);
        assert_eq!(e.body["reason"], "missing_credential");
    }
    #[tokio::test]
    async fn prepare_triage_and_stop_local_server_rpcs_work() {
        let (app, mut principal) = setup();
        principal.scopes = vec![
            "orchestration:read".into(),
            "orchestration:operate".into(),
            "terminal:operate".into(),
        ];
        app.auth
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET scopes = ?1 WHERE session_id = 's'",
                [serde_json::to_string(&principal.scopes).unwrap()],
            )
            .unwrap();
        let dir = std::env::temp_dir().join(format!("t3-app-triage-{}", uuid::Uuid::new_v4()));
        let paths = crate::runtime::ServerPaths::new(dir.clone(), false, true, None);
        let app = app.with_runtime_paths(&dir, &paths);

        let bad_triage = request("server.prepareTriage", json!({}));
        app.authorize(&principal, &bad_triage).unwrap();
        assert!(app.dispatch(principal.clone(), bad_triage).await.is_err());

        let triage_req = request("server.prepareTriage", json!({"client":{"label":"Web"}}));
        app.authorize(&principal, &triage_req).unwrap();
        let triage_res = app.dispatch(principal.clone(), triage_req).await.unwrap();
        let prompt = triage_res["prompt"].as_str().unwrap();
        assert!(prompt.starts_with("Read [triage-playbook.md]("));
        assert!(prompt.ends_with(" and follow it. "));

        let bad_stop = request("preview.stopLocalServer", json!({"pid":0,"port":3000}));
        app.authorize(&principal, &bad_stop).unwrap();
        assert!(app.dispatch(principal.clone(), bad_stop).await.is_err());

        let missing_stop = request("preview.stopLocalServer", json!({"pid":999_999,"port":65_432}));
        app.authorize(&principal, &missing_stop).unwrap();
        let stop_err = app.dispatch(principal, missing_stop).await.unwrap_err();
        match stop_err {
            RpcFailure::Fail(val) => {
                assert_eq!(val["_tag"], "PreviewStopLocalServerError");
                assert_eq!(val["reason"], "not-found");
            }
            other => panic!("unexpected error: {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn shell_thread_families_and_older_settled_rpcs_work() {
        let (app, principal) = setup();
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        db.execute(
            "INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p1','Project 1','/tmp/p1','[]','2026-01-01','2026-01-01')",
            [],
        )
        .unwrap();
        for i in 0..27 {
            let id = format!("settled-{i:02}");
            let settled_at = format!("2026-01-{:02}T00:00:00.000Z", i + 1);
            let payload = json!({
                "id": id,
                "projectId": "p1",
                "title": id,
                "modelSelection": {"instanceId":"codex","model":"gpt-5"},
                "runtimeMode": "auto",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": if i == 0 { Value::String("/tmp/wt-1".into()) } else { Value::Null },
                "lineage": {"parentThreadId":null,"relationshipToParent":null,"rootThreadId":id},
                "settledOverride": "settled",
                "settledAt": settled_at,
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": settled_at
            });
            db.execute(
                "INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,payload_json,created_at,updated_at) VALUES(?1,'p1',?1,'codex','auto','default',?2,'2026-01-01',?3)",
                rusqlite::params![id, payload.to_string(), settled_at],
            )
            .unwrap();
        }
        let sub_payload = json!({
            "id": "sub-idle",
            "projectId": "p1",
            "title": "Sub",
            "modelSelection": {"instanceId":"codex","model":"gpt-5"},
            "runtimeMode": "auto",
            "interactionMode": "default",
            "branch": null,
            "worktreePath": "/tmp/wt-1",
            "lineage": {"parentThreadId":"settled-26","relationshipToParent":"subagent","rootThreadId":"settled-26"},
            "status": "idle",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-28T00:00:00.000Z"
        });
        db.execute(
            "INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,payload_json,created_at,updated_at) VALUES('sub-idle','p1','Sub','codex','auto','default',?1,'2026-01-01','2026-01-28T00:00:00.000Z')",
            [sub_payload.to_string()],
        )
        .unwrap();

        let bus = EventBus::new(db, 16);
        let app = app.with_event_bus(bus);

        let full = app
            .dispatch(principal.clone(), request("orchestration.getShellSnapshot", json!({})))
            .await
            .unwrap();
        assert_eq!(full["threads"].as_array().unwrap().len(), 28);
        let seq = full["snapshotSequence"].as_i64().unwrap();

        let resumable = app
            .dispatch(
                principal.clone(),
                request("orchestration.getShellSnapshot", json!({"resumeFrom": seq})),
            )
            .await
            .unwrap();
        assert_eq!(resumable, json!({"resumable": true}));

        let trimmed = app
            .dispatch(
                principal.clone(),
                request(
                    "orchestration.getShellSnapshot",
                    json!({"omitIdleSubagents": true, "omitOlderSettled": true}),
                ),
            )
            .await
            .unwrap();
        assert_eq!(trimmed["threads"].as_array().unwrap().len(), 25);
        assert_eq!(trimmed["olderSettled"]["counts"][0]["projectId"], "p1");
        assert_eq!(trimmed["olderSettled"]["counts"][0]["count"], 2);

        let family = app
            .dispatch(
                principal.clone(),
                request("orchestration.getThreadFamily", json!({"threadId": "sub-idle"})),
            )
            .await
            .unwrap();
        assert_eq!(family["threads"].as_array().unwrap().len(), 2);

        let wt = app
            .dispatch(
                principal.clone(),
                request("orchestration.getWorktreeThreadIds", json!({"worktreePath": "/tmp/wt-1"})),
            )
            .await
            .unwrap();
        assert_eq!(wt["threadIds"], json!(["settled-00", "sub-idle"]));

        let before = trimmed["olderSettled"]["before"].as_str().unwrap();
        let older_counts = app
            .dispatch(
                principal.clone(),
                request(
                    "orchestration.getOlderSettledThreads",
                    json!({"before":{"settledAt":before},"limit":0}),
                ),
            )
            .await
            .unwrap();
        assert_eq!(older_counts["threads"], json!([]));
        assert_eq!(older_counts["counts"][0]["count"], 2);

        let older_page = app
            .dispatch(
                principal,
                request(
                    "orchestration.getOlderSettledThreads",
                    json!({"before":{"settledAt":before},"limit":10}),
                ),
            )
            .await
            .unwrap();
        assert_eq!(older_page["threads"].as_array().unwrap().len(), 2);
        assert_eq!(older_page["threads"][0]["id"], "settled-01");
        assert_eq!(older_page["threads"][1]["id"], "settled-00");
    }

    #[tokio::test]
    async fn model_catalog_only_returns_empty_providers() {
        let (app, principal) = setup();
        let response = app
            .dispatch(
                principal,
                request("server.refreshProviders", json!({"modelCatalogOnly": true})),
            )
            .await
            .unwrap();
        assert_eq!(response, json!({"providers": []}));
    }

    #[test]
    fn workspace_snapshots_on_demand_strips_and_digests_catalogs() {
        let provider = json!({
            "instanceId": "codex",
            "driver": "codex",
            "checkedAt": "2026-01-01T00:00:00.000Z",
            "slashCommands": [{"name": "compact", "description": "Full description", "input": {"hint": "h"}}],
            "skills": [{"name": "skill-a", "description": "Desc", "shortDescription": "Short", "path": "/a", "enabled": true}],
            "workspaceSnapshots": [{"cwd": "/repo", "checkedAt": "2026-01-01T00:00:00.000Z", "slashCommands": [], "skills": []}]
        });

        let stripped = without_workspace_snapshots(vec![provider.clone()], true, false);
        assert!(stripped[0].get("workspaceSnapshots").is_none());
        assert_eq!(stripped[0]["slashCommands"], json!([{"name": "compact"}]));
        assert_eq!(
            stripped[0]["skills"],
            json!([{"name": "skill-a", "path": "/a", "enabled": true}])
        );

        let digested = without_workspace_snapshots(vec![provider.clone()], true, true);
        assert!(digested[0].get("workspaceSnapshots").is_none());
        assert_eq!(digested[0]["slashCommands"], json!([]));
        assert_eq!(digested[0]["skills"], json!([]));
        assert_eq!(
            digested[0]["catalogDigest"].as_str().map(str::len),
            Some(16)
        );

        let fallback = workspace_snapshot_or_catalog(&provider, "/other", true);
        assert_eq!(fallback.as_array().unwrap().len(), 1);
        assert_eq!(fallback[0]["cwd"], "/other");
        assert_eq!(fallback[0]["slashCommandsPending"], json!(true));
    }

    #[tokio::test]
    async fn refresh_providers_and_subscribe_config_honor_workspace_snapshots_on_demand() {
        let (app, principal) = setup();
        *app.provider_cache.lock().unwrap() = Some(vec![json!({
            "instanceId": "codex",
            "driver": "codex",
            "checkedAt": "2026-01-01T00:00:00.000Z",
            "models": [{"slug": "gpt-5"}],
            "slashCommands": [{"name": "compact", "description": "Full"}],
            "skills": [{"name": "s1", "description": "D", "path": "/s1", "enabled": true}],
            "workspaceSnapshots": [{"cwd": "/a", "checkedAt": "2026-01-01T00:00:00.000Z", "slashCommands": [], "skills": []}]
        })]);

        let mut rx = app
            .stream(
                principal.clone(),
                &request(
                    "subscribeServerConfig",
                    json!({
                        "workspaceSnapshotsOnDemand": true,
                        "providerCatalogsOnDemand": true,
                        "providerCatalogDigests": true
                    }),
                ),
            )
            .unwrap();
        let events = rx.recv().await.unwrap().unwrap();
        let p = &events[0]["config"]["providers"][0];
        assert!(p.get("workspaceSnapshots").is_none());
        assert_eq!(p["slashCommands"], json!([]));
        assert_eq!(p["skills"], json!([]));
        assert!(p["catalogDigest"].is_string());

        let omitted = app
            .dispatch(
                principal,
                request(
                    "server.refreshProviders",
                    json!({"workspaceSnapshotsOnDemand": true, "omitProviders": true}),
                ),
            )
            .await
            .unwrap();
        assert_eq!(omitted, json!({"providers": []}));
    }

    #[tokio::test]
    async fn runtime_request_respond_claims_and_persists_question_attachments() {
        let (mut app, mut principal) = setup();
        principal.scopes.push("orchestration:write".into());
        let dir = std::env::temp_dir().join(format!("t3-q-att-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        app.attachments_dir = dir;
        let mut db = Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus = EventBus::new(db, 16);
        let app = app.with_event_bus(bus.clone());

        let pending_id = crate::attachment_paths::pending_id(Some("txt"));
        let claims = crate::attachment_store::UploadClaims {
            version: 1,
            kind: "attachmentUpload".into(),
            attachment_type: "file".into(),
            attachment_id: pending_id.clone(),
            name: "notes.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 5,
            expires_at: i64::MAX,
        };
        crate::attachment_store::publish_upload(&app.attachments_dir, &claims, b"hello").unwrap();

        bus.commit(|tx| {
            tx.execute(
                "INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json) VALUES('node-q','t','r','root','root','user_input_request','waiting','pt','pv','now',NULL,'{\"id\":\"node-q\",\"status\":\"waiting\"}')",
                [],
            )?;
            tx.execute(
                "INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,provider_turn_id,kind,status,created_at,resolved_at,payload_json) VALUES('req-q','t','node-q','pv','user_input','pending','now',NULL,'{\"id\":\"req-q\",\"threadId\":\"t\",\"nodeId\":\"node-q\",\"kind\":\"user_input\",\"status\":\"pending\",\"responseCapability\":{\"type\":\"live\",\"providerSessionId\":\"ps-1\"}}')",
                [],
            )?;
            tx.execute(
                "INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,ordinal,type,status,updated_at,payload_json) VALUES('item-q','t','r','node-q','pt','pv',1,'user_input_request','waiting','now','{\"id\":\"item-q\",\"threadId\":\"t\",\"nodeId\":\"node-q\",\"type\":\"user_input_request\",\"requestId\":\"req-q\",\"status\":\"waiting\",\"questions\":[{\"id\":\"q1\",\"question\":\"Attach file?\"}]}')",
                [],
            )?;
            Ok(((), vec![]))
        }).unwrap();

        let resp = app
            .dispatch(
                principal,
                request(
                    "orchestration.dispatchCommand",
                    json!({
                        "type": "runtime-request.respond",
                        "commandId": "cmd-q1",
                        "threadId": "t",
                        "requestId": "req-q",
                        "answers": {"q1": "See attached"},
                        "attachmentsByQuestionId": {
                            "q1": [{
                                "type": "file",
                                "id": pending_id,
                                "name": "notes.txt",
                                "mimeType": "text/plain",
                                "sizeBytes": 5
                            }]
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        assert!(resp["sequence"].is_number());

        bus.commit(|tx| {
            let raw: String = tx.query_row(
                "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='item-q'",
                [],
                |r| r.get(0),
            )?;
            let item: Value = serde_json::from_str(&raw).unwrap();
            let claimed = &item["questionAnswer"]["attachmentsByQuestionId"]["q1"];
            assert_eq!(claimed.as_array().unwrap().len(), 1);
            let claimed_id = claimed[0]["id"].as_str().unwrap();
            assert_ne!(claimed_id, pending_id);
            assert!(crate::attachment_paths::find_by_id(&app.attachments_dir, claimed_id).is_some());
            let answer_text = item["questionAnswer"]["answers"]["q1"].as_str().unwrap();
            assert!(answer_text.starts_with("See attached\n\nAttached file \"notes.txt\": "));
            Ok(((), vec![]))
        })
        .unwrap();
    }
}

#[cfg(test)]
mod secret_provider_invalidation_tests {
    use super::*;

    #[test]
    fn label_edits_keep_cached_secrets_but_configuration_edits_clear_them() {
        let sessions =
            std::sync::Arc::new(crate::provider::session_registry::SessionRegistry::default());
        let old = json!({"vault":{"kind":"one_password","label":"Old","config":{"account":"my"}}});
        let renamed =
            json!({"vault":{"kind":"one_password","label":"New","config":{"account":"my"}}});
        let changed =
            json!({"vault":{"kind":"one_password","label":"New","config":{"account":"work"}}});
        sessions
            .secrets
            .apply("vault", "op://v/i/f", "value".into())
            .unwrap();
        invalidate_changed_secret_providers(&sessions, &old, &renamed).unwrap();
        assert_eq!(
            sessions
                .secrets
                .get("vault", "op://v/i/f")
                .unwrap()
                .as_deref(),
            Some("value")
        );
        invalidate_changed_secret_providers(&sessions, &renamed, &changed).unwrap();
        assert_eq!(sessions.secrets.get("vault", "op://v/i/f").unwrap(), None);
    }
}
