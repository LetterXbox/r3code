//! `server.searchAcpRegistry` / `server.prepareAcpRegistryAgent`: search and
//! install agents from the public ACP Registry (the "Or choose from ACP
//! Registry" step of the Add Provider wizard).
//!
//! The registry URL, JSON schema (`id`/`name`/`version`/`description`/
//! `authors`/`license`/`website`/`repository`/`icon`/`distribution`), the
//! `binary`/`npx`/`uvx` distribution shapes and the response shapes this
//! module returns are mirrored from the TypeScript reference implementation
//! at t3code's `packages/provider-acp-registry/src/server/AcpRegistrySupport.ts`
//! and `AcpRegistryProbe.ts` (read-only reference; not vendored here), and
//! cross-checked against `t3ui/backend/rpcResultSchemas.json`.
//!
//! The registry URL, the `<os>-<arch>` platform key format and the atomic
//! download/verify/extract-to-a-`.tmp-*`-dir-then-rename install pattern used
//! by `install_binary` below were cross-checked against zuse's Rust port of
//! the same registry: `zuse/crates/protocol/src/custom_acp/catalog.rs`
//! (registry schema, platform key, cache TTL) and
//! `zuse/crates/providers/src/archive_install.rs` (install layout).
//!
//! Scope note: this module only implements search and prepare (ensuring an
//! agent's distribution is resolvable/installed and reporting back the
//! normalized agent). It deliberately does not attempt the TypeScript
//! reference's npm/uv *global* package installation optimization: `npx`/
//! `uvx` already install on demand when the agent process is launched, so
//! prepare only checks that the runner is on `PATH`. Launch-time resolution
//! of a non-local `acpRegistry` provider instance into a `commandPath` (see
//! `acp_executor.rs`'s `launch()`) is a separate, pre-existing gap not
//! addressed here: the Add Provider wizard never persists a resolved
//! command into the instance config (it stores just `{agentId,
//! distribution:"auto"}`), so that wiring is out of scope for this change.

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/// The UI's `ACP_REGISTRY_MAX_AGENTS` (AcpRegistrySearchStep.tsx).
pub const MAX_AGENTS: usize = 50;
const MAX_REGISTRY_BYTES: usize = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
/// Searches reuse an index fetched this recently; prepare always fetches fresh.
const SEARCH_CACHE_MAX_AGE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Deserialize)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub distribution: Distribution,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Distribution {
    #[serde(default)]
    pub binary: HashMap<String, BinaryTarget>,
    #[serde(default)]
    pub npx: Option<Package>,
    #[serde(default)]
    pub uvx: Option<Package>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Package {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistryEnvelope {
    #[serde(default)]
    agents: Vec<RegistryAgent>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DistKind {
    Binary,
    Npx,
    Uvx,
}
impl DistKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DistKind::Binary => "binary",
            DistKind::Npx => "npx",
            DistKind::Uvx => "uvx",
        }
    }
}

/// This machine's registry platform key (`darwin-aarch64`, `linux-x86_64`…).
pub fn platform_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => "",
    }
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

fn is_safe_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// Parses the registry index, discarding entries with an unusable id/version
/// (mirrors the TS reference's "ignored invalid ACP Registry entries").
pub fn parse_registry(bytes: &[u8]) -> Result<Vec<RegistryAgent>, String> {
    let envelope: RegistryEnvelope = serde_json::from_slice(bytes)
        .map_err(|error| format!("ACP Registry returned an invalid index: {error}"))?;
    Ok(envelope
        .agents
        .into_iter()
        .filter(|agent| {
            is_safe_id(&agent.id) && !agent.name.trim().is_empty() && is_safe_version(&agent.version)
        })
        .collect())
}

/// How `agent` would be launched on `platform`, preferring binary, then npx,
/// then uvx (the TS reference's "auto" preference order). An agent whose only
/// binary targets are for other platforms is still returned (as `Binary`, with
/// no target for this platform) so search can still show it; `prepare` rejects
/// that case explicitly.
pub fn resolve_distribution<'a>(
    agent: &'a RegistryAgent,
    platform: &str,
) -> Option<(DistKind, Option<&'a BinaryTarget>)> {
    if let Some(target) = agent.distribution.binary.get(platform) {
        return Some((DistKind::Binary, Some(target)));
    }
    if agent.distribution.npx.is_some() {
        return Some((DistKind::Npx, None));
    }
    if agent.distribution.uvx.is_some() {
        return Some((DistKind::Uvx, None));
    }
    if !agent.distribution.binary.is_empty() {
        return Some((DistKind::Binary, None));
    }
    None
}

fn agent_summary_json(agent: &RegistryAgent, platform: &str) -> Value {
    let (kind, binary) =
        resolve_distribution(agent, platform).unwrap_or((DistKind::Npx, None));
    let integrity = if kind == DistKind::Binary && binary.and_then(|target| target.sha256.as_ref()).is_some()
    {
        "sha256"
    } else {
        "registry"
    };
    json!({
        "id": agent.id, "name": agent.name, "version": agent.version, "description": agent.description,
        "authors": agent.authors, "license": agent.license, "website": agent.website,
        "repository": agent.repository, "icon": agent.icon,
        "distribution": kind.as_str(), "integrity": integrity,
    })
}

fn search_rank(agent: &RegistryAgent, query: &str) -> u8 {
    if query.is_empty() {
        return 2;
    }
    let id = agent.id.to_lowercase();
    let name = agent.name.to_lowercase();
    if id == query || name == query {
        0
    } else if id.starts_with(query) || name.starts_with(query) {
        1
    } else {
        2
    }
}

/// Substring search over id/name/description, capped at `limit` (itself
/// capped at [`MAX_AGENTS`]).
pub fn search_agents(agents: &[RegistryAgent], query: &str, limit: usize) -> Vec<Value> {
    let query = query.trim().to_lowercase();
    let platform = platform_target();
    let mut matched: Vec<&RegistryAgent> = agents
        .iter()
        .filter(|agent| {
            query.is_empty()
                || agent.id.to_lowercase().contains(&query)
                || agent.name.to_lowercase().contains(&query)
                || agent.description.to_lowercase().contains(&query)
        })
        .collect();
    matched.sort_by(|a, b| {
        search_rank(a, &query)
            .cmp(&search_rank(b, &query))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    matched
        .into_iter()
        .take(limit.min(MAX_AGENTS))
        .map(|agent| agent_summary_json(agent, platform))
        .collect()
}

struct CacheState {
    fetched_at: Option<Instant>,
    agents: Option<Vec<RegistryAgent>>,
}

/// In-memory registry cache with a TTL; `prepare` always forces a fresh fetch
/// (falling back to the cached copy on a network failure), `search` reuses a
/// recent fetch. Network access is behind the `fetch` closure so tests can
/// supply a fake and never hit the real CDN.
pub struct RegistryCache(AsyncMutex<CacheState>);

impl RegistryCache {
    pub fn new() -> Self {
        Self(AsyncMutex::new(CacheState {
            fetched_at: None,
            agents: None,
        }))
    }

    async fn load<F, Fut>(&self, force: bool, fetch: F) -> Result<Vec<RegistryAgent>, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, String>>,
    {
        let mut state = self.0.lock().await;
        if !force {
            if let (Some(fetched_at), Some(agents)) = (state.fetched_at, state.agents.clone()) {
                if fetched_at.elapsed() < SEARCH_CACHE_MAX_AGE {
                    return Ok(agents);
                }
            }
        }
        match fetch().await {
            Ok(bytes) => {
                let parsed = parse_registry(&bytes)?;
                state.agents = Some(parsed.clone());
                state.fetched_at = Some(Instant::now());
                Ok(parsed)
            }
            Err(error) => match state.agents.clone() {
                Some(agents) => Ok(agents),
                None => Err(error),
            },
        }
    }

    pub async fn search<F, Fut>(
        &self,
        query: &str,
        limit: usize,
        fetch: F,
    ) -> Result<Vec<Value>, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, String>>,
    {
        let agents = self.load(false, fetch).await?;
        Ok(search_agents(&agents, query, limit))
    }

    pub async fn find<F, Fut>(&self, agent_id: &str, fetch: F) -> Result<RegistryAgent, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, String>>,
    {
        let agents = self.load(true, fetch).await?;
        agents
            .into_iter()
            .find(|agent| agent.id == agent_id)
            .ok_or_else(|| format!("ACP Registry agent '{agent_id}' was not found."))
    }
}

static GLOBAL_CACHE: OnceLock<RegistryCache> = OnceLock::new();
fn global_cache() -> &'static RegistryCache {
    GLOBAL_CACHE.get_or_init(RegistryCache::new)
}

/// The real network fetch: offline/unreachable surfaces as a clear error
/// message (never a panic), and the cache above falls back to its last good
/// copy when one exists.
pub async fn fetch_live() -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent("t3code/desktop")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(REGISTRY_URL)
        .send()
        .await
        .map_err(|_| "The ACP Registry is unavailable.".to_string())?
        .error_for_status()
        .map_err(|_| "The ACP Registry is unavailable.".to_string())?;
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the ACP Registry response.".to_string())?;
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err("The ACP Registry index exceeds the size limit.".into());
    }
    Ok(bytes.to_vec())
}

fn runner_available(name: &str) -> bool {
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path_var).any(|dir| {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return true;
        }
        cfg!(windows) && dir.join(format!("{name}.cmd")).is_file()
    })
}

/// Rejects absolute paths, drive letters and `.`/`..` segments (archives are
/// untrusted input); returns the path's segments.
fn normalize_archive_relative_path(value: &str) -> Option<Vec<String>> {
    let normalized = value.trim().replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    if normalized.starts_with('/') || normalized.get(1..2) == Some(":") {
        return None;
    }
    let segments: Vec<String> = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_owned)
        .collect();
    if segments.is_empty() || segments.iter().any(|segment| segment == "." || segment == "..") {
        return None;
    }
    Some(segments)
}

enum ArchiveKind {
    Zip,
    TarGz,
}

fn archive_kind(url: &str) -> Result<ArchiveKind, String> {
    let lower = url.to_lowercase();
    if lower.ends_with(".zip") {
        Ok(ArchiveKind::Zip)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        Ok(ArchiveKind::TarGz)
    } else {
        Err(format!(
            "ACP Registry archive {url} has an unsupported format (only .zip and .tar.gz are supported)."
        ))
    }
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|error| format!("ACP Registry archive is not a valid zip: {error}"))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| format!("Could not read ACP Registry archive entry: {error}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            return Err("ACP Registry archive contains an unsafe entry path.".into());
        };
        let raw_path = enclosed.to_string_lossy().into_owned();
        // A zip built with "zip -r x.zip ." (or similar) lists the archive
        // root itself as a directory entry ("./"); that is not a traversal
        // attempt and has nothing to extract.
        if entry.is_dir() && matches!(raw_path.trim_end_matches('/'), "" | ".") {
            continue;
        }
        let Some(segments) = normalize_archive_relative_path(&raw_path) else {
            return Err("ACP Registry archive contains an unsafe entry path.".into());
        };
        let output = dest.join(segments.join(std::path::MAIN_SEPARATOR_STR));
        if entry.is_dir() {
            std::fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output_file = std::fs::File::create(&output).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output_file).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in archive
        .entries()
        .map_err(|error| format!("ACP Registry archive is not a valid tar.gz: {error}"))?
    {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path().map_err(|error| error.to_string())?.into_owned();
        let raw_path = path.to_string_lossy().into_owned();
        // tar built as "tar czf x.tgz -C dir ." lists the archive root
        // itself as a directory entry ("./"); not a traversal attempt, and
        // there is nothing to extract for it.
        if entry.header().entry_type().is_dir() && matches!(raw_path.trim_end_matches('/'), "" | ".") {
            continue;
        }
        let Some(segments) = normalize_archive_relative_path(&raw_path) else {
            return Err("ACP Registry archive contains an unsafe entry path.".into());
        };
        let output = dest.join(segments.join(std::path::MAIN_SEPARATOR_STR));
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        if !entry.header().entry_type().is_file() {
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        entry.unpack(&output).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Archives built off-unix can lose the executable bit, and the resolved
/// entry commonly spawns sibling helper binaries of its own, so every
/// regular file under `dir` (recursively) is marked executable.
#[cfg(unix)]
fn mark_executables(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let entries = std::fs::read_dir(dir).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            mark_executables(&entry.path())?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let mut permissions = entry
            .metadata()
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        std::fs::set_permissions(entry.path(), permissions).map_err(|error| error.to_string())?;
    }
    Ok(())
}
#[cfg(not(unix))]
fn mark_executables(_dir: &Path) -> Result<(), String> {
    Ok(())
}

/// Downloads `target.archive`, verifies its checksum when the registry
/// provides one, extracts it, and marks the resolved entry executable.
/// Installs atomically: extraction happens in a `.tmp-*` sibling of the
/// final directory, which is renamed into place only once the entry exists
/// (see module docs re: zuse's `archive_install.rs`).
pub async fn install_binary(
    agent: &RegistryAgent,
    target: &BinaryTarget,
    tools_dir: &Path,
) -> Result<PathBuf, String> {
    let Some(entry_segments) = normalize_archive_relative_path(&target.cmd) else {
        return Err(format!(
            "ACP Registry agent '{}' has an unsafe executable path.",
            agent.id
        ));
    };
    let platform = platform_target();
    let final_dir = tools_dir.join(&agent.id).join(&agent.version).join(platform);
    let entry_path = final_dir.join(entry_segments.join(std::path::MAIN_SEPARATOR_STR));
    if entry_path.is_file() {
        return Ok(entry_path);
    }

    tokio::fs::create_dir_all(tools_dir)
        .await
        .map_err(|error| error.to_string())?;
    let tmp_dir = tools_dir.join(format!(
        ".tmp-{}-{}-{}",
        agent.id,
        agent.version,
        std::process::id()
    ));
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|error| error.to_string())?;

    let outcome = download_and_extract(agent, target, &tmp_dir).await;
    if let Err(error) = outcome {
        let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        return Err(error);
    }

    if let Some(parent) = final_dir.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if tokio::fs::rename(&tmp_dir, &final_dir).await.is_err() {
        // Another prepare for the same agent/version/platform may have won the race.
        if entry_path.is_file() {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        } else {
            let _ = tokio::fs::remove_dir_all(&final_dir).await;
            tokio::fs::rename(&tmp_dir, &final_dir)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    if !entry_path.is_file() {
        return Err(format!(
            "ACP Registry agent '{}' archive did not contain {}.",
            agent.id, target.cmd
        ));
    }
    Ok(entry_path)
}

async fn download_and_extract(
    agent: &RegistryAgent,
    target: &BinaryTarget,
    dest: &Path,
) -> Result<(), String> {
    let url = reqwest::Url::parse(&target.archive)
        .map_err(|_| "ACP Registry archive URL is invalid.".to_string())?;
    // Real registry archives are always HTTPS; loopback HTTP is allowed only
    // so tests can serve a fixture instead of ever hitting the real CDN.
    let loopback_http = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]"));
    if url.scheme() != "https" && !loopback_http {
        return Err("ACP Registry archives must be served over HTTPS.".into());
    }
    let kind = archive_kind(url.as_str())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(url.as_str())
        .send()
        .await
        .map_err(|error| format!("Could not download the ACP Registry archive: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Could not download the ACP Registry archive: {error}"))?;
    let download_path = dest.join("download.bin");
    let mut file =
        tokio::fs::File::create(&download_path)
            .await
            .map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("ACP Registry archive download failed: {error}"))?
    {
        received = received.saturating_add(chunk.len() as u64);
        if received > MAX_ARCHIVE_BYTES {
            return Err("ACP Registry archive exceeds the size limit.".into());
        }
        hasher.update(&chunk);
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|error| error.to_string())?;
    drop(file);
    if let Some(expected) = &target.sha256 {
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&download_path).await;
            return Err(format!(
                "ACP Registry archive checksum mismatch for '{}' (expected {expected}, got {actual}).",
                agent.id
            ));
        }
    }
    // Extraction and marking files executable are blocking filesystem work;
    // run them off the async runtime so a large archive cannot stall it.
    let dest_owned = dest.to_path_buf();
    tokio::task::spawn_blocking(move || match kind {
        ArchiveKind::Zip => extract_zip(&download_path, &dest_owned).and_then(|()| mark_executables(&dest_owned)),
        ArchiveKind::TarGz => extract_tar_gz(&download_path, &dest_owned).and_then(|()| mark_executables(&dest_owned)),
    })
    .await
    .map_err(|error| format!("ACP Registry archive extraction task failed: {error}"))??;
    let _ = tokio::fs::remove_file(dest.join("download.bin")).await;
    let Some(entry_segments) = normalize_archive_relative_path(&target.cmd) else {
        return Err(format!(
            "ACP Registry agent '{}' has an unsafe executable path.",
            agent.id
        ));
    };
    let entry = dest.join(entry_segments.join(std::path::MAIN_SEPARATOR_STR));
    if !entry.is_file() {
        return Err(format!(
            "ACP Registry agent '{}' archive did not contain {}.",
            agent.id, target.cmd
        ));
    }
    Ok(())
}

/// `server.searchAcpRegistry`: `{query, limit}` -> `{agents:[...]}`.
pub async fn search(query: &str, limit: usize) -> Result<Value, String> {
    let agents = global_cache().search(query, limit, fetch_live).await?;
    Ok(json!({ "agents": agents }))
}

/// `server.prepareAcpRegistryAgent`: `{agentId}` -> `{agentId, version,
/// distribution, prepared}` (see [`rpcResultSchemas.json`]'s
/// `server.prepareAcpRegistryAgent`).
pub async fn prepare(agent_id: &str, tools_dir: Option<&Path>) -> Result<Value, String> {
    let agent = global_cache().find(agent_id, fetch_live).await?;
    let platform = platform_target();
    let (kind, binary) = resolve_distribution(&agent, platform)
        .ok_or_else(|| format!("ACP Registry agent '{agent_id}' has no usable distribution."))?;
    match kind {
        DistKind::Binary => {
            let target = binary.ok_or_else(|| {
                format!(
                    "ACP Registry agent '{agent_id}' does not publish a binary for this platform ({platform})."
                )
            })?;
            let tools_dir = tools_dir
                .ok_or_else(|| "The ACP Registry install directory is unavailable.".to_string())?;
            install_binary(&agent, target, tools_dir).await?;
        }
        DistKind::Npx if !runner_available(if cfg!(windows) { "npx.cmd" } else { "npx" }) => {
            return Err(format!(
                "ACP Registry agent '{agent_id}' requires 'npx', but it is not available on this environment's PATH."
            ));
        }
        DistKind::Uvx if !runner_available(if cfg!(windows) { "uvx.exe" } else { "uvx" }) => {
            return Err(format!(
                "ACP Registry agent '{agent_id}' requires 'uvx', but it is not available on this environment's PATH."
            ));
        }
        DistKind::Npx | DistKind::Uvx => {}
    }
    Ok(json!({
        "agentId": agent.id, "version": agent.version, "distribution": kind.as_str(), "prepared": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "version": "1.0.0",
        "agents": [
            {"id": "sample-acp", "name": "Sample", "version": "1.0.0", "description": "A sample agent",
             "authors": ["Acme"], "website": "https://example.test",
             "distribution": {"npx": {"package": "@example/sample@1.0.0"}}},
            {"id": "py-agent", "name": "Python agent", "version": "0.1.0",
             "distribution": {"uvx": {"package": "py-agent==0.1"}}},
            {"id": "native", "name": "Native", "version": "2.0.0", "distribution": {"binary": {
                "linux-x86_64": {"archive": "https://example.test/a.tar.gz", "cmd": "./bin/native-acp", "sha256": "deadbeef"}}}},
            {"id": "bad id", "name": "Invalid id", "version": "1.0.0"},
            {"id": "no-version", "name": "No version", "version": ""},
            {"id": "", "name": "Nameless", "version": "1.0.0"}
        ]
    }"#;

    fn sample_agents() -> Vec<RegistryAgent> {
        parse_registry(SAMPLE.as_bytes()).unwrap()
    }

    #[test]
    fn parse_drops_entries_with_unsafe_or_missing_identity() {
        let agents = sample_agents();
        let ids: Vec<_> = agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["sample-acp", "py-agent", "native"]);
    }

    #[test]
    fn search_substring_matches_id_name_and_description_case_insensitively() {
        let agents = sample_agents();
        assert_eq!(search_agents(&agents, "SAMPLE", 50).len(), 1);
        assert_eq!(search_agents(&agents, "python", 50).len(), 1);
        assert_eq!(search_agents(&agents, "a sample agent", 50).len(), 1);
        assert_eq!(search_agents(&agents, "does-not-exist", 50).len(), 0);
        assert_eq!(search_agents(&agents, "", 50).len(), 3);
    }

    #[test]
    fn search_ranks_exact_and_prefix_matches_first() {
        let agents = sample_agents();
        let results = search_agents(&agents, "nat", 50);
        assert_eq!(results[0]["id"], "native");
    }

    #[test]
    fn search_caps_at_fifty_even_when_a_larger_limit_is_requested() {
        let mut agents = Vec::new();
        for i in 0..80 {
            agents.push(RegistryAgent {
                id: format!("agent-{i}"),
                name: format!("Agent {i}"),
                version: "1.0.0".into(),
                description: String::new(),
                authors: vec![],
                license: None,
                website: None,
                repository: None,
                icon: None,
                distribution: Distribution {
                    npx: Some(Package { package: "x@1.0.0".into(), args: vec![], env: HashMap::new() }),
                    ..Default::default()
                },
            });
        }
        assert_eq!(search_agents(&agents, "", 1_000).len(), MAX_AGENTS);
    }

    #[test]
    fn distribution_preference_is_binary_then_npx_then_uvx() {
        let agents = sample_agents();
        let sample = agents.iter().find(|a| a.id == "sample-acp").unwrap();
        assert_eq!(
            resolve_distribution(sample, "linux-x86_64").map(|(k, _)| k),
            Some(DistKind::Npx)
        );
        let python = agents.iter().find(|a| a.id == "py-agent").unwrap();
        assert_eq!(
            resolve_distribution(python, "linux-x86_64").map(|(k, _)| k),
            Some(DistKind::Uvx)
        );
        let native = agents.iter().find(|a| a.id == "native").unwrap();
        assert_eq!(
            resolve_distribution(native, "linux-x86_64").map(|(k, b)| (k, b.is_some())),
            Some((DistKind::Binary, true))
        );
        // No binary target for this platform, and no npx/uvx fallback: still
        // reported as Binary (so search can show it) but with no target.
        assert_eq!(
            resolve_distribution(native, "darwin-aarch64").map(|(k, b)| (k, b.is_some())),
            Some((DistKind::Binary, false))
        );
    }

    #[test]
    fn integrity_reflects_whether_the_registry_pins_a_checksum() {
        let agents = sample_agents();
        let native = agents.iter().find(|a| a.id == "native").unwrap();
        let summary = agent_summary_json(native, "linux-x86_64");
        assert_eq!(summary["distribution"], "binary");
        assert_eq!(summary["integrity"], "sha256");
        let sample = agents.iter().find(|a| a.id == "sample-acp").unwrap();
        let summary = agent_summary_json(sample, "linux-x86_64");
        assert_eq!(summary["integrity"], "registry");
    }

    #[test]
    fn unsafe_archive_entry_paths_are_rejected() {
        assert!(normalize_archive_relative_path("../../etc/passwd").is_none());
        assert!(normalize_archive_relative_path("/etc/passwd").is_none());
        assert!(normalize_archive_relative_path("C:/evil").is_none());
        assert_eq!(
            normalize_archive_relative_path("./bin/server"),
            Some(vec!["bin".to_string(), "server".to_string()])
        );
    }

    #[tokio::test]
    async fn cache_search_reuses_a_recent_fetch_without_calling_fetch_again() {
        let cache = RegistryCache::new();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let fetch = {
            let calls = calls.clone();
            move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(SAMPLE.as_bytes().to_vec())
                }
            }
        };
        cache.search("", 50, fetch.clone()).await.unwrap();
        cache.search("", 50, fetch).await.unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cache_prepare_always_fetches_fresh_but_falls_back_to_cache_offline() {
        let cache = RegistryCache::new();
        cache
            .find("sample-acp", || async { Ok(SAMPLE.as_bytes().to_vec()) })
            .await
            .unwrap();
        // A later prepare that cannot reach the network still resolves from
        // the cached copy instead of failing outright.
        let found = cache
            .find("sample-acp", || async { Err("offline".to_string()) })
            .await
            .unwrap();
        assert_eq!(found.id, "sample-acp");
    }

    #[tokio::test]
    async fn find_reports_a_clear_error_for_an_unknown_agent_id() {
        let cache = RegistryCache::new();
        let error = cache
            .find("does-not-exist", || async { Ok(SAMPLE.as_bytes().to_vec()) })
            .await
            .unwrap_err();
        assert!(error.contains("does-not-exist"), "{error}");
    }

    #[tokio::test]
    async fn install_binary_downloads_verifies_extracts_and_marks_executable() {
        let server_dir = tempdir();
        let archive_path = server_dir.join("agent.tar.gz");
        {
            let tar_gz = std::fs::File::create(&archive_path).unwrap();
            let encoder = flate2::write::GzEncoder::new(tar_gz, flate2::Compression::default());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_path("bin/native-acp").unwrap();
            header.set_size(11);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, &b"#!/bin/sh\n\n"[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let bytes = std::fs::read(&archive_path).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let sha256 = format!("{:x}", hasher.finalize());

        let (url, _server) = serve_once(bytes, "agent.tar.gz").await;
        let agent = RegistryAgent {
            id: "native-test".into(),
            name: "Native Test".into(),
            version: "1.0.0".into(),
            description: String::new(),
            authors: vec![],
            license: None,
            website: None,
            repository: None,
            icon: None,
            distribution: Distribution::default(),
        };
        let target = BinaryTarget {
            archive: url,
            cmd: "./bin/native-acp".into(),
            sha256: Some(sha256),
            args: vec![],
            env: HashMap::new(),
        };
        let tools_dir = server_dir.join("tools");
        let entry = install_binary(&agent, &target, &tools_dir).await.unwrap();
        assert!(entry.ends_with("bin/native-acp"));
        assert!(entry.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&entry).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
        }
        // A second prepare for the same agent/version/platform is a no-op
        // (the install is cached on disk).
        let entry_again = install_binary(&agent, &target, &tools_dir).await.unwrap();
        assert_eq!(entry, entry_again);
    }

    #[tokio::test]
    async fn install_binary_rejects_a_checksum_mismatch() {
        let server_dir = tempdir();
        let bytes = b"not a real archive".to_vec();
        let (url, _server) = serve_once(bytes, "agent.tar.gz").await;
        let agent = RegistryAgent {
            id: "bad-checksum".into(),
            name: "Bad Checksum".into(),
            version: "1.0.0".into(),
            description: String::new(),
            authors: vec![],
            license: None,
            website: None,
            repository: None,
            icon: None,
            distribution: Distribution::default(),
        };
        let target = BinaryTarget {
            archive: url,
            cmd: "./bin/x".into(),
            sha256: Some("0".repeat(64)),
            args: vec![],
            env: HashMap::new(),
        };
        let error = install_binary(&agent, &target, &server_dir.join("tools"))
            .await
            .unwrap_err();
        assert!(error.contains("checksum mismatch"), "{error}");
    }

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "t3code-acp-registry-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Serves `body` to exactly one request, never the real CDN.
    async fn serve_once(body: Vec<u8>, name: &str) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/{name}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let mut headers = Vec::new();
                while !headers.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => headers.extend_from_slice(&buf[..n]),
                    }
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&body).await;
                let _ = socket.shutdown().await;
            }
        });
        (url, handle)
    }
}
