CREATE INDEX orchestration_v2_projection_turn_items_stop_request_idx
ON orchestration_v2_projection_turn_items(thread_id, run_id)
WHERE type = 'run_interrupt_request';
