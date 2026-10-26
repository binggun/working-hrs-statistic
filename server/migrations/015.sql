-- Restore the original 1000–9999 employee-ID range for management accounts.
ALTER TABLE accounts DROP CONSTRAINT account_login_code;
ALTER TABLE accounts ADD CONSTRAINT account_login_code CHECK(
 (role='SHOP' AND login_code IS NOT NULL AND login_code ~ '^00[0-9]{2}$' AND login_code<>'0000') OR
 (role='WORKER' AND ((login_code IS NOT NULL AND login_code ~ '^[1-9][0-9]{3}$') OR
   (login_code IS NULL AND status IN('PENDING','DISABLED') AND requires_manager_approval AND approved_at IS NULL))) OR
 (role IN('MANAGER','GENERAL_MANAGER') AND (login_code IS NULL OR login_code ~ '^[1-9][0-9]{3}$')) OR
 (role IN('SUPER_MANAGER','IT') AND login_code IS NULL)
);
