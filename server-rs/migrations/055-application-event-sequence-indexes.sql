CREATE INDEX idx_orchestration_events_application_high_water
    ON orchestration_events(sequence)
    WHERE aggregate_kind = 'project'
      OR (application_event_version = 2 AND aggregate_kind = 'thread')
;
CREATE INDEX idx_orchestration_events_agent_stream_sequence
    ON orchestration_events(stream_id, sequence)
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
