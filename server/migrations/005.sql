-- Removal is a retained record state, derived from the existing reversible soft-removal flag.
ALTER TABLE attendance_records ADD COLUMN record_status text GENERATED ALWAYS AS
  (CASE WHEN effective_deleted THEN 'removal' ELSE 'active' END) STORED;
