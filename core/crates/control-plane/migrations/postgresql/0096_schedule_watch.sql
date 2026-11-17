-- The watch feed announces Schedules (WatchKind 7): created, changed (paused, resumed, fired,
-- done, cancelled), and deleted (a staged one dropped with its turn). A Schedule in a
-- conversation is its principal's; any other is the operators'.
CREATE FUNCTION supertag_v2_watch_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    item supertag_v2_schedules%ROWTYPE;
    reason BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        item := OLD;
        reason := 3;
    ELSE
        item := NEW;
        reason := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 2 END;
    END IF;
    INSERT INTO supertag_v2_watch_append
        SELECT 7, reason, item.schedule_id, item.tag_id, item.session_id,
               COALESCE(item.objective_id, ''), '', '', COALESCE(item.audience_principal, '');
    RETURN NULL;
END;
$$;
CREATE TRIGGER supertag_v2_watch_schedule_created AFTER INSERT ON supertag_v2_schedules
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_schedule();
CREATE TRIGGER supertag_v2_watch_schedule_changed AFTER UPDATE ON supertag_v2_schedules
FOR EACH ROW WHEN (NEW.state <> OLD.state OR NEW.next_due_at_ms IS DISTINCT FROM OLD.next_due_at_ms
    OR NEW.fire_count <> OLD.fire_count OR NEW.missed_count <> OLD.missed_count
    OR NEW.note <> OLD.note OR NEW.cron IS DISTINCT FROM OLD.cron
    OR NEW.time_zone IS DISTINCT FROM OLD.time_zone)
EXECUTE FUNCTION supertag_v2_watch_schedule();
CREATE TRIGGER supertag_v2_watch_schedule_deleted AFTER DELETE ON supertag_v2_schedules
FOR EACH ROW EXECUTE FUNCTION supertag_v2_watch_schedule();

UPDATE supertag_v2_schema SET version=96 WHERE version=95;
