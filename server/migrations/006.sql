-- Retain the submitted type while permitting audited manager corrections.
ALTER TABLE attendance_records ADD COLUMN original_sign_type text CHECK(original_sign_type IN ('SIGN_IN','SIGN_OUT'));
UPDATE attendance_records SET original_sign_type=sign_type;
ALTER TABLE attendance_records ALTER COLUMN original_sign_type SET NOT NULL;
CREATE FUNCTION set_original_attendance_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.original_sign_type := NEW.sign_type;
  RETURN NEW;
END;
$$;
CREATE TRIGGER original_attendance_type BEFORE INSERT ON attendance_records FOR EACH ROW EXECUTE FUNCTION set_original_attendance_type();
CREATE OR REPLACE FUNCTION protect_original_attendance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.worker_id,NEW.shop_id,NEW.original_sign_type,NEW.original_occurred_at,NEW.planned_start_at,NEW.source,NEW.offline,NEW.camera_status,NEW.photo_id,NEW.location,NEW.received_at)
     IS DISTINCT FROM ROW(OLD.worker_id,OLD.shop_id,OLD.original_sign_type,OLD.original_occurred_at,OLD.planned_start_at,OLD.source,OLD.offline,OLD.camera_status,OLD.photo_id,OLD.location,OLD.received_at) THEN
    RAISE EXCEPTION 'Original attendance evidence cannot be overwritten';
  END IF;
  RETURN NEW;
END;
$$;
-- Planned start belongs to the original evidence even after a type correction.
ALTER TABLE attendance_records DROP CONSTRAINT attendance_records_check;
ALTER TABLE attendance_records ADD CONSTRAINT original_planned_start CHECK(original_sign_type='SIGN_IN' OR planned_start_at IS NULL);
ALTER TABLE attendance_adjustments ADD COLUMN before_type text CHECK(before_type IN ('SIGN_IN','SIGN_OUT'));
ALTER TABLE attendance_adjustments ADD COLUMN after_type text CHECK(after_type IN ('SIGN_IN','SIGN_OUT'));
