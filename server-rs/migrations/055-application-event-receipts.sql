INSERT INTO orchestration_command_receipts (
      command_id,
      aggregate_kind,
      aggregate_id,
      accepted_at,
      result_sequence,
      status,
      error,
      command_type
    )
    SELECT
      command_id,
      'thread',
      thread_id,
      accepted_at,
      COALESCE(
        (
          SELECT MAX(events.sequence)
          FROM orchestration_events events
          WHERE events.application_event_version = 2
            AND events.command_id = receipts.command_id
        ),
        0
      ),
      status,
      error,
      command_type
    FROM orchestration_v2_command_receipts receipts
    WHERE TRUE
    ON CONFLICT(command_id) DO NOTHING
