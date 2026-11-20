/**
 * Objectives: the view of one (what `supertag describe objective` shows, kept current), where
 * `m` sends its owner a follow-up and, while it is ready for review, `a` approves it and `c` asks
 * for changes; and the form `/goal` opens to create one owned by the selected Tag, with a Team
 * and a budget. A created Objective starts its owner's first turn; when it could not start, `r`
 * starts it once that is fixed.
 */
import {
  describe,
  formatMoney,
  newObjectiveId,
  type Objective,
  objectiveHold,
  parseBudget,
  statusLabel,
  type Team,
  type WatchUpdate,
} from "@supertag/client/model";
import { useWatchRefresh, type WatchFeed } from "@supertag/client/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TuiGateway } from "./connection";
import { clip, safe } from "./text";
import { color, type KeyEvent, useKeyboard } from "./ui";

const date = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** The lines describing an Objective, as `supertag describe objective` does. */
export function objectiveLines(objective: Objective, tagName: (tagId: string) => string): string[] {
  const hold = objectiveHold(objective);
  const lines = [
    `${objective.objectiveId} · ${statusLabel(objective.status)}${hold && hold !== objective.status && hold !== "review" ? ` · ${hold}` : ""}${objective.ongoing ? " · ongoing" : ""}`,
    `Owner: ${tagName(objective.ownerTagId)}${objective.teamId ? ` · Team: ${objective.teamId}` : " · works alone"}`,
  ];
  const budget = objective.budget;
  const spent = objective.spentMinor;
  if (budget) {
    const used = spent ?? 0;
    lines.push(
      `Budget: ${formatMoney(used, budget.currency)} of ${formatMoney(budget.minor, budget.currency)} spent · ${formatMoney(budget.minor - used, budget.currency)} left`,
    );
  } else if (spent !== undefined) {
    lines.push(`Spent: ${spent} minor units · no budget`);
  } else lines.push("No budget");
  if (objective.deadlineMs !== undefined) lines.push(`Deadline: ${date(objective.deadlineMs)}`);
  if (objective.pausedAtMs !== undefined) lines.push(`Paused since ${date(objective.pausedAtMs)}`);
  if (objective.idleSinceMs !== undefined)
    lines.push(
      `Idle since ${date(objective.idleSinceMs)}: its owner's last turn left nothing running`,
    );
  if (objective.createdBy) lines.push(`Created by ${objective.createdBy}`);
  if (!objective.startingTaskId) lines.push("Its first turn has not started.");
  return lines;
}

interface Exchange {
  text: string;
  taskId?: string;
  state?: string;
  result?: string;
  error?: string;
}

export function ObjectiveView({
  gateway,
  watch,
  objective: listed,
  focused,
  tagName,
  onChanged,
}: {
  gateway: TuiGateway;
  watch: WatchFeed | undefined;
  objective: Objective;
  focused: boolean;
  tagName(tagId: string): string;
  onChanged(): void;
}) {
  const id = listed.objectiveId;
  const [objective, setObjective] = useState(listed);
  const [mode, setMode] = useState<"view" | "message" | "changes">("view");
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const [exchange, setExchange] = useState<Exchange | undefined>();
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setObjective(listed), [listed]);
  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const fresh = await gateway.objective(id);
        if (!signal.aborted) setObjective(fresh);
      } catch {
        return false;
      }
    },
    [gateway, id],
  );
  const changed = useCallback(
    (update: WatchUpdate) => update.kind === "objective" && update.objectiveId === id,
    [id],
  );
  useWatchRefresh(read, 5_000, watch, changed);

  // The follow-up's reply: read until its turn finishes.
  const taskId = exchange?.taskId;
  const finished = exchange?.result !== undefined;
  useEffect(() => {
    if (!taskId || finished) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const task = await gateway.taskResult(taskId);
        if (stopped) return;
        const done = ["succeeded", "failed", "cancelled"].includes(task.state);
        setExchange((prior) =>
          prior && prior.taskId === taskId
            ? { ...prior, state: task.state, ...(done ? { result: task.result } : {}) }
            : prior,
        );
        if (done) return;
      } catch {
        // Read again on the next tick.
      }
      if (!stopped) timer = setTimeout(poll, 1_000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [gateway, taskId, finished]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setProblem("");
    try {
      const sent = await gateway.messageObjective(id, trimmed);
      setExchange({ text: trimmed, taskId: sent.taskId, state: "queued" });
      setDraft("");
      setMode("view");
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function review(approved: boolean, text: string) {
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      setObjective(await gateway.reviewObjective(id, approved, text.trim()));
      setFeedback("");
      setMode("view");
      onChanged();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }

  const reviewable = objective.status === "ready_for_review";
  useKeyboard((key: KeyEvent) => {
    if (!focused || key.ctrl || key.meta) return;
    if (mode !== "view") {
      if (key.name === "escape") setMode("view");
      return;
    }
    if (key.name === "m") setMode("message");
    else if (reviewable && key.name === "a") void review(true, "");
    else if (reviewable && key.name === "c") setMode("changes");
  });

  const owner = tagName(objective.ownerTagId);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      minWidth={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={color.strong}>{safe(objective.outcome)}</text>
      {objectiveLines(objective, tagName).map((line) => (
        <text key={line} fg={color.muted}>
          {safe(line)}
        </text>
      ))}
      {objective.completionSummary ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={color.faint}>{reviewable ? "Ready for review" : "Summary"}</text>
          <text fg={color.text}>{safe(objective.completionSummary)}</text>
        </box>
      ) : null}
      {exchange ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={color.you}>You: {safe(exchange.text)}</text>
          {exchange.result !== undefined ? (
            <text fg={color.text}>
              {safe(owner)}: {safe(exchange.result || `(${exchange.state})`)}
            </text>
          ) : (
            <text fg={color.faint}>
              {safe(owner)} {exchange.state === "running" ? "is working…" : "has it queued…"}
            </text>
          )}
        </box>
      ) : null}
      <box flexGrow={1} />
      {problem ? <text fg={color.error}>{safe(problem)}</text> : null}
      {mode === "message" || mode === "changes" ? (
        <box
          border
          borderColor={focused ? color.focus : color.border}
          height={3}
          flexShrink={0}
          title={mode === "message" ? `Message ${clip(owner, 30)}` : "What should change?"}
        >
          <input
            focused={focused}
            placeholder={
              mode === "message" ? "A follow-up for the owner" : "Feedback for the owner"
            }
            value={mode === "message" ? draft : feedback}
            onInput={(value: string) => (mode === "message" ? setDraft(value) : setFeedback(value))}
            onSubmit={(value: string) =>
              mode === "message" ? void send(String(value)) : void review(false, String(value))
            }
          />
        </box>
      ) : null}
      <text fg={color.faint} flexShrink={0}>
        {busy
          ? "Waiting for the Gateway…"
          : mode === "view"
            ? `m message ${clip(owner, 20)}${reviewable ? " · a approve · c request changes" : ""}${draft ? " (draft kept)" : ""}`
            : "Enter send · Esc back (the draft is kept)"}
      </text>
    </box>
  );
}

const FIELDS = ["Outcome", "Team", "Budget"] as const;

/**
 * The new Objective form, for an Objective `owner` owns: its outcome, the Team its owner may
 * hand work to (none: it works alone), and a budget such as `300 USD` or `$12.50` (empty: none).
 * ↑ ↓ move between fields, ← → choose the Team, Enter moves on and, on the budget, creates it.
 */
export function ObjectiveForm({
  gateway,
  owner,
  ownerName,
  teams,
  width,
  onShow,
  onClose,
}: {
  gateway: TuiGateway;
  owner: string;
  ownerName: string;
  teams: readonly Team[];
  width: number;
  onShow(objectiveId: string): void;
  onClose(): void;
}) {
  // The field in front, also as a ref: keys can land before the next render.
  const [field, showField] = useState(0);
  const at = useRef(0);
  const setField = (next: number) => {
    at.current = Math.max(0, Math.min(2, next));
    showField(at.current);
  };
  const [outcome, setOutcome] = useState("");
  const [team, setTeam] = useState(-1);
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [created, setCreated] = useState<Objective | undefined>();
  const id = useRef<string | undefined>(undefined);

  async function create() {
    if (busy) return;
    const text = outcome.trim();
    if (!text) {
      setProblem("Say the outcome the Objective is for.");
      setField(0);
      return;
    }
    let money: ReturnType<typeof parseBudget>;
    try {
      money = parseBudget(budget);
    } catch (error) {
      setProblem(String(error));
      setField(2);
      return;
    }
    id.current ??= newObjectiveId(text);
    setBusy(true);
    setProblem("");
    try {
      const chosen = teams[team];
      setCreated(
        await gateway.createObjective({
          objectiveId: id.current,
          ownerTagId: owner,
          outcome: text,
          ...(chosen ? { teamId: chosen.teamId } : {}),
          ...(money ? { budget: money } : {}),
        }),
      );
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }

  useKeyboard((key: KeyEvent) => {
    if (busy) return;
    if (key.name === "escape") {
      onClose();
      return;
    }
    if (created) {
      if (key.name === "return" || key.name === "enter") {
        onClose();
        onShow(created.objectiveId);
      } else if (key.name === "r" && !created.startingTaskId) void create();
      return;
    }
    if (key.name === "up") setField(at.current - 1);
    else if (key.name === "down" || key.name === "tab") setField(at.current + 1);
    else if (at.current === 1 && (key.name === "left" || key.name === "right"))
      setTeam((chosen) => {
        const next = chosen + (key.name === "right" ? 1 : -1);
        return next < -1 ? teams.length - 1 : next >= teams.length ? -1 : next;
      });
    else if (key.name === "return" || key.name === "enter") {
      if (at.current === 2) void create();
      else setField(at.current + 1);
    }
  });

  const chosen = teams[team];
  return (
    <box
      width={width}
      flexDirection="column"
      border
      borderColor={color.focus}
      backgroundColor="#151515"
      title={`New Objective for ${clip(ownerName, 30)}`}
      marginTop={2}
    >
      {created ? (
        <>
          <text fg={color.strong}>Created Objective {safe(created.objectiveId)}.</text>
          {created.startingTaskId ? (
            <text fg={color.text}>
              {safe(ownerName)} took its first turn as Task {safe(created.startingTaskId)}.
            </text>
          ) : (
            <text fg={color.warning}>
              It did not start. Once that is fixed, press r to start it.
            </text>
          )}
          {problem ? <text fg={color.error}>{safe(problem)}</text> : null}
          <text fg={color.faint}>
            {busy
              ? "Waiting for the Gateway…"
              : `Enter shows the Objective${created.startingTaskId ? "" : " · r starts it"} · Esc back`}
          </text>
        </>
      ) : (
        <>
          <text fg={color.muted}>It works in the Workspace configured on {safe(ownerName)}.</text>
          {FIELDS.map((label, position) => (
            <box key={label} flexDirection="row" height={1}>
              <text fg={position === field ? color.strong : color.muted} width={9}>
                {label}
              </text>
              <box width={Math.max(10, width - 13)} height={1}>
                {position === 1 ? (
                  <text fg={chosen ? color.text : color.faint}>
                    {chosen
                      ? `‹ ${safe(chosen.name)} ›`
                      : teams.length
                        ? "‹ none: it works alone ›"
                        : "none: no Teams"}
                  </text>
                ) : (
                  <input
                    focused={position === field}
                    placeholder={
                      position === 0
                        ? "What should be true when it is done"
                        : "optional: 300 USD or $12.50"
                    }
                    value={position === 0 ? outcome : budget}
                    onInput={(value: string) =>
                      position === 0 ? setOutcome(value) : setBudget(value)
                    }
                  />
                )}
              </box>
            </box>
          ))}
          {problem ? <text fg={color.error}>{safe(problem)}</text> : null}
          <text fg={color.faint}>
            {busy ? "Creating…" : "↑ ↓ fields · ← → Team · Enter next, then creates · Esc back"}
          </text>
        </>
      )}
    </box>
  );
}
