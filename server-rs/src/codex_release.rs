//! Pinned managed Codex release metadata and bounded archive verification.
//! Verification alone does not install or authorize an executable.
use sha2::{Digest, Sha256};
use std::io::Read;

#[derive(Debug, Clone, Copy)]
pub struct ReleaseAsset {
    pub version: &'static str,
    pub target: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

/// Mirrors the pinned 0.166.0 assets in the upstream server installation manifest.
pub fn pinned(platform: &str, arch: &str) -> Option<ReleaseAsset> {
    let (target, sha256, bytes) = match (platform, arch) {
        ("linux", "x86_64") => (
            "x86_64-unknown-linux-musl",
            "1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254",
            199694962,
        ),
        ("linux", "aarch64") => (
            "aarch64-unknown-linux-musl",
            "7821b77dda2e6283fb1f63f3165177a271da8833e857cf673c6ca1c9db3bfcc6",
            187370368,
        ),
        ("macos", "x86_64") => (
            "x86_64-apple-darwin",
            "1cb65690230be5982c654ba2655e3a3b594dce9c55b780e78bfdfeff829d7ad9",
            180076524,
        ),
        ("macos", "aarch64") => (
            "aarch64-apple-darwin",
            "55a440cb579f970abe7c79ab181e54b0ea4c419be99f333bbd868eebac9c21f0",
            165951869,
        ),
        ("windows", "x86_64") => (
            "x86_64-pc-windows-msvc",
            "d559bb88e74d471265857b93b7f19bc250dae527673b9191b33534478093f6bc",
            202589789,
        ),
        ("windows", "aarch64") => (
            "aarch64-pc-windows-msvc",
            "9383152a72f97bb5dd148493c8214e4fed38d805aa2c3297cb3739f7f130becf",
            187024318,
        ),
        _ => return None,
    };
    let url = match target {
        "x86_64-unknown-linux-musl" => "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
        "aarch64-unknown-linux-musl" => "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-unknown-linux-musl.tar.gz",
        "x86_64-apple-darwin" => "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-apple-darwin.tar.gz",
        "aarch64-apple-darwin" => "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-apple-darwin.tar.gz",
        "x86_64-pc-windows-msvc" => "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-pc-windows-msvc.tar.gz",
        _ => "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-pc-windows-msvc.tar.gz",
    };
    Some(ReleaseAsset {
        version: "0.166.0",
        target,
        url,
        sha256,
        bytes,
    })
}

/// Verify a complete archive with an exact size and digest before extraction.
pub fn verify(
    mut reader: impl Read,
    expected_bytes: u64,
    expected_sha256: &str,
) -> Result<(), &'static str> {
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buf = [0u8; 65536];
    loop {
        let n = reader.read(&mut buf).map_err(|_| "read")?;
        if n == 0 {
            break;
        }
        count = count.checked_add(n as u64).ok_or("size")?;
        if count > expected_bytes {
            return Err("size");
        }
        hash.update(&buf[..n]);
    }
    if count != expected_bytes {
        return Err("size");
    }
    let actual = hash
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if actual != expected_sha256 {
        return Err("digest");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_complete_fixture_and_rejects_tampering() {
        let digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify(&b"abc"[..], 3, digest).is_ok());
        assert!(verify(&b"abd"[..], 3, digest).is_err());
        assert!(verify(&b"ab"[..], 3, digest).is_err());
        assert!(verify(&b"abcd"[..], 3, digest).is_err());
        assert!(pinned("linux", "x86_64")
            .unwrap()
            .url
            .contains("x86_64-unknown-linux-musl"));
        assert!(pinned("unknown", "x86_64").is_none());
    }
}

#[cfg(unix)]
fn install_lock() -> &'static std::sync::Arc<tokio::sync::RwLock<()>> {
    static LOCK: std::sync::OnceLock<std::sync::Arc<tokio::sync::RwLock<()>>> =
        std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Arc::new(tokio::sync::RwLock::new(())))
}

/// Keeps this server from replacing a managed release while it is in use.
#[cfg(unix)]
pub struct InstalledLease {
    binary: std::path::PathBuf,
    _guard: tokio::sync::OwnedRwLockReadGuard<()>,
}
#[cfg(unix)]
impl InstalledLease {
    pub fn binary(&self) -> &std::path::Path {
        &self.binary
    }
}
#[cfg(unix)]
impl std::fmt::Debug for InstalledLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InstalledLease")
            .field("binary", &self.binary)
            .finish_non_exhaustive()
    }
}
#[cfg(unix)]
pub async fn acquire_installed(root: &std::path::Path) -> Result<InstalledLease, String> {
    let guard = install_lock().clone().read_owned().await;
    let root = root.to_owned();
    let binary = tokio::task::spawn_blocking(move || select_installed(&root))
        .await
        .map_err(|_| "verification failed")??;
    Ok(InstalledLease {
        binary,
        _guard: guard,
    })
}

#[cfg(all(test, unix))]
pub(crate) async fn acquire_fixture(
    root: &std::path::Path,
    asset: ReleaseAsset,
) -> Result<InstalledLease, String> {
    let guard = install_lock().clone().read_owned().await;
    let root = root.to_owned();
    let binary = tokio::task::spawn_blocking(move || select_with_asset(&root, asset))
        .await
        .map_err(|_| "verification failed")??;
    Ok(InstalledLease {
        binary,
        _guard: guard,
    })
}
#[cfg(all(test, unix))]
pub(crate) async fn install_fixture(root: &std::path::Path, script: &[u8]) -> ReleaseAsset {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(root).unwrap();
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let stage = root.join("stage");
    std::fs::create_dir(&stage).unwrap();
    let archive = root.join("fixture.gz");
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
        std::fs::File::create(&archive).unwrap(),
        flate2::Compression::default(),
    ));
    let asset = pinned(std::env::consts::OS, std::env::consts::ARCH).unwrap();
    let manifest = format!(
        r#"{{"layoutVersion":1,"version":"{}","target":"{}","entrypoint":"bin/codex"}}"#,
        asset.version, asset.target
    );
    for (name, data, mode) in [
        ("codex-package.json", manifest.as_bytes(), 0o600),
        ("bin/codex", script, 0o700),
        ("bin/codex-code-mode-host", b"mock".as_slice(), 0o700),
        ("codex-path/rg", b"mock".as_slice(), 0o700),
    ] {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(mode);
        h.set_cksum();
        tar.append_data(&mut h, name, data).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap().flush().unwrap();
    let data = std::fs::read(&archive).unwrap();
    let asset = ReleaseAsset {
        sha256: Box::leak(format!("{:x}", Sha256::digest(&data)).into_boxed_str()),
        bytes: data.len() as u64,
        ..asset
    };
    install_verified(root, &stage, &archive, asset, false)
        .await
        .unwrap();
    std::fs::remove_file(archive).unwrap();
    asset
}

/// Download, verify, stage and atomically activate a pinned release. The caller
/// must serialize installs and hold any runtime leases across replacement.
#[cfg(unix)]
pub async fn install(
    managed: &std::path::Path,
    asset: ReleaseAsset,
) -> Result<std::path::PathBuf, String> {
    install_with_progress(managed, asset, |_, _| {}).await
}

#[cfg(unix)]
pub async fn install_with_progress(
    managed: &std::path::Path,
    asset: ReleaseAsset,
    progress: impl Fn(&str, u64) + Send + Sync,
) -> Result<std::path::PathBuf, String> {
    use tokio::io::AsyncWriteExt;
    let _lease = install_lock().write().await;
    // Only the compiled-in manifest is trusted as an authority for downloads.
    let official =
        pinned(std::env::consts::OS, std::env::consts::ARCH).ok_or("unsupported platform")?;
    if asset.version != official.version
        || asset.target != official.target
        || asset.url != official.url
        || asset.sha256 != official.sha256
        || asset.bytes != official.bytes
    {
        return Err("untrusted release".into());
    }
    prepare_root(managed)?;
    let stage = managed.join(format!(".install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&stage).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&stage, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let guard = Stage(stage.clone());
    let archive = stage.join("download.tar.gz");
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&archive)
        .await
        .map_err(|e| e.to_string())?;
    let download = async {
        let mut response = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2700))
            .build()
            .map_err(|e| e.to_string())?
            .get(asset.url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut count = 0u64;
        let mut hash = Sha256::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            count = count.checked_add(chunk.len() as u64).ok_or("size")?;
            if count > asset.bytes {
                return Err("size".to_owned());
            }
            hash.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            progress("downloading", count);
        }
        file.flush().await.map_err(|e| e.to_string())?;
        if count != asset.bytes || format!("{:x}", hash.finalize()) != asset.sha256 {
            return Err("integrity".to_owned());
        }
        Ok::<(), String>(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(2700), download)
        .await
        .map_err(|_| "timeout".to_owned())??;
    drop(file);
    progress("extracting", asset.bytes);
    let result = install_verified(managed, &stage, &archive, asset, true).await;
    drop(guard);
    result
}

/// Remove an authenticated managed installation only when no runtime holds a lease.
#[cfg(unix)]
pub fn remove_installed(root: &std::path::Path) -> Result<(), String> {
    let _guard = install_lock()
        .try_write()
        .map_err(|_| "installation in use")?;
    select_installed(root)?;
    std::fs::remove_dir_all(root).map_err(|e| e.to_string())
}

#[cfg(unix)]
struct Stage(std::path::PathBuf);
#[cfg(unix)]
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
fn prepare_root(root: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if !root.is_absolute() {
        return Err("install directory must be absolute".into());
    }
    let existed = root.exists();
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    if !existed {
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let m = std::fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.permissions().mode() & 0o022 != 0 {
        return Err("unsafe install directory".into());
    }
    Ok(())
}

#[cfg(unix)]
async fn install_verified(
    root: &std::path::Path,
    stage: &std::path::Path,
    archive: &std::path::Path,
    asset: ReleaseAsset,
    execute: bool,
) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let runtime = stage.join("runtime");
    std::fs::create_dir(&runtime).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    extract_archive(archive, &runtime)?;
    let binary = validate_package(&runtime, asset)?;
    if execute {
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(90),
            tokio::process::Command::new(&binary)
                .arg("--version")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "version timeout")?
        .map_err(|e| e.to_string())?;
        if !output.status.success()
            || String::from_utf8_lossy(&output.stdout).trim()
                != format!("codex-cli {}", asset.version)
        {
            return Err("version mismatch".into());
        }
    }
    // Retain the authenticated archive so later launches can re-establish trust.
    let retained = runtime.join(".verified-archive.tar.gz");
    std::fs::copy(archive, &retained).map_err(|e| e.to_string())?;
    std::fs::set_permissions(retained, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    let record = serde_json::json!({"version": asset.version, "target": asset.target, "sha256": asset.sha256});
    let record_path = runtime.join(".install-complete.json");
    use std::io::Write;
    let mut record_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(record_path)
        .map_err(|e| e.to_string())?;
    record_file
        .write_all(record.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    record_file.sync_all().map_err(|e| e.to_string())?;
    let destination = root.join(asset.version);
    // Never overwrite an existing release, including one installed concurrently.
    if destination.exists() {
        return Err("release already exists".into());
    }
    std::fs::rename(&runtime, &destination).map_err(|e| e.to_string())?;
    let mut rollback = Some(Stage(destination.clone()));
    let active = stage.join("active.json");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&active)
        .map_err(|e| e.to_string())?;
    f.write_all(
        serde_json::json!({"version":asset.version})
            .to_string()
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(active, root.join("active.json")).map_err(|e| e.to_string())?;
    // Once active points at this release it must never be removed by rollback.
    if let Some(guard) = rollback.take() {
        std::mem::forget(guard);
    }
    std::fs::File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(destination.join("bin/codex"))
}

/// Resolve the active pinned release only after authenticating its retained archive
/// and comparing every installed package file to that archive. Callers must
/// prevent replacement while a child is running.
#[cfg(unix)]
pub fn select_installed(root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let asset =
        pinned(std::env::consts::OS, std::env::consts::ARCH).ok_or("unsupported platform")?;
    select_with_asset(root, asset)
}

#[cfg(unix)]
fn select_with_asset(
    root: &std::path::Path,
    asset: ReleaseAsset,
) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    fn safe(path: &std::path::Path, directory: bool) -> Result<(), String> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let m = std::fs::symlink_metadata(path).map_err(|_| "invalid install")?;
        if (if directory { !m.is_dir() } else { !m.is_file() })
            || m.uid() != unsafe { libc::geteuid() }
            || m.permissions().mode() & 0o022 != 0
        {
            return Err("unsafe install".into());
        }
        Ok(())
    }
    if !root.is_absolute() {
        return Err("invalid install".into());
    }
    safe(root, true)?;
    let pointer = root.join("active.json");
    safe(&pointer, false)?;
    if std::fs::metadata(&pointer)
        .map_err(|_| "invalid install")?
        .len()
        > 8192
    {
        return Err("invalid install".into());
    }
    let active: serde_json::Value =
        serde_json::from_slice(&std::fs::read(pointer).map_err(|_| "invalid install")?)
            .map_err(|_| "invalid install")?;
    if active["version"] != asset.version {
        return Err("inactive release".into());
    }
    let release = root.join(asset.version);
    safe(&release, true)?;
    let archive = release.join(".verified-archive.tar.gz");
    safe(&archive, false)?;
    verify(
        std::fs::File::open(&archive).map_err(|_| "invalid install")?,
        asset.bytes,
        asset.sha256,
    )
    .map_err(|_| "archive integrity")?;
    let check = root.join(format!(".verify-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&check).map_err(|_| "invalid install")?;
    std::fs::set_permissions(&check, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "invalid install")?;
    let _guard = Stage(check.clone());
    extract_archive(&archive, &check)?;
    validate_package(&check, asset)?;
    fn compare(
        expected: &std::path::Path,
        actual: &std::path::Path,
        top: bool,
    ) -> Result<(), String> {
        use std::collections::BTreeSet;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let names = |p: &std::path::Path,
                     skip: bool|
         -> Result<BTreeSet<std::ffi::OsString>, String> {
            let mut out = BTreeSet::new();
            for entry in std::fs::read_dir(p).map_err(|_| "invalid install")? {
                let name = entry.map_err(|_| "invalid install")?.file_name();
                if skip && (name == ".verified-archive.tar.gz" || name == ".install-complete.json")
                {
                    continue;
                }
                out.insert(name);
            }
            Ok(out)
        };
        let expected_names = names(expected, false)?;
        if expected_names != names(actual, top)? {
            return Err("package mismatch".into());
        }
        for name in expected_names {
            let e = expected.join(&name);
            let a = actual.join(&name);
            let em = std::fs::symlink_metadata(&e).map_err(|_| "invalid install")?;
            let am = std::fs::symlink_metadata(&a).map_err(|_| "invalid install")?;
            if am.uid() != unsafe { libc::geteuid() } || am.permissions().mode() & 0o022 != 0 {
                return Err("unsafe install".into());
            }
            if em.is_dir() && am.is_dir() {
                compare(&e, &a, false)?;
            } else if em.is_file() && am.is_file() {
                if em.len() != am.len()
                    || (em.permissions().mode() & 0o111) != (am.permissions().mode() & 0o111)
                {
                    return Err("package mismatch".into());
                }
                fn digest(path: &std::path::Path) -> Result<[u8; 32], String> {
                    let mut f = std::fs::File::open(path).map_err(|_| "invalid install")?;
                    let mut h = Sha256::new();
                    let mut b = [0; 65536];
                    loop {
                        let n = f.read(&mut b).map_err(|_| "invalid install")?;
                        if n == 0 {
                            break;
                        }
                        h.update(&b[..n]);
                    }
                    Ok(h.finalize().into())
                }
                if digest(&e)? != digest(&a)? {
                    return Err("package mismatch".into());
                }
            } else {
                return Err("package mismatch".into());
            }
        }
        Ok(())
    }
    compare(&check, &release, true)?;
    validate_package(&release, asset)
}

#[cfg(unix)]
fn extract_archive(archive: &std::path::Path, root: &std::path::Path) -> Result<(), String> {
    use std::{collections::HashSet, io::Read, os::unix::fs::PermissionsExt};
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(f));
    let mut paths = HashSet::new();
    let mut total = 0u64;
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        if paths.len() >= 10_000 {
            return Err("unsafe archive".into());
        }
        let bytes = entry.path_bytes();
        let name = std::str::from_utf8(&bytes).map_err(|_| "unsafe archive")?;
        let name = name.strip_suffix('/').unwrap_or(name);
        if name.is_empty()
            || name.contains(['\\', ':'])
            || name
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !paths.insert(name.to_owned())
        {
            return Err("unsafe archive".into());
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err("unsafe archive".into());
        }
        let target = root.join(name);
        if kind.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            continue;
        }
        let size = entry.size();
        total = total.checked_add(size).ok_or("archive too large")?;
        if total > 2 * 1024 * 1024 * 1024 {
            return Err("archive too large".into());
        }
        let parent = target.parent().ok_or("unsafe archive")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        for ancestor in parent.ancestors().take_while(|p| *p != root) {
            std::fs::set_permissions(ancestor, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        use std::os::unix::fs::OpenOptionsExt;
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&target)
            .map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut entry.by_ref().take(size + 1), &mut out)
            .map_err(|e| e.to_string())?;
        if copied != size {
            return Err("truncated archive".into());
        }
        let mode = entry.header().mode().map_err(|e| e.to_string())?;
        std::fs::set_permissions(
            target,
            std::fs::Permissions::from_mode(if mode & 0o111 != 0 { 0o700 } else { 0o600 }),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(unix)]
fn validate_package(
    root: &std::path::Path,
    asset: ReleaseAsset,
) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let manifest_path = root.join("codex-package.json");
    if std::fs::metadata(&manifest_path)
        .map_err(|e| e.to_string())?
        .len()
        > 8192
    {
        return Err("invalid package".into());
    }
    let manifest = std::fs::read(manifest_path).map_err(|e| e.to_string())?;
    if manifest.len() > 8192 {
        return Err("invalid package".into());
    }
    let v: serde_json::Value = serde_json::from_slice(&manifest).map_err(|e| e.to_string())?;
    if v["layoutVersion"] != 1
        || v["version"] != asset.version
        || v["target"] != asset.target
        || v["entrypoint"] != "bin/codex"
    {
        return Err("invalid package".into());
    }
    for name in ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg"] {
        let m = std::fs::symlink_metadata(root.join(name)).map_err(|e| e.to_string())?;
        if !m.is_file() || m.len() == 0 || m.permissions().mode() & 0o111 == 0 {
            return Err("incomplete package".into());
        }
    }
    Ok(root.join("bin/codex"))
}

#[cfg(all(test, unix))]
mod install_tests {
    use super::*;
    use std::io::Write;

    fn fixture(root: &std::path::Path, unsafe_link: bool) -> std::path::PathBuf {
        fixture_with_binary(root, unsafe_link, b"dummy")
    }

    fn fixture_with_binary(
        root: &std::path::Path,
        unsafe_link: bool,
        binary: &[u8],
    ) -> std::path::PathBuf {
        let path = root.join("fixture.gz");
        let file = std::fs::File::create(&path).unwrap();
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            file,
            flate2::Compression::default(),
        ));
        for (name, data, mode) in [("codex-package.json", br#"{"layoutVersion":1,"version":"0.166.0","target":"x86_64-unknown-linux-musl","entrypoint":"bin/codex"}"#.as_slice(), 0o600), ("bin/codex", binary, 0o700), ("bin/codex-code-mode-host", b"dummy", 0o700), ("codex-path/rg", b"dummy", 0o700)] {
            let mut header = tar::Header::new_gnu(); header.set_size(data.len() as u64); header.set_mode(mode); header.set_cksum();
            tar.append_data(&mut header, name, data).unwrap();
        }
        if unsafe_link {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::Symlink);
            h.set_size(0);
            h.set_mode(0o777);
            h.set_link_name("/tmp").unwrap();
            h.set_cksum();
            tar.append_data(&mut h, "link", &[][..]).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap().flush().unwrap();
        path
    }

    #[tokio::test]
    async fn cancelled_version_check_terminates_its_child() {
        let base = std::env::temp_dir().join(format!("codex-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&base).unwrap();
        let root = base.join("managed");
        let stage = root.join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        let pid_file = base.join("pid");
        let script = format!(
            "#!/bin/sh\necho $$ > '{}'\nexec sleep 30\n",
            pid_file.display()
        );
        let archive = fixture_with_binary(&base, false, script.as_bytes());
        let asset = pinned("linux", "x86_64").unwrap();
        let task = tokio::spawn({
            let root = root.clone();
            let stage = stage.clone();
            async move { install_verified(&root, &stage, &archive, asset, true).await }
        });
        let pid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = text.trim().parse::<i32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let exited = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if unsafe { libc::kill(pid, 0) } == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        if !exited {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        assert!(exited, "cancelled version check left its child running");
        assert!(!root.join("active.json").exists());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[tokio::test]
    async fn selection_rejects_modified_package_archive_and_pointer() {
        let base = std::env::temp_dir().join(format!("codex-select-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&base).unwrap();
        let root = base.join("managed");
        std::fs::create_dir(&root).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let stage = root.join("stage");
        std::fs::create_dir(&stage).unwrap();
        let archive = fixture(&base, false);
        let data = std::fs::read(&archive).unwrap();
        let digest: &'static str =
            Box::leak(format!("{:x}", Sha256::digest(&data)).into_boxed_str());
        let mut asset = pinned("linux", "x86_64").unwrap();
        asset.sha256 = digest;
        asset.bytes = data.len() as u64;
        let path = install_verified(&root, &stage, &archive, asset, false)
            .await
            .unwrap();
        assert_eq!(select_with_asset(&root, asset).unwrap(), path);
        std::fs::write(&path, b"other").unwrap();
        assert!(select_with_asset(&root, asset).is_err());
        std::fs::write(&path, b"dummy").unwrap();
        std::fs::write(
            root.join(asset.version).join(".verified-archive.tar.gz"),
            b"tampered",
        )
        .unwrap();
        assert!(select_with_asset(&root, asset).is_err());
        std::fs::write(root.join("active.json"), br#"{"version":"../elsewhere"}"#).unwrap();
        assert!(select_with_asset(&root, asset).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[tokio::test]
    async fn activation_failure_removes_new_release() {
        let base =
            std::env::temp_dir().join(format!("codex-rollback-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&base).unwrap();
        let root = base.join("managed");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("active.json")).unwrap();
        let stage = root.join("stage");
        std::fs::create_dir(&stage).unwrap();
        let archive = fixture(&base, false);
        let asset = pinned("linux", "x86_64").unwrap();
        assert!(install_verified(&root, &stage, &archive, asset, false)
            .await
            .is_err());
        assert!(!root.join(asset.version).exists());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[tokio::test]
    async fn installs_fixture_and_preserves_active_on_unsafe_archive() {
        let base =
            std::env::temp_dir().join(format!("codex-install-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&base).unwrap();
        let root = base.join("managed");
        std::fs::create_dir(&root).unwrap();
        let stage = root.join("stage");
        std::fs::create_dir(&stage).unwrap();
        let asset = pinned("linux", "x86_64").unwrap();
        let archive = fixture(&base, false);
        let path = install_verified(&root, &stage, &archive, asset, false)
            .await
            .unwrap();
        assert!(path.is_file());
        let active = std::fs::read(root.join("active.json")).unwrap();
        let stage2 = root.join("stage2");
        std::fs::create_dir(&stage2).unwrap();
        let bad = fixture(&base, true);
        assert!(install_verified(&root, &stage2, &bad, asset, false)
            .await
            .is_err());
        assert_eq!(active, std::fs::read(root.join("active.json")).unwrap());
        std::fs::remove_dir_all(base).unwrap();
    }
}
