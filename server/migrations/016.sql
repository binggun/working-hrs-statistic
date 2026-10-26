ALTER TABLE photos ADD COLUMN deleted_at timestamptz;
CREATE INDEX photos_retention_due ON photos(created_at,id) WHERE status='READY';
