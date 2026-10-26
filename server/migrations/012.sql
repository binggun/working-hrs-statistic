ALTER TABLE accounts DROP CONSTRAINT accounts_role_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_role_check CHECK(role IN('SHOP','WORKER','MANAGER','GENERAL_MANAGER','SUPER_MANAGER','IT'));
ALTER TABLE accounts DROP CONSTRAINT account_login_code;
ALTER TABLE accounts ADD CONSTRAINT account_login_code CHECK(
 (role='SHOP' AND login_code IS NOT NULL AND login_code ~ '^00[0-9]{2}$' AND login_code<>'0000') OR
 (role='WORKER' AND ((login_code IS NOT NULL AND login_code ~ '^[1-9][0-9]{3}$') OR
   (login_code IS NULL AND status IN('PENDING','DISABLED') AND requires_manager_approval AND approved_at IS NULL))) OR
 (role IN('MANAGER','GENERAL_MANAGER') AND (login_code IS NULL OR login_code ~ '^[1-9][0-9]{3}$')) OR
 (role IN('SUPER_MANAGER','IT') AND login_code IS NULL)
);
CREATE UNIQUE INDEX unique_general_manager ON accounts(role) WHERE role='GENERAL_MANAGER' AND status<>'DISABLED';
CREATE TABLE manager_workers(manager_account_id uuid NOT NULL REFERENCES accounts(id),worker_id uuid NOT NULL REFERENCES workers(id),PRIMARY KEY(manager_account_id,worker_id));
CREATE INDEX manager_workers_worker ON manager_workers(worker_id);
CREATE TABLE organization_state(id boolean PRIMARY KEY DEFAULT true CHECK(id),version integer NOT NULL DEFAULT 1);
INSERT INTO organization_state(id) VALUES(true);
ALTER TABLE shops ADD COLUMN profile_version integer NOT NULL DEFAULT 1;
-- All unactivated personnel, including invitations created by administrators, require approval.
UPDATE accounts SET requires_manager_approval=true WHERE status='PENDING' AND role IN('WORKER','MANAGER');
DROP INDEX backend_email;
CREATE UNIQUE INDEX backend_email ON accounts(lower(email)) WHERE role IN('MANAGER','GENERAL_MANAGER','SUPER_MANAGER','IT');
