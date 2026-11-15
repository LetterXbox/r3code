use std::{fs, sync::mpsc, time::Duration};
use t3code_server::workspace_safety::{
    is_restore_isolated, reserve, restore_isolated_in_snapshot, workspace_lease, ReservationKind,
    WorkspaceOwner,
};

#[test]
fn snapshot_isolation_checks_other_threads_and_unknown_projects() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,payload_json TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,status TEXT); CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,type TEXT); CREATE TABLE orchestration_v2_projection_checkpoint_scopes(thread_id TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_provider_sessions(thread_id TEXT,status TEXT,payload_json TEXT); CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT);").unwrap();
    let root = std::env::temp_dir().join(format!("safety-snapshot-{}", uuid::Uuid::new_v4()));
    let worktree = root.join("worktree");
    fs::create_dir_all(&worktree).unwrap();
    db.execute(
        "INSERT INTO orchestration_v2_projection_threads VALUES('other','missing',?1,NULL)",
        [serde_json::json!({"worktreePath":null}).to_string()],
    )
    .unwrap();
    assert!(!restore_isolated_in_snapshot(&db, "t", Some(&worktree), &worktree).unwrap());
    db.execute(
        "UPDATE orchestration_v2_projection_threads SET payload_json=?1",
        [serde_json::json!({"worktreePath":root}).to_string()],
    )
    .unwrap();
    assert!(!restore_isolated_in_snapshot(&db, "t", Some(&worktree), &worktree).unwrap());
    db.execute(
        "UPDATE orchestration_v2_projection_threads SET deleted_at='now'",
        [],
    )
    .unwrap();
    assert!(restore_isolated_in_snapshot(&db, "t", Some(&worktree), &worktree).unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn isolation_rejects_overlaps_and_unknown_projects_but_allows_idle_side_chat() {
    let root = std::env::temp_dir().join(format!("safety-{}", uuid::Uuid::new_v4()));
    let worktree = root.join("worktree");
    let nested = worktree.join("nested");
    let sibling = root.join("worktree2");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    let owner = |path| WorkspaceOwner {
        id: "other".into(),
        worktree_path: Some(path),
        ..Default::default()
    };
    assert!(
        !is_restore_isolated("t", Some(&worktree), &worktree, &[owner(nested.clone())]).unwrap()
    );
    assert!(!is_restore_isolated("t", Some(&worktree), &worktree, &[owner(root.clone())]).unwrap());
    assert!(is_restore_isolated("t", Some(&worktree), &worktree, &[owner(sibling)]).unwrap());
    assert!(!is_restore_isolated(
        "t",
        Some(&worktree),
        &worktree,
        &[WorkspaceOwner {
            id: "other".into(),
            ..Default::default()
        }]
    )
    .unwrap());
    let side = WorkspaceOwner {
        side_chat: true,
        ..owner(worktree.clone())
    };
    assert!(is_restore_isolated("t", Some(&worktree), &worktree, &[side]).unwrap());
    let active = WorkspaceOwner {
        side_chat: true,
        active_run: true,
        ..owner(worktree.clone())
    };
    assert!(!is_restore_isolated("t", Some(&worktree), &worktree, &[active]).unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reservations_exclude_overlapping_restore_but_not_parallel_starts() {
    let root = std::env::temp_dir().join(format!("reservation-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let start = reserve(&root, ReservationKind::TurnStart);
    let second = reserve(root.join("sub"), ReservationKind::TurnStart);
    let (tx, rx) = mpsc::channel();
    let other = root.join("sub");
    let thread = std::thread::spawn(move || {
        let _guard = reserve(other, ReservationKind::Restore);
        tx.send(()).unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
    drop(start);
    assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
    drop(second);
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    thread.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn leases_serialize_same_key_and_release_on_drop() {
    let key = std::env::temp_dir().join(format!("lease-{}", uuid::Uuid::new_v4()));
    let held = workspace_lease(&key);
    let (tx, rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let _guard = workspace_lease(key);
        tx.send(()).unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
    drop(held);
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    thread.join().unwrap();
}
