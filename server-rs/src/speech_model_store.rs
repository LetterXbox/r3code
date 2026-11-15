//! Pinned local speech model catalog and integrity-checked installation.
//!
//! A model is never returned for inference until its full size and SHA-256 have
//! been checked. Installations are written to a private temporary file and only
//! renamed into place after verification.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize)]
pub struct SpeechModel {
    pub id: String,
    pub revision: String,
    pub filename: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Deserialize)]
struct Catalog {
    models: Vec<SpeechModel>,
}

pub fn catalog() -> Vec<SpeechModel> {
    serde_json::from_str::<Catalog>(include_str!("../data/speech-catalog.json"))
        .expect("embedded speech catalog")
        .models
}

pub struct SpeechModelStore {
    directory: PathBuf,
}
impl SpeechModelStore {
    pub fn new(state_dir: &Path) -> Self {
        Self {
            directory: state_dir.join("speech/models"),
        }
    }
    fn path(&self, model: &SpeechModel) -> Result<PathBuf, String> {
        // The catalog is embedded, but never allow an arbitrary caller to escape the store.
        if model.filename.is_empty()
            || Path::new(&model.filename).components().count() != 1
            || model.filename == "."
            || model.filename == ".."
        {
            return Err("invalid model filename".into());
        }
        Ok(self.directory.join(&model.filename))
    }
    pub fn installed_path(&self, model: &SpeechModel) -> Option<PathBuf> {
        let path = self.path(model).ok()?;
        verify(&path, model).ok().filter(|v| *v).map(|_| path)
    }
    /// Install a verified copy from a local cache without mutating that cache.
    pub fn install_file(&self, model: &SpeechModel, source: &Path) -> Result<PathBuf, String> {
        let destination = self.path(model)?;
        std::fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let partial =
            self.directory
                .join(format!(".{}.{}.part", model.filename, uuid::Uuid::new_v4()));
        let result = (|| {
            let mut input = std::fs::File::open(source).map_err(|e| e.to_string())?;
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut output = opts.open(&partial).map_err(|e| e.to_string())?;
            // Bound the copy even when an untrusted source grows during installation.
            std::io::copy(
                &mut (&mut input).take(model.size.saturating_add(1)),
                &mut output,
            )
            .map_err(|e| e.to_string())?;
            output.flush().map_err(|e| e.to_string())?;
            if !verify(&partial, model).map_err(|e| e.to_string())? {
                return Err("model verification failed".into());
            }
            std::fs::rename(&partial, &destination).map_err(|e| e.to_string())?;
            Ok(destination)
        })();
        let _ = std::fs::remove_file(partial);
        result
    }
}
fn expand_home_path(source: &str) -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    if source == "~" {
        if let Some(home) = home {
            return home;
        }
    } else if let Some(rest) = source.strip_prefix("~/").or_else(|| source.strip_prefix("~\\")) {
        if let Some(home) = home {
            return home.join(rest);
        }
    }
    PathBuf::from(source)
}

fn collect_link_candidates(root: &Path) -> Vec<(PathBuf, u64)> {
    const MAX_DEPTH: usize = 3;
    const MAX_ENTRIES: usize = 1000;
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), MAX_DEPTH)];
    let mut visited = 0usize;
    while let Some((entry, depth)) = pending.pop() {
        if visited >= MAX_ENTRIES {
            break;
        }
        visited += 1;
        let Ok(meta) = std::fs::symlink_metadata(&entry) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_file() {
            files.push((entry, meta.len()));
            continue;
        }
        if !meta.is_dir() || depth == 0 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&entry) else {
            continue;
        };
        for child in entries.flatten() {
            pending.push((child.path(), depth - 1));
        }
    }
    files
}

fn verify(path: &Path, model: &SpeechModel) -> std::io::Result<bool> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != model.size {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Ok(false);
        }
    }
    let mut file = file.take(model.size.saturating_add(1));
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hash.update(&buf[..n]);
    }
    Ok(total == model.size && format!("{:x}", hash.finalize()) == model.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installs_only_verified_content_and_detects_corruption() {
        let root = std::env::temp_dir().join(format!("speech-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        std::fs::write(&source, b"test model").unwrap();
        let model = SpeechModel {
            id: "fixture/model".into(),
            revision: "fixture".into(),
            filename: "model.gguf".into(),
            size: 10,
            sha256: format!("{:x}", Sha256::digest(b"test model")),
        };
        let store = SpeechModelStore::new(&root);
        let path = store.install_file(&model, &source).unwrap();
        assert_eq!(store.installed_path(&model), Some(path.clone()));
        std::fs::write(&path, b"bad  model").unwrap();
        assert!(store.installed_path(&model).is_none());
        assert!(store.install_file(&model, &path).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"test model");
        let mut invalid = model.clone();
        invalid.filename = "../escape".into();
        assert!(store.install_file(&invalid, &source).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn embedded_catalog_is_pinned() {
        let models = catalog();
        assert!(!models.is_empty());
        assert!(models
            .iter()
            .all(|m| m.size > 0 && m.sha256.len() == 64 && m.revision.len() == 40));
    }
    #[cfg(unix)]
    #[test]
    fn installed_model_must_not_be_a_symlink() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("speech-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        std::fs::write(&source, b"fixture").unwrap();
        let model = SpeechModel {
            id: "fixture".into(),
            revision: "test".into(),
            filename: "model.gguf".into(),
            size: 7,
            sha256: format!("{:x}", Sha256::digest(b"fixture")),
        };
        let store = SpeechModelStore::new(&root);
        let path = store.install_file(&model, &source).unwrap();
        std::fs::remove_file(&path).unwrap();
        symlink(&source, &path).unwrap();
        assert!(store.installed_path(&model).is_none());
        assert_eq!(std::fs::read(&source).unwrap(), b"fixture");
        std::fs::remove_dir_all(root).unwrap();
    }
}

type DownloadState = (
    String,
    tokio::sync::watch::Sender<bool>,
    std::sync::Arc<std::sync::atomic::AtomicU64>,
    tokio::sync::watch::Receiver<bool>,
);

/// A single in-flight model download, shared by the HTTP handlers.
pub struct Downloads {
    store: SpeechModelStore,
    base_url: String,
    client: reqwest::Client,
    current: tokio::sync::Mutex<Option<DownloadState>>,
}
impl Downloads {
    pub fn new(state_dir: &Path) -> Self {
        Self::with_base(state_dir, "https://huggingface.co")
    }
    fn with_base(state_dir: &Path, base_url: &str) -> Self {
        Self {
            store: SpeechModelStore::new(state_dir),
            base_url: base_url.trim_end_matches('/').into(),
            client: reqwest::Client::new(),
            current: tokio::sync::Mutex::new(None),
        }
    }
    pub async fn installed_path(&self, model: SpeechModel) -> Option<PathBuf> {
        let directory = self.store.directory.clone();
        tokio::task::spawn_blocking(move || SpeechModelStore { directory }.installed_path(&model))
            .await
            .ok()
            .flatten()
    }
    pub async fn link(&self, models: &[SpeechModel], source: &str) -> Result<Vec<String>, String> {
        let directory = self.store.directory.clone();
        let models = models.to_vec();
        let source = source.trim().to_owned();
        tokio::task::spawn_blocking(move || {
            let store = SpeechModelStore { directory };
            let root = expand_home_path(&source);
            std::fs::create_dir_all(&store.directory).map_err(|e| e.to_string())?;
            let files = collect_link_candidates(&root);
            let mut linked = Vec::new();
            for (file, size) in files {
                for model in &models {
                    if model.size != size || linked.contains(&model.id) {
                        continue;
                    }
                    let Ok(final_path) = store.path(model) else {
                        continue;
                    };
                    if std::fs::canonicalize(&file).ok().is_some_and(|src| {
                        std::fs::canonicalize(&final_path).ok().as_ref() == Some(&src)
                    }) {
                        continue;
                    }
                    if store.installed_path(model).is_some() {
                        continue;
                    }
                    if !verify(&file, model).unwrap_or(false) {
                        continue;
                    }
                    let staged = store.directory.join(format!(
                        ".{}.{}.part",
                        model.filename,
                        uuid::Uuid::new_v4()
                    ));
                    let installed = if std::fs::hard_link(&file, &staged).is_ok() {
                        if verify(&staged, model).unwrap_or(false)
                            && std::fs::rename(&staged, &final_path).is_ok()
                        {
                            true
                        } else {
                            let _ = std::fs::remove_file(&staged);
                            false
                        }
                    } else {
                        false
                    };
                    if installed || store.install_file(model, &file).is_ok() {
                        linked.push(model.id.clone());
                    }
                }
            }
            Ok(linked)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub async fn list(&self, selected: &str, benchmarks: bool) -> serde_json::Value {
        let current = self.current.lock().await;
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../data/speech-catalog.json")).unwrap();
        let models = catalog["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let model: SpeechModel = serde_json::from_value(m.clone()).unwrap();
                let ready = self
                    .store
                    .path(&model)
                    .ok()
                    .and_then(|p| std::fs::metadata(p).ok())
                    .is_some_and(|s| s.is_file() && s.len() == model.size);
                let operation = current.as_ref().filter(|(id, _, _, _)| *id == model.id);
                let mut out = serde_json::Map::new();
                for key in [
                    "id",
                    "name",
                    "description",
                    "size",
                    "languages",
                    "recommended",
                    "supportsStreaming",
                    "supportsLanguageDetection",
                    "supportsTranslation",
                ] {
                    out.insert(key.into(), m[key].clone());
                }
                out.insert("accuracy".into(), 0.into());
                out.insert("speed".into(), 0.into());
                if benchmarks {
                    out.insert("benchmark".into(), m["benchmark"].clone());
                }
                out.insert("active".into(), (ready && selected == model.id).into());
                out.insert(
                    "state".into(),
                    if operation.is_some() {
                        "downloading"
                    } else if ready {
                        "installed"
                    } else {
                        "downloadable"
                    }
                    .into(),
                );
                if let Some((_, _, progress, _)) = operation {
                    out.insert(
                        "downloaded".into(),
                        progress.load(std::sync::atomic::Ordering::Relaxed).into(),
                    );
                }
                serde_json::Value::Object(out)
            })
            .collect::<Vec<_>>();
        serde_json::json!({"models": models})
    }
    pub async fn cancel(&self, id: &str) {
        let done = {
            let current = self.current.lock().await;
            current
                .as_ref()
                .filter(|(name, _, _, _)| name == id)
                .map(|(_, tx, _, done)| {
                    let _ = tx.send(true);
                    done.clone()
                })
        };
        if let Some(mut done) = done {
            while !*done.borrow_and_update() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        }
    }
    pub async fn download(&self, model: &SpeechModel) -> Result<(), String> {
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        let (done_tx, done_rx) = tokio::sync::watch::channel(false);
        let progress = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        {
            let mut current = self.current.lock().await;
            if current.is_some() {
                return Err("download already in progress".into());
            }
            *current = Some((model.id.clone(), tx, progress.clone(), done_rx));
        }
        let result = self.download_inner(model, &mut rx, progress).await;
        *self.current.lock().await = None;
        let _ = done_tx.send(true);
        result
    }
    async fn download_inner(
        &self,
        model: &SpeechModel,
        rx: &mut tokio::sync::watch::Receiver<bool>,
        progress: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let destination = self.store.path(model)?;
        tokio::fs::create_dir_all(&self.store.directory)
            .await
            .map_err(|e| e.to_string())?;
        let partial =
            self.store
                .directory
                .join(format!(".{}.{}.part", model.filename, uuid::Uuid::new_v4()));
        let url = format!(
            "{}/{}/resolve/{}/{}",
            self.base_url, model.id, model.revision, model.filename
        );
        let result = async {
            let response = tokio::select! { _ = rx.changed() => return Err("cancelled".into()), r = self.client.get(url).send() => r.map_err(|e| e.to_string())? };
            if !response.status().is_success() { return Err("download failed".into()); }
            let mut response = response;
            let mut opts = tokio::fs::OpenOptions::new(); opts.write(true).create_new(true);
            #[cfg(unix)] { opts.mode(0o600); }
            let mut output = opts.open(&partial).await.map_err(|e| e.to_string())?;
            let mut length = 0u64;
            loop {
                let chunk = tokio::select! { _ = rx.changed() => return Err("cancelled".into()), r = response.chunk() => r.map_err(|e| e.to_string())? };
                let Some(chunk) = chunk else { break; };
                length = length.checked_add(chunk.len() as u64).ok_or("download too large")?;
                if length > model.size { return Err("download too large".into()); }
                output.write_all(&chunk).await.map_err(|e| e.to_string())?;
                progress.store(length, std::sync::atomic::Ordering::Relaxed);
            }
            output.flush().await.map_err(|e| e.to_string())?; drop(output);
            let check_path = partial.clone(); let check_model = model.clone();
            let valid = tokio::task::spawn_blocking(move || verify(&check_path, &check_model).unwrap_or(false)).await.map_err(|e| e.to_string())?;
            if *rx.borrow() { return Err("cancelled".into()); }
            if !valid { return Err("model verification failed".into()); }
            tokio::fs::rename(&partial, destination).await.map_err(|e| e.to_string())?;
            Ok(())
        }.await;
        let _ = tokio::fs::remove_file(partial).await;
        result
    }
}

#[cfg(test)]
mod download_tests {
    use super::*;
    use axum::{routing::get, Router};
    #[tokio::test]
    async fn downloads_and_verifies_from_local_http() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/{*path}", get(|| async { "test model" })),
            )
            .await
            .unwrap();
        });
        let root = std::env::temp_dir().join(format!("speech-download-{}", uuid::Uuid::new_v4()));
        let downloads = Downloads::with_base(&root, &format!("http://{address}"));
        let mut model = SpeechModel {
            id: "fixture/model".into(),
            revision: "fixture".into(),
            filename: "model.gguf".into(),
            size: 10,
            sha256: format!("{:x}", Sha256::digest(b"test model")),
        };
        downloads.download(&model).await.unwrap();
        assert!(downloads.store.installed_path(&model).is_some());
        std::fs::remove_file(downloads.store.path(&model).unwrap()).unwrap();
        model.sha256 = "0".repeat(64);
        assert!(downloads.download(&model).await.is_err());
        assert!(!downloads.store.path(&model).unwrap().exists());
        assert_eq!(
            std::fs::read_dir(root.join("speech/models"))
                .unwrap()
                .count(),
            0
        );
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn cancellation_removes_partial_file() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let started = std::sync::Arc::new(std::sync::Mutex::new(Some(started_tx)));
        let server = tokio::spawn(async move {
            let app = Router::new().route(
                "/{*path}",
                get(move || {
                    let started = started.clone();
                    async move {
                        if let Some(tx) = started.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        std::future::pending::<&'static str>().await
                    }
                }),
            );
            axum::serve(listener, app).await.unwrap();
        });
        let root = std::env::temp_dir().join(format!("speech-cancel-{}", uuid::Uuid::new_v4()));
        let downloads =
            std::sync::Arc::new(Downloads::with_base(&root, &format!("http://{address}")));
        let model = SpeechModel {
            id: "fixture/model".into(),
            revision: "fixture".into(),
            filename: "model.gguf".into(),
            size: 10,
            sha256: "0".repeat(64),
        };
        let task = {
            let downloads = downloads.clone();
            let model = model.clone();
            tokio::spawn(async move { downloads.download(&model).await })
        };
        started_rx.await.unwrap();
        downloads.cancel(&model.id).await;
        assert!(downloads.current.lock().await.is_none());
        assert_eq!(
            std::fs::read_dir(root.join("speech/models"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(task.await.unwrap().unwrap_err(), "cancelled");
        assert_eq!(
            std::fs::read_dir(root.join("speech/models"))
                .unwrap()
                .count(),
            0
        );
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}
