-- Owner-created personnel do not need a second approval by the General manager.
-- Preserve password setup for accounts that have not set a password yet.
WITH creator AS (
  SELECT DISTINCT ON (l.resource_id) l.resource_id,l.actor_account_id
  FROM audit_logs l JOIN accounts owner ON owner.id=l.actor_account_id
  WHERE l.action='ACCOUNT_CREATE' AND owner.role='SUPER_MANAGER'
  ORDER BY l.resource_id,l.created_at
), changed AS (
  UPDATE accounts a SET requires_manager_approval=false,
    approved_by_account_id=c.actor_account_id,approved_at=now(),
    status=CASE WHEN a.password_hash IS NULL THEN 'PENDING' ELSE 'ACTIVE' END
  FROM creator c WHERE a.id=c.resource_id AND a.status='PENDING'
    AND a.role IN('WORKER','MANAGER') AND a.requires_manager_approval
  RETURNING a.id,a.status,c.actor_account_id
), logged AS (
  INSERT INTO audit_logs(actor_account_id,action,resource_id,after_data)
  SELECT actor_account_id,'OWNER_CREATION_APPROVAL_EXEMPTED',id,
    jsonb_build_object('status',status,'requiresManagerApproval',false)
  FROM changed RETURNING id
)
UPDATE organization_state SET version=version+1
WHERE id=true AND EXISTS(SELECT 1 FROM logged);
