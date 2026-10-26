ALTER TABLE accounts DROP CONSTRAINT accounts_check;
ALTER TABLE accounts ADD CONSTRAINT account_login_code CHECK(
  (role='SHOP' AND login_code IS NOT NULL AND login_code ~ '^00[0-9]{2}$' AND login_code<>'0000') OR
  (role='WORKER' AND ((login_code IS NOT NULL AND login_code ~ '^[1-9][0-9]{3}$') OR
    (login_code IS NULL AND status='PENDING' AND requires_manager_approval))) OR
  (role IN('MANAGER','SUPER_MANAGER','IT') AND login_code IS NULL)
);
UPDATE accounts SET login_code=NULL WHERE role='WORKER' AND status='PENDING' AND requires_manager_approval AND approved_at IS NULL;
ALTER TABLE email_jobs ADD COLUMN kind text NOT NULL DEFAULT 'PASSWORD_LINK' CHECK(kind IN ('PASSWORD_LINK','ACCOUNT_APPROVED'));
CREATE UNIQUE INDEX one_registration_confirmation ON email_jobs(account_id) WHERE kind='ACCOUNT_APPROVED';
