import { Pause, Play, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import type { Gateway, Schedule, ScheduleAction, WatchUpdate } from "../gateway";
import { useWatchRefresh, type WatchFeed } from "../lib/watch";
import { Button } from "./ui/button";

/** How often the list is read while the Watch is down. */
const interval = 15_000;

interface ScheduleListProps {
  gateway: Gateway;
  watch?: WatchFeed;
  tagId: string;
}

/**
 * The Tag's Schedules that can still fire, with their next time. Each can be paused, resumed, or
 * deleted. Nothing shows while the Tag has none.
 */
export function ScheduleList({ gateway, watch, tagId }: ScheduleListProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  const list = gateway.schedules;

  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!list) return true;
      try {
        const listed = await list(tagId);
        if (signal.aborted) return true;
        setSchedules(listed.filter(pending));
        setError("");
        return true;
      } catch (failure) {
        if (!signal.aborted) setError(String(failure));
        return false;
      }
    },
    [list, tagId],
  );
  const affected = useCallback(
    (update: WatchUpdate) => update.kind === "schedule" && update.tagId === tagId,
    [tagId],
  );
  const reload = useWatchRefresh(read, interval, watch, affected);

  async function change(schedule: Schedule, action: ScheduleAction) {
    if (!gateway.changeSchedule) return;
    setBusy(schedule.scheduleId);
    try {
      const changed = await gateway.changeSchedule(schedule.scheduleId, action);
      setSchedules((current) =>
        current
          .map((item) => (item.scheduleId === changed.scheduleId ? changed : item))
          .filter(pending),
      );
      setError("");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(undefined);
      reload();
    }
  }

  if (!list || (schedules.length === 0 && !error)) return null;
  return (
    <section className="schedules" aria-label="Schedules">
      {schedules.map((schedule) => (
        <div key={schedule.scheduleId} className="schedule" data-state={schedule.state}>
          <div className="schedule-text">
            <span className="schedule-note">{schedule.note || schedule.scheduleId}</span>
            <span className="schedule-when">{scheduleLine(schedule)}</span>
          </div>
          {schedule.state === "paused" ? (
            <Button
              variant="ghost"
              size="icon-xs"
              title="Resume"
              aria-label="Resume"
              disabled={busy === schedule.scheduleId}
              onClick={() => void change(schedule, "resume")}
            >
              <Play />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-xs"
              title="Pause"
              aria-label="Pause"
              disabled={busy === schedule.scheduleId}
              onClick={() => void change(schedule, "pause")}
            >
              <Pause />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            title="Delete"
            aria-label="Delete"
            disabled={busy === schedule.scheduleId}
            onClick={() => void change(schedule, "delete")}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      {error && <p className="schedule-error">{error}</p>}
    </section>
  );
}

/** A Schedule that can still fire. Done and deleted Schedules leave the list. */
function pending(schedule: Schedule) {
  return schedule.state === "active" || schedule.state === "paused";
}

/** "Every 0 9 * * 1 (Europe/Berlin) · next Mon, Nov 23, 9:00 AM · by tag:lead". */
export function scheduleLine(schedule: Schedule): string {
  const parts = [
    schedule.every
      ? `Every ${schedule.every.cron} (${schedule.every.timeZone})`
      : schedule.atMs !== undefined
        ? "Once"
        : "",
  ];
  if (schedule.state === "paused") parts.push("paused");
  else if (schedule.nextDueAtMs !== undefined) parts.push(`next ${when(schedule.nextDueAtMs)}`);
  parts.push(`by ${schedule.createdBy}`);
  return parts.filter(Boolean).join(" · ");
}

function when(at: number) {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
