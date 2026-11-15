//! Parsing and resolution of keyboard shortcut rules.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

pub fn shortcut(input: &str) -> Option<Value> {
    let lower = input.to_lowercase();
    let mut parts: Vec<&str> = lower.split('+').map(str::trim).collect();
    let mut trailing = 0;
    while parts.last() == Some(&"") {
        parts.pop();
        trailing += 1;
    }
    if trailing > 0 {
        parts.push("+");
    }
    if parts.is_empty() || parts.contains(&"") {
        return None;
    }
    let (mut meta, mut ctrl, mut shift, mut alt, mut modifier) =
        (false, false, false, false, false);
    let mut key = None;
    for p in parts {
        match p {
            "cmd" | "meta" => meta = true,
            "ctrl" | "control" => ctrl = true,
            "shift" => shift = true,
            "alt" | "option" => alt = true,
            "mod" => modifier = true,
            _ => {
                if key.is_some() {
                    return None;
                }
                key = Some(match p {
                    "space" => " ",
                    "esc" => "escape",
                    _ => p,
                });
            }
        }
    }
    Some(
        json!({"key":key?,"metaKey":meta,"ctrlKey":ctrl,"shiftKey":shift,"altKey":alt,"modKey":modifier}),
    )
}
#[derive(Debug, PartialEq)]
enum Token {
    Id(String),
    Not,
    And,
    Or,
    Left,
    Right,
}
fn tokenize(input: &str) -> Option<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < input.len() {
        let rest = &input[i..];
        let c = rest.chars().next()?;
        if c.is_whitespace() {
            i += c.len_utf8();
            continue;
        }
        if rest.starts_with("&&") {
            tokens.push(Token::And);
            i += 2;
            continue;
        }
        if rest.starts_with("||") {
            tokens.push(Token::Or);
            i += 2;
            continue;
        }
        match c {
            '!' => {
                tokens.push(Token::Not);
                i += 1
            }
            '(' => {
                tokens.push(Token::Left);
                i += 1
            }
            ')' => {
                tokens.push(Token::Right);
                i += 1
            }
            _ => {
                if !(c.is_ascii_alphabetic() || c == '_') {
                    return None;
                }
                let n = rest
                    .bytes()
                    .take_while(|b| {
                        b.is_ascii_alphanumeric() || *b == b'_' || *b == b'.' || *b == b'-'
                    })
                    .count();
                tokens.push(Token::Id(rest[..n].to_owned()));
                i += n;
            }
        }
    }
    Some(tokens)
}
struct Parser {
    tokens: Vec<Token>,
    index: usize,
}
impl Parser {
    fn atom(&mut self, depth: usize) -> Option<Value> {
        if depth > 64 {
            return None;
        }
        match self.tokens.get(self.index)? {
            Token::Id(name) => {
                let name = name.clone();
                self.index += 1;
                Some(json!({"type":"identifier","name":name}))
            }
            Token::Left => {
                self.index += 1;
                let v = self.or(depth + 1)?;
                if self.tokens.get(self.index) != Some(&Token::Right) {
                    return None;
                }
                self.index += 1;
                Some(v)
            }
            _ => None,
        }
    }
    fn unary(&mut self, depth: usize) -> Option<Value> {
        if depth > 64 {
            return None;
        }
        if self.tokens.get(self.index) == Some(&Token::Not) {
            self.index += 1;
            Some(json!({"type":"not","node":self.unary(depth+1)?}))
        } else {
            self.atom(depth)
        }
    }
    fn and(&mut self, depth: usize) -> Option<Value> {
        let mut left = self.unary(depth)?;
        while self.tokens.get(self.index) == Some(&Token::And) {
            self.index += 1;
            left = json!({"type":"and","left":left,"right":self.unary(depth)?});
        }
        Some(left)
    }
    fn or(&mut self, depth: usize) -> Option<Value> {
        let mut left = self.and(depth)?;
        while self.tokens.get(self.index) == Some(&Token::Or) {
            self.index += 1;
            left = json!({"type":"or","left":left,"right":self.and(depth)?});
        }
        Some(left)
    }
}
pub fn when_ast(input: &str) -> Option<Value> {
    let tokens = tokenize(input)?;
    let mut parser = Parser { tokens, index: 0 };
    let result = parser.or(0)?;
    (parser.index == parser.tokens.len()).then_some(result)
}
/// Merge custom rules by command and compile their shortcut and predicate.
pub fn resolve(custom: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let defaults: Vec<Value> =
        serde_json::from_str(include_str!("../data/default-keybindings.json"))
            .expect("embedded keybindings");
    let overridden: HashSet<&str> = custom
        .iter()
        .filter_map(|v| v["command"].as_str())
        .collect();
    let merged = defaults
        .into_iter()
        .filter(|v| !overridden.contains(v["command"].as_str().unwrap_or("")))
        .chain(custom.iter().cloned())
        .collect::<Vec<_>>();
    let start = merged.len().saturating_sub(256);
    let mut resolved = Vec::new();
    let mut issues = Vec::new();
    for (index, rule) in merged.into_iter().enumerate().skip(start) {
        let Some(command) = rule["command"].as_str().filter(|s| !s.trim().is_empty()) else {
            issues.push(json!({"kind":"keybindings.invalid-entry","index":index,"message":"Invalid command"}));
            continue;
        };
        let Some(key) = rule["key"].as_str().and_then(shortcut) else {
            issues.push(json!({"kind":"keybindings.invalid-entry","index":index,"message":"Invalid shortcut"}));
            continue;
        };
        let mut out = json!({"command":command,"shortcut":key});
        if let Some(when) = rule.get("when") {
            let Some(ast) = when.as_str().and_then(when_ast) else {
                issues.push(json!({"kind":"keybindings.invalid-entry","index":index,"message":"Invalid when expression"}));
                continue;
            };
            out["whenAst"] = ast;
        }
        resolved.push(out);
    }
    (resolved, issues)
}
pub fn load(path: &std::path::Path) -> (Vec<Value>, Vec<Value>) {
    match std::fs::read(path) {
        Ok(bytes) => match crate::lenient_json::parse::<Vec<Value>>(&bytes) {
            Ok(custom) => resolve(&custom),
            Err(error) => {
                let (bindings, _) = resolve(&[]);
                (
                    bindings,
                    vec![json!({"kind":"keybindings.invalid-json","message":error.to_string()})],
                )
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => resolve(&[]),
        Err(error) => {
            let (bindings, _) = resolve(&[]);
            (
                bindings,
                vec![json!({"kind":"keybindings.read-error","message":error.to_string()})],
            )
        }
    }
}

struct Inner {
    path: PathBuf,
    lock: Mutex<()>,
    changes: broadcast::Sender<Value>,
}
pub struct Keybindings(Arc<Inner>);

fn identity(rule: &Value) -> Option<Value> {
    let command = rule.get("command")?.as_str()?.trim();
    if command.is_empty() {
        return None;
    }
    let key = shortcut(rule.get("key")?.as_str()?)?;
    let when = match rule.get("when") {
        None => Value::Null,
        Some(v) => when_ast(v.as_str()?)?,
    };
    Some(json!([command, key, when]))
}

fn writable(path: &Path) -> Result<Vec<Value>, &'static str> {
    let data = match std::fs::read(path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("failed to read keybindings config"),
    };
    let rules: Vec<Value> =
        crate::lenient_json::parse(&data).map_err(|_| "invalid keybindings config")?;
    if rules.len() > 256 || rules.iter().any(|rule| identity(rule).is_none()) {
        return Err("keybindings config contains invalid entries");
    }
    Ok(rules)
}

fn write_rules(path: &Path, rules: &[Value]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("invalid keybindings path"))?;
    std::fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".keybindings-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        std::fs::write(&temp, format!("{}\n", serde_json::to_string_pretty(rules)?))?;
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

impl Keybindings {
    pub fn new(path: PathBuf, start: bool) -> Self {
        let (changes, _) = broadcast::channel(64);
        let inner = Arc::new(Inner {
            path,
            lock: Mutex::new(()),
            changes,
        });
        if start {
            let _guard = inner.lock.lock().unwrap_or_else(|e| e.into_inner());
            if let Ok(mut custom) = writable(&inner.path) {
                let existed = inner.path.exists();
                let migration_path = inner.path.with_file_name("keybindings-migrations");
                let migration_id = "composer.sendBackground:mod+enter";
                let previous = std::fs::read_to_string(&migration_path).unwrap_or_default();
                let pending = !previous.lines().any(|line| line == migration_id);
                let defaults: Vec<Value> =
                    serde_json::from_str(include_str!("../data/default-keybindings.json")).unwrap();
                let mut add = Vec::new();
                for rule in defaults {
                    if custom.iter().any(|r| r["command"] == rule["command"]) {
                        continue;
                    }
                    let context = (shortcut(rule["key"].as_str().unwrap()), rule.get("when"));
                    if custom
                        .iter()
                        .any(|r| (r["key"].as_str().and_then(shortcut), r.get("when")) == context)
                    {
                        continue;
                    }
                    add.push(rule);
                }
                let alongside = json!({"key":"mod+alt+enter","command":"composer.sendBackground","when":"composerFocus && draftThreadRoute"});
                let late = json!({"key":"mod+enter","command":"composer.sendBackground","when":"composerFocus && draftThreadRoute"});
                let context = (shortcut("mod+enter"), late.get("when"));
                let should_add_late = existed
                    && pending
                    && custom
                        .iter()
                        .any(|rule| identity(rule) == identity(&alongside))
                    && !custom.iter().any(|rule| {
                        (rule["key"].as_str().and_then(shortcut), rule.get("when")) == context
                    });
                if should_add_late {
                    add.push(late);
                }
                let late_skipped =
                    should_add_late && add.len() > 256usize.saturating_sub(custom.len());
                add.truncate(256usize.saturating_sub(custom.len()));
                let write_ok = if !add.is_empty() || !existed {
                    add.append(&mut custom);
                    write_rules(&inner.path, &add).is_ok()
                } else {
                    true
                };
                if pending && !late_skipped && write_ok {
                    let temp =
                        migration_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
                    let contents = format!(
                        "{}{}{}\n",
                        previous,
                        if previous.is_empty() || previous.ends_with('\n') {
                            ""
                        } else {
                            "\n"
                        },
                        migration_id
                    );
                    if std::fs::write(&temp, contents)
                        .and_then(|_| std::fs::rename(&temp, &migration_path))
                        .is_err()
                    {
                        let _ = std::fs::remove_file(temp);
                    }
                }
            }
            drop(_guard);
            Self::watch(&inner);
        }
        Self(inner)
    }
    pub fn snapshot(&self) -> Value {
        let (keybindings, issues) = load(&self.0.path);
        json!({"keybindings":keybindings,"issues":issues})
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.0.changes.subscribe()
    }
    pub fn path(&self) -> &Path {
        &self.0.path
    }
    pub fn update(&self, input: &Value, remove: bool) -> Result<Value, &'static str> {
        let id = identity(input).ok_or("invalid keybinding rule")?;
        let replacement = input
            .get("replace")
            .map(|r| identity(r).ok_or("invalid replacement rule"))
            .transpose()?;
        let _guard = self.0.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut rules = writable(&self.0.path)?;
        rules.retain(|r| {
            let found = identity(r);
            found.as_ref() != Some(&id) && found.as_ref() != replacement.as_ref()
        });
        if !remove {
            let mut rule = json!({"key":input["key"],"command":input["command"]});
            if let Some(when) = input.get("when") {
                rule["when"] = when.clone();
            }
            rules.push(rule);
        }
        if rules.len() > 256 {
            rules.drain(..rules.len() - 256);
        }
        write_rules(&self.0.path, &rules).map_err(|_| "failed to write keybindings config")?;
        let result = self.snapshot();
        let _ = self.0.changes.send(result.clone());
        Ok(result)
    }
    fn watch(inner: &Arc<Inner>) {
        use notify::{RecursiveMode, Watcher};
        let Some(parent) = inner.path.parent() else {
            return;
        };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let Ok(mut watcher) = notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        }) else {
            return;
        };
        if watcher.watch(parent, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        let weak = Arc::downgrade(inner);
        std::thread::spawn(move || {
            let _watcher = watcher;
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
                        if let Some(inner) = weak.upgrade() {
                            if event.paths.iter().any(|p| p == &inner.path) {
                                deadline = Some(
                                    std::time::Instant::now()
                                        + std::time::Duration::from_millis(100),
                                );
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    _ => {}
                }
                if deadline.is_some_and(|d| std::time::Instant::now() >= d) {
                    deadline = None;
                    let Some(inner) = weak.upgrade() else { break };
                    let _guard = inner.lock.lock().unwrap_or_else(|e| e.into_inner());
                    let (keybindings, issues) = load(&inner.path);
                    let _ = inner
                        .changes
                        .send(json!({"keybindings":keybindings,"issues":issues}));
                }
            }
        });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_respects_precedence_and_custom_overrides() {
        assert_eq!(shortcut("mod++").unwrap()["key"], "+");
        assert!(shortcut("a+b").is_none());
        assert_eq!(when_ast("a || b && !c").unwrap()["right"]["type"], "and");
        assert!(when_ast("a &&").is_none());
        let (defaults, issues) = resolve(&[]);
        assert!(issues.is_empty());
        assert!(defaults.len() > 80);
        let (custom, _) = resolve(&[json!({"key":"ctrl+x","command":"sidebar.toggle"})]);
        assert_eq!(
            custom
                .iter()
                .filter(|r| r["command"] == "sidebar.toggle")
                .count(),
            1
        );
    }

    #[test]
    fn late_default_migrates_once_and_lenient_files_are_writable() {
        let dir = std::env::temp_dir().join(format!("t3-key-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keybindings.json");
        std::fs::write(&path, r#"[ // existing binding
            {"key":"mod+alt+enter","command":"composer.sendBackground","when":"composerFocus && draftThreadRoute",},
        ]"#).unwrap();
        let service = Keybindings::new(path.clone(), true);
        let rules: Vec<Value> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(rules
            .iter()
            .any(|r| r["key"] == "mod+enter" && r["command"] == "composer.sendBackground"));
        service.update(&json!({"key":"mod+enter","command":"composer.sendBackground","when":"composerFocus && draftThreadRoute"}), true).unwrap();
        drop(service);
        let service = Keybindings::new(path.clone(), true);
        let rules: Vec<Value> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!rules
            .iter()
            .any(|r| r["key"] == "mod+enter" && r["command"] == "composer.sendBackground"));
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn updates_are_persisted_and_external_edits_are_published() {
        let dir = std::env::temp_dir().join(format!("t3-keys-{}", uuid::Uuid::new_v4()));
        let path = dir.join("keybindings.json");
        let keys = Keybindings::new(path.clone(), true);
        assert!(path.exists());
        let mut events = keys.subscribe();
        let input = json!({"key":"cmd+k","command":"sidebar.toggle","when":"a&&b"});
        let result = keys.update(&input, false).unwrap();
        assert!(result["issues"].as_array().unwrap().is_empty());
        keys.update(
            &json!({"key":"meta+k","command":"sidebar.toggle","when":"a && b"}),
            true,
        )
        .unwrap();
        let rules: Vec<Value> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!rules.iter().any(|r| r["key"] == "cmd+k"));
        while events.try_recv().is_ok() {}
        std::fs::write(&path, r#"[{"key":"ctrl+x","command":"external.action"}]"#).unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let value = events.recv().await.unwrap();
                if value["keybindings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["command"] == "external.action")
                {
                    break value;
                }
            }
        })
        .await
        .unwrap();
        assert!(event["issues"].as_array().unwrap().is_empty());
        std::fs::write(&path, "not json").unwrap();
        assert!(keys.update(&input, false).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
        drop(keys);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
