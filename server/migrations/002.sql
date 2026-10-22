-- Preserve immutable evidence even if a future application change attempts to overwrite it.
CREATE FUNCTION protect_original_attendance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.worker_id,NEW.shop_id,NEW.sign_type,NEW.original_occurred_at,NEW.planned_start_at,NEW.source,NEW.offline,NEW.camera_status,NEW.photo_id,NEW.location,NEW.received_at)
     IS DISTINCT FROM ROW(OLD.worker_id,OLD.shop_id,OLD.sign_type,OLD.original_occurred_at,OLD.planned_start_at,OLD.source,OLD.offline,OLD.camera_status,OLD.photo_id,OLD.location,OLD.received_at) THEN
    RAISE EXCEPTION 'Original attendance evidence cannot be overwritten';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_attendance BEFORE UPDATE ON attendance_records FOR EACH ROW EXECUTE FUNCTION protect_original_attendance();
ALTER TABLE sessions ADD CONSTRAINT session_lifetime CHECK (expires_at > created_at);
ALTER TABLE accounts ADD CONSTRAINT required_email CHECK(role='SHOP' OR email IS NOT NULL);
ALTER TABLE work_segments ADD CONSTRAINT confirmed_same_day CHECK(status<>'CONFIRMED' OR (start_at AT TIME ZONE 'Pacific/Auckland')::date=(end_at AT TIME ZONE 'Pacific/Auckland')::date);
ALTER TABLE work_segments ADD CONSTRAINT confirmed_precision CHECK(status<>'CONFIRMED' OR (hrs=round(extract(epoch FROM(end_at-start_at))/3600,2) AND duration_minutes=extract(epoch FROM(end_at-start_at))/60));
CREATE FUNCTION enforce_segment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sign_in_record_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM attendance_records WHERE id=NEW.sign_in_record_id AND worker_id=NEW.worker_id AND shop_id=NEW.shop_id AND sign_type='SIGN_IN') THEN
    RAISE EXCEPTION 'Invalid sign in pairing';
  END IF;
  IF NEW.sign_out_record_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM attendance_records WHERE id=NEW.sign_out_record_id AND worker_id=NEW.worker_id AND shop_id=NEW.shop_id AND sign_type='SIGN_OUT') THEN
    RAISE EXCEPTION 'Invalid sign out pairing';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER valid_segment_scope BEFORE INSERT OR UPDATE ON work_segments FOR EACH ROW EXECUTE FUNCTION enforce_segment_scope();
