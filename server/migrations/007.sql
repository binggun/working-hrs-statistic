CREATE TABLE attendance_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  recipient_email text NOT NULL,
  subject text NOT NULL,
  snapshot_data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','PROCESSING','SENT','FAILED')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
