ALTER TABLE accounts
  ADD COLUMN first_name text NOT NULL DEFAULT '',
  ADD COLUMN last_name text NOT NULL DEFAULT '',
  ADD COLUMN profile_address text NOT NULL DEFAULT '',
  ADD COLUMN profile_phone text NOT NULL DEFAULT '',
  ADD COLUMN profile_version integer NOT NULL DEFAULT 1;
-- Preserve existing display names without guessing how a person's name is split.
UPDATE accounts SET first_name=name;
UPDATE accounts a SET profile_address=COALESCE(w.address,''),profile_phone=COALESCE(w.contact,'')
FROM workers w WHERE w.account_id=a.id;
