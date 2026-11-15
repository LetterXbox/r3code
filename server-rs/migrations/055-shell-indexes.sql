CREATE INDEX orchestration_v2_projection_turn_items_thread_run_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
;
CREATE INDEX orchestration_v2_projection_turn_items_shell_pending_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type IN ('command_execution', 'dynamic_tool', 'subagent')
      AND status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
;
CREATE INDEX orchestration_v2_projection_messages_latest_user_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at DESC, message_id DESC)
    WHERE role = 'user'
