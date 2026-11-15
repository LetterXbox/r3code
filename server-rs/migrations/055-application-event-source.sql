ALTER TABLE orchestration_events
    ADD COLUMN application_event_version INTEGER NOT NULL DEFAULT 1
;
CREATE INDEX idx_orchestration_events_application_sequence
    ON orchestration_events(application_event_version, sequence)
;
ALTER TABLE orchestration_command_receipts
    ADD COLUMN command_type TEXT NOT NULL DEFAULT 'legacy'
