-- The watch feed announces Schedules (WatchKind 7): created, changed (paused, resumed, fired,
-- done, cancelled), and deleted (a staged one dropped with its turn). A Schedule in a
-- conversation is its principal's; any other is the operators'. The memory watch migration
-- already admits kind 7.
CREATE TRIGGER supertag_v2_watch_schedule_created AFTER INSERT ON supertag_v2_schedules
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 7, 1, NEW.schedule_id, NEW.tag_id, NEW.session_id, COALESCE(NEW.objective_id, ''),
               '', '', COALESCE(NEW.audience_principal, '');
END;

CREATE TRIGGER supertag_v2_watch_schedule_changed AFTER UPDATE ON supertag_v2_schedules
WHEN NEW.state <> OLD.state OR NEW.next_due_at_ms IS NOT OLD.next_due_at_ms
  OR NEW.fire_count <> OLD.fire_count OR NEW.missed_count <> OLD.missed_count
  OR NEW.note <> OLD.note OR NEW.cron IS NOT OLD.cron OR NEW.time_zone IS NOT OLD.time_zone
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 7, 2, NEW.schedule_id, NEW.tag_id, NEW.session_id, COALESCE(NEW.objective_id, ''),
               '', '', COALESCE(NEW.audience_principal, '');
END;

CREATE TRIGGER supertag_v2_watch_schedule_deleted AFTER DELETE ON supertag_v2_schedules
BEGIN
    INSERT INTO supertag_v2_watch_append
        SELECT 7, 3, OLD.schedule_id, OLD.tag_id, OLD.session_id, COALESCE(OLD.objective_id, ''),
               '', '', COALESCE(OLD.audience_principal, '');
END;

UPDATE supertag_v2_schema SET version=96 WHERE version=95;
