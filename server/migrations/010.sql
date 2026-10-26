ALTER TABLE attendance_records ADD COLUMN manager_confirmed boolean NOT NULL DEFAULT false;
UPDATE attendance_records r SET manager_confirmed=true
WHERE r.confirmed_deleted OR EXISTS(
  SELECT 1 FROM attendance_adjustments j WHERE j.record_id=r.id AND j.status='APPROVED'
);
