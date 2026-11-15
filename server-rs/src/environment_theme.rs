//! Published environment themes and change notifications.
use serde_json::{Map, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::broadcast;

pub fn valid_id(id: &str) -> bool {
    let reserved = [
        "system",
        "light",
        "dark",
        "t3-chat",
        "grove",
        "ocean",
        "ember",
        "iris",
        "t3-chat-dark",
        "t3-grove",
        "t3-ocean",
        "t3-ember",
        "t3-iris",
        "t3-code",
    ];
    !reserved.contains(&id)
        && !id.is_empty()
        && id.len() <= 48
        && id
            .bytes()
            .enumerate()
            .all(|(i, c)| c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && c == b'-'))
}
fn colors(value: &Value) -> Option<Value> {
    let mut result = Map::new();
    for (key, value) in value.as_object()? {
        if key.is_empty()
            || key.len() > 64
            || !key
                .bytes()
                .enumerate()
                .all(|(i, c)| c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
        {
            return None;
        }
        let color = value.as_str()?.trim();
        if color.is_empty() || color.chars().count() > 64 {
            return None;
        }
        result.insert(key.clone(), Value::String(color.to_owned()));
    }
    Some(Value::Object(result))
}
pub fn theme(id: &str, raw: &[u8]) -> Option<Value> {
    let raw = raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(raw);
    let value: Value = serde_json::from_slice(raw).ok()?;
    let name = value.get("name")?.as_str()?.trim();
    if name.is_empty() || name.chars().count() > 48 {
        return None;
    }
    let appearance = value.get("appearance")?.as_str()?;
    if !["light", "dark"].contains(&appearance) || value.get("version").is_some_and(|v| *v != 1) {
        return None;
    }
    let mut out = Map::new();
    out.insert("id".into(), id.into());
    out.insert("name".into(), name.into());
    out.insert("appearance".into(), appearance.into());
    if let Some(v) = value.get("version") {
        out.insert("version".into(), v.clone());
    }
    for key in ["canvas", "accent"] {
        if let Some(v) = value.get(key) {
            let s = v.as_str()?;
            if !s.starts_with('#')
                || ![4, 7].contains(&s.len())
                || !s[1..].bytes().all(|b| b.is_ascii_hexdigit())
            {
                return None;
            }
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(v) = value.get("colors") {
        out.insert("colors".into(), colors(v)?);
    }
    if let Some(v) = value.get("variants") {
        let variants = v.as_object()?;
        let mut clean = Map::new();
        for key in ["light", "dark"] {
            if let Some(v) = variants.get(key) {
                clean.insert(key.into(), colors(v)?);
            }
        }
        out.insert("variants".into(), clean.into());
    }
    if !(out.contains_key("canvas") && out.contains_key("accent"))
        && out
            .get("colors")
            .and_then(Value::as_object)
            .is_none_or(Map::is_empty)
    {
        return None;
    }
    Some(Value::Object(out))
}
pub fn read_file(path: &Path) -> Option<Vec<u8>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(not(unix))]
    if std::fs::symlink_metadata(path)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    let mut file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > 32 * 1024 {
        return None;
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(32 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= 32 * 1024).then_some(bytes)
}
pub fn read(dir: &Path) -> Vec<Value> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    entries.sort();
    let mut result = Vec::new();
    let mut examined = 0;
    let mut total = 0;
    for entry in entries {
        let Some(name) = entry.to_str() else { continue };
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if !valid_id(id) {
            continue;
        }
        examined += 1;
        if examined > 32 {
            break;
        }
        let Some(bytes) = read_file(&dir.join(&entry)) else {
            continue;
        };
        let Some(value) = theme(id, &bytes) else {
            continue;
        };
        total += bytes.len();
        if total > 192 * 1024 {
            break;
        }
        result.push(value);
    }
    result
}
struct Inner {
    path: PathBuf,
    changes: broadcast::Sender<Vec<Value>>,
}
pub struct Themes(Arc<Inner>);
impl Themes {
    pub fn new(path: PathBuf, start: bool) -> Self {
        let (changes, _) = broadcast::channel(16);
        let inner = Arc::new(Inner { path, changes });
        if start {
            Self::watch(&inner);
        }
        Self(inner)
    }
    pub fn snapshot(&self) -> Vec<Value> {
        read(&self.0.path)
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<Value>> {
        self.0.changes.subscribe()
    }
    fn watch(inner: &Arc<Inner>) {
        use notify::{RecursiveMode, Watcher};
        if std::fs::create_dir_all(&inner.path).is_err() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let Ok(mut watcher) = notify::recommended_watcher(move |e| {
            let _ = tx.send(e);
        }) else {
            return;
        };
        if watcher
            .watch(&inner.path, RecursiveMode::NonRecursive)
            .is_err()
        {
            return;
        }
        let weak = Arc::downgrade(inner);
        let prior = read(&inner.path);
        std::thread::spawn(move || {
            let _watcher = watcher;
            let mut prior = prior;
            let mut deadline = None;
            loop {
                if weak.strong_count() == 0 {
                    break;
                }
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(Ok(event))
                        if matches!(
                            event.kind,
                            notify::EventKind::Any
                                | notify::EventKind::Create(_)
                                | notify::EventKind::Modify(_)
                                | notify::EventKind::Remove(_)
                        ) =>
                    {
                        deadline =
                            Some(std::time::Instant::now() + std::time::Duration::from_millis(100))
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    _ => {}
                }
                if deadline.is_some_and(|d| std::time::Instant::now() >= d) {
                    deadline = None;
                    let Some(inner) = weak.upgrade() else { break };
                    let next = read(&inner.path);
                    if next != prior {
                        prior = next.clone();
                        let _ = inner.changes.send(next);
                    }
                }
            }
        });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn publishes_only_safe_valid_themes_and_tracks_edits() {
        let dir = std::env::temp_dir().join(format!("t3-themes-{}", uuid::Uuid::new_v4()));
        let service = Themes::new(dir.clone(), true);
        let mut updates = service.subscribe();
        std::fs::write(
            dir.join("my-theme.json"),
            r##"{"name":" Mine ","appearance":"dark","canvas":"#123","accent":"#abcdef"}"##,
        )
        .unwrap();
        std::fs::write(
            dir.join("dark.json"),
            r##"{"name":"reserved","appearance":"dark","canvas":"#123","accent":"#123"}"##,
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("my-theme.json"), dir.join("link.json")).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["id"], "my-theme");
        assert_eq!(result[0]["name"], "Mine");
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
