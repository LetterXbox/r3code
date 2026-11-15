-- V2 never reads these copied V1 projections; pre-0.1.0 builds use state.sqlite, preserving rollback.
DROP TABLE IF EXISTS projection_thread_activities;
DROP TABLE IF EXISTS projection_turns;
DROP TABLE IF EXISTS projection_thread_proposed_plans;
DROP TABLE IF EXISTS projection_pending_approvals;
DROP TABLE IF EXISTS projection_state;
DROP TABLE IF EXISTS checkpoint_diff_blobs;
