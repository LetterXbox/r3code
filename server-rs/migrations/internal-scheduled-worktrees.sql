CREATE TABLE IF NOT EXISTS scheduled_worktree_preparations (
    run_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_root TEXT NOT NULL,
    worktree_path TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('planned', 'created', 'attached')),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_worktree_setup_completed (
    thread_id TEXT PRIMARY KEY
);
