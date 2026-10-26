ALTER TABLE accounts ADD COLUMN requires_manager_approval boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN approved_by_account_id uuid REFERENCES accounts(id);
ALTER TABLE accounts ADD COLUMN approved_at timestamptz;
-- Include self-registrations that are still pending when this migration is applied.
UPDATE accounts a SET requires_manager_approval=true
WHERE a.status='PENDING' AND a.role='WORKER'
  AND EXISTS(SELECT 1 FROM audit_logs l WHERE l.resource_id=a.id AND l.action='SELF_REGISTRATION');
