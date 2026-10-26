-- Shared personal workspace: management accounts also have a personal attendance identity.
INSERT INTO workers(account_id,contact,address)
SELECT id,profile_phone,profile_address FROM accounts
WHERE role IN('MANAGER','GENERAL_MANAGER','SUPER_MANAGER')
ON CONFLICT(account_id) DO NOTHING;
