//! Coordination and isolation primitives for destructive checkpoint restores.
//! Callers must acquire the appropriate guards around the whole operation.
use std::{
    collections::HashSet,
    fs, io,
    path::{Component, Path, PathBuf},
    sync::{Condvar, Mutex, OnceLock},
};

pub const SHARED_WORKSPACE_RESTORE_MESSAGE: &str = "File restore requires an isolated worktree. This workspace may contain changes from another thread or a side chat. Rewind the conversation without restoring files instead, or delete side chats you no longer need.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReservationKind {
    Restore,
    TurnStart,
}
#[derive(Default)]
struct State {
    leases: HashSet<PathBuf>,
    lease_waiters: Vec<(u64, PathBuf)>,
    reservations: Vec<(u64, PathBuf, ReservationKind)>,
    next: u64,
}
fn coordination() -> &'static (Mutex<State>, Condvar) {
    static STATE: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(State::default()), Condvar::new()))
}

/// A process-wide exact-path lease. Leases are non-reentrant.
pub struct WorkspaceLease {
    cwd: PathBuf,
}
pub fn workspace_lease(cwd: impl AsRef<Path>) -> WorkspaceLease {
    let cwd = cwd.as_ref().to_path_buf();
    let (mutex, cv) = coordination();
    let mut state = mutex.lock().unwrap_or_else(|e| e.into_inner());
    state.next += 1;
    let ticket = state.next;
    state.lease_waiters.push((ticket, cwd.clone()));
    while state.leases.contains(&cwd)
        || state
            .lease_waiters
            .iter()
            .find(|(_, path)| *path == cwd)
            .map(|(id, _)| *id)
            != Some(ticket)
    {
        state = cv.wait(state).unwrap_or_else(|e| e.into_inner());
    }
    state.lease_waiters.retain(|(id, _)| *id != ticket);
    state.leases.insert(cwd.clone());
    WorkspaceLease { cwd }
}
impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        let (mutex, cv) = coordination();
        mutex
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .leases
            .remove(&self.cwd);
        cv.notify_all();
    }
}

/// Resolve existing ancestors as well as symlink aliases for missing paths.
pub fn canonicalize_reservation(path: &Path) -> PathBuf {
    match fs::canonicalize(path) {
        Ok(p) => return p,
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(_) => return path.to_path_buf(),
    }
    if let Some(parent) = path
        .parent()
        .filter(|p| *p != path && !p.as_os_str().is_empty())
    {
        if let Some(name) = path.file_name() {
            return canonicalize_reservation(parent).join(name);
        }
    }
    path.to_path_buf()
}
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}
pub struct Reservation {
    id: u64,
}
pub fn reserve(cwd: impl AsRef<Path>, kind: ReservationKind) -> Reservation {
    let cwd = canonicalize_reservation(cwd.as_ref());
    let (mutex, cv) = coordination();
    let mut state = mutex.lock().unwrap_or_else(|e| e.into_inner());
    while state.reservations.iter().any(|(_, p, k)| {
        (*k == ReservationKind::Restore || kind == ReservationKind::Restore) && overlaps(p, &cwd)
    }) {
        state = cv.wait(state).unwrap_or_else(|e| e.into_inner());
    }
    state.next += 1;
    let id = state.next;
    state.reservations.push((id, cwd, kind));
    Reservation { id }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let (mutex, cv) = coordination();
        mutex
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reservations
            .retain(|(id, _, _)| *id != self.id);
        cv.notify_all();
    }
}

/// One other thread's potentially active filesystem roots, collected from the
/// shell, checkpoint and provider projections in one consistent read.
#[derive(Default)]
pub struct WorkspaceOwner {
    pub id: String,
    pub deleted: bool,
    pub side_chat: bool,
    pub active_run: bool,
    pub has_file_tools: bool,
    pub worktree_path: Option<PathBuf>,
    pub checkpoint_cwds: Vec<PathBuf>,
    /// Only non-stopped sessions without multi-thread session support belong here.
    pub exclusive_session_cwds: Vec<PathBuf>,
    /// Required when worktree_path is None; None means isolation cannot be proven.
    pub project_root: Option<PathBuf>,
}

/// Read the roots that can make a restore unsafe from one database snapshot.
/// Call this in the same transaction as rollback admission, and repeat it
/// immediately before restoring while holding the restore reservation.
pub fn restore_isolated_in_snapshot(
    db: &rusqlite::Connection,
    thread_id: &str,
    worktree: Option<&Path>,
    scope_cwd: &Path,
) -> rusqlite::Result<bool> {
    use rusqlite::OptionalExtension;
    use serde_json::Value;
    let mut stmt = db.prepare("SELECT thread_id,project_id,payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND thread_id != ?1")?;
    let threads = stmt
        .query_map([thread_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut owners = Vec::new();
    for (id, project_id, payload) in threads {
        let value: Value =
            serde_json::from_str(&payload).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let path = |v: &Value| v.as_str().map(PathBuf::from);
        let worktree_path = path(&value["worktreePath"]);
        let active_run = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting'))", [&id], |r| r.get(0))?;
        let has_file_tools = db.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND type IN ('command_execution','file_change','dynamic_tool'))", [&id], |r| r.get(0))?;
        let mut scopes = db.prepare("SELECT json_extract(payload_json,'$.cwd') FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id=?1 AND json_type(payload_json,'$.cwd')='text'")?;
        let checkpoint_cwds = scopes
            .query_map([&id], |r| r.get::<_, String>(0).map(PathBuf::from))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // Unknown capability data is treated as exclusive: failing closed is
        // safer than assuming an unrecognised provider shares sessions.
        let mut sessions = db.prepare("SELECT json_extract(payload_json,'$.cwd') FROM orchestration_v2_projection_provider_sessions WHERE thread_id=?1 AND status != 'stopped' AND json_type(payload_json,'$.cwd')='text' AND COALESCE(json_extract(payload_json,'$.capabilities.sessions.supportsMultipleProviderThreadsPerSession'),0) != 1")?;
        let exclusive_session_cwds = sessions
            .query_map([&id], |r| r.get::<_, String>(0).map(PathBuf::from))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let project_root = if worktree_path.is_none() {
            db.query_row(
                "SELECT workspace_root FROM projection_projects WHERE project_id=?1",
                [&project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(PathBuf::from)
        } else {
            None
        };
        owners.push(WorkspaceOwner {
            id,
            deleted: false,
            side_chat: value.pointer("/lineage/sideChat") == Some(&Value::Bool(true)),
            active_run,
            has_file_tools,
            worktree_path,
            checkpoint_cwds,
            exclusive_session_cwds,
            project_root,
        });
    }
    is_restore_isolated(thread_id, worktree, scope_cwd, &owners)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}
fn resolve_or_missing(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(p) => Ok(p),
        Err(e) if e.kind() == io::ErrorKind::NotFound => absolute_normalized(path),
        Err(e) => Err(e),
    }
}
fn absolute_normalized(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut out = PathBuf::new();
    for c in absolute.components() {
        match c {
            Component::CurDir => (),
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}
/// Fail closed for project-root threads and unknown other project roots.
pub fn is_restore_isolated(
    thread_id: &str,
    worktree: Option<&Path>,
    scope_cwd: &Path,
    others: &[WorkspaceOwner],
) -> io::Result<bool> {
    let Some(worktree) = worktree else {
        return Ok(false);
    };
    let cwd = resolve_or_missing(scope_cwd)?;
    if cwd != resolve_or_missing(worktree)? {
        return Ok(false);
    }
    let mut checked = HashSet::new();
    for other in others {
        if other.id == thread_id || other.deleted {
            continue;
        }
        if other.side_chat
            && !other.active_run
            && !other.has_file_tools
            && other.worktree_path.as_deref() == Some(worktree)
        {
            continue;
        }
        let mut paths: Vec<&Path> = other
            .worktree_path
            .iter()
            .map(PathBuf::as_path)
            .chain(other.checkpoint_cwds.iter().map(PathBuf::as_path))
            .chain(other.exclusive_session_cwds.iter().map(PathBuf::as_path))
            .collect();
        if other.worktree_path.is_none() {
            let Some(root) = &other.project_root else {
                return Ok(false);
            };
            paths.push(root);
        }
        for path in paths {
            if !checked.insert(path.to_path_buf()) {
                continue;
            }
            match fs::canonicalize(path) {
                Ok(p) if overlaps(&cwd, &p) => return Ok(false),
                Ok(_) => (),
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
    }
    Ok(true)
}
