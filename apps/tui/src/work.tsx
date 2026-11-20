/**
 * Work Sessions (↑ on an empty message): the longer work the conversation's turns started, each
 * with its state, the latest selected. Enter expands one: its Session, its latest Task, the
 * commands and tools that Task ran, its report, and what it delivered. A Work Session that
 * delivered a branch can be reviewed: `d` shows `git diff BASE...BRANCH` computed in the
 * directory the terminal UI started in (the Gateway keeps no repository contents), `o` opens its
 * pull request. Esc goes back, from a diff to the list.
 */
import {
  describe,
  type WatchUpdate,
  type WorkBranch,
  type WorkDiff,
  type WorkSession,
  workState,
} from "@supertag/client/model";
import { useWatchRefresh, type WatchFeed } from "@supertag/client/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TuiGateway } from "./connection";
import { clip, safe } from "./text";
import { color, type KeyEvent, type ScrollBoxRenderable, useKeyboard } from "./ui";

interface Detail {
  activity?: string[];
  report?: string;
  branch?: WorkBranch | null;
}

export function WorkSessions({
  gateway,
  watch,
  tagId,
  sessionIds,
  width,
  height,
  onClose,
}: {
  gateway: TuiGateway;
  watch: WatchFeed | undefined;
  tagId: string;
  /** The Sessions of the conversation's turns, whose Work Sessions are listed. */
  sessionIds: readonly string[];
  width: number;
  height: number;
  onClose(): void;
}) {
  const [sessions, setSessions] = useState<WorkSession[] | undefined>();
  const [problem, setProblem] = useState("");
  const [index, setIndex] = useState<number | undefined>();
  const [expanded, setExpanded] = useState<string | undefined>();
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [diff, setDiff] = useState<{ work: WorkSession; branch: WorkBranch; result?: WorkDiff }>();
  const key = sessionIds.join("\n");
  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const lists = await Promise.all(
          key
            .split("\n")
            .filter(Boolean)
            .map((sessionId) => gateway.workSessions(tagId, sessionId)),
        );
        if (signal.aborted) return;
        setSessions(lists.flat());
        setProblem("");
      } catch (error) {
        if (!signal.aborted) setProblem(describe(error));
        return false;
      }
    },
    [gateway, tagId, key],
  );
  const affected = useCallback(
    (update: WatchUpdate) =>
      (update.kind === "work" || update.kind === "conversation") && update.tagId === tagId,
    [tagId],
  );
  useWatchRefresh(read, 5_000, watch, affected);
  const list = sessions ?? [];
  const at = Math.min(index ?? list.length - 1, list.length - 1);
  const selected = list[at];

  // An expanded Work Session reads its activity, report and branch once per latest Task.
  const open = list.find((work) => work.workSessionId === expanded);
  const openKey = open
    ? `${open.workSessionId}:${open.latestTaskId}:${open.reportTaskState ?? ""}`
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again only when its Task moves.
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    const id = open.workSessionId;
    const merge = (part: Detail) =>
      !stopped && setDetails((prior) => ({ ...prior, [id]: { ...prior[id], ...part } }));
    void gateway.taskActivity(open.latestTaskId).then(
      (activity) => merge({ activity }),
      () => {},
    );
    if (open.reportTaskId)
      void gateway.taskResult(open.reportTaskId).then(
        (task) => merge({ report: task.result }),
        () => {},
      );
    void gateway.workBranch(open).then(
      (branch) => merge({ branch: branch ?? null }),
      () => merge({ branch: null }),
    );
    return () => {
      stopped = true;
    };
  }, [gateway, openKey]);

  const branchOf = (work: WorkSession | undefined) =>
    work ? (details[work.workSessionId]?.branch ?? undefined) : undefined;
  const showDiff = async (work: WorkSession) => {
    const branch = branchOf(work) ?? (await gateway.workBranch(work).catch(() => undefined));
    if (!branch) {
      setProblem("This Work Session has not delivered a branch yet.");
      return;
    }
    setDiff({ work, branch });
    const result = await gateway.diff(branch);
    setDiff((prior) =>
      prior?.work.workSessionId === work.workSessionId ? { ...prior, result } : prior,
    );
  };
  const openPullRequest = (work: WorkSession | undefined) => {
    const url =
      branchOf(work)?.pullRequest ?? (diff?.work === work ? diff?.branch.pullRequest : undefined);
    if (!url) {
      setProblem("This Work Session has no pull request.");
      return;
    }
    try {
      gateway.open(url);
      setProblem(`Opened ${url}`);
    } catch (error) {
      setProblem(describe(error));
    }
  };

  const scroll = useRef<ScrollBoxRenderable>(null);
  useKeyboard((event: KeyEvent) => {
    if (diff) {
      const box = scroll.current;
      const page = Math.max(1, (box?.viewport.height ?? 10) - 2);
      if (event.name === "escape") setDiff(undefined);
      else if (event.name === "down" || event.name === "j") box?.scrollBy(1);
      else if (event.name === "up" || event.name === "k") box?.scrollBy(-1);
      else if (event.name === "pagedown" || event.name === "space") box?.scrollBy(page);
      else if (event.name === "pageup") box?.scrollBy(-page);
      else if (event.name === "o") openPullRequest(diff.work);
      return;
    }
    if (event.name === "escape") onClose();
    else if (event.name === "down" || event.name === "j")
      setIndex(Math.min(at + 1, list.length - 1));
    else if (event.name === "up" || event.name === "k") setIndex(Math.max(at - 1, 0));
    else if ((event.name === "return" || event.name === "enter") && selected)
      setExpanded((prior) =>
        prior === selected.workSessionId ? undefined : selected.workSessionId,
      );
    else if (event.name === "d" && selected) void showDiff(selected);
    else if (event.name === "o" && selected) openPullRequest(selected);
  });

  const inner = Math.max(20, width - 4);
  if (diff) {
    const result = diff.result;
    return (
      <box
        width={width}
        height={height}
        flexDirection="column"
        border
        borderColor={color.focus}
        backgroundColor="#151515"
        title={`Diff · ${clip(diff.work.title || diff.work.workSessionId, 40)}`}
        marginTop={1}
      >
        <text fg={color.muted}>{clip(`Branch ${diff.branch.branch}`, inner)}</text>
        {result?.note ? <text fg={color.warning}>{safe(result.note)}</text> : null}
        {!result ? <text fg={color.muted}>Computing the diff with git…</text> : null}
        {result?.reason ? (
          <>
            <text fg={color.warning}>{safe(result.reason)}</text>
            {diff.branch.pullRequest ? (
              <text fg={color.text}>Pull request: {safe(diff.branch.pullRequest)}</text>
            ) : null}
          </>
        ) : null}
        {result?.text !== undefined ? (
          <scrollbox ref={scroll} flexGrow={1} minHeight={0}>
            {result.text === "" ? <text fg={color.muted}>No changes.</text> : null}
            {result.text
              .split("\n")
              .slice(0, 20_000)
              .map((line, position) => (
                <text
                  // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines never move.
                  key={position}
                  fg={
                    line.startsWith("+++") || line.startsWith("---")
                      ? color.strong
                      : line.startsWith("+")
                        ? color.you
                        : line.startsWith("-")
                          ? color.error
                          : line.startsWith("@@")
                            ? color.accent
                            : color.text
                  }
                >
                  {safe(line) || " "}
                </text>
              ))}
          </scrollbox>
        ) : (
          <box flexGrow={1} />
        )}
        <text fg={color.faint}>
          ↑ ↓ PgUp PgDn scroll{diff.branch.pullRequest ? " · o open the pull request" : ""} · Esc
          back
        </text>
      </box>
    );
  }
  return (
    <box
      width={width}
      maxHeight={height}
      flexDirection="column"
      border
      borderColor={color.focus}
      backgroundColor="#151515"
      title="Work Sessions"
      marginTop={1}
    >
      {sessions === undefined && !problem ? (
        <text fg={color.muted}>Loading Work Sessions…</text>
      ) : null}
      {sessions?.length === 0 ? (
        <text fg={color.muted}>No turn of this conversation started a Work Session.</text>
      ) : null}
      {list.map((work, position) => {
        const state = workState(work);
        const isOpen = work.workSessionId === expanded;
        const detail = details[work.workSessionId];
        return (
          <box key={work.workSessionId} flexDirection="column">
            <text
              fg={position === at ? color.strong : color.text}
              bg={position === at ? color.selected : undefined}
            >
              {isOpen ? "▾ " : "▸ "}
              {clip(work.title || work.workSessionId, Math.max(10, inner - state.length - 4))}
              <span fg={state === "waiting on you" ? color.warning : color.muted}> {state}</span>
            </text>
            {isOpen ? (
              <box flexDirection="column" paddingLeft={2}>
                <text fg={color.muted}>
                  {clip(
                    `Session ${work.workSessionId} · ${work.tagId}${work.objectiveId ? ` · Objective ${work.objectiveId}` : ""}`,
                    inner - 2,
                  )}
                </text>
                <text fg={color.muted}>
                  Latest Task {safe(work.latestTaskId)} · {work.latestTaskState}
                </text>
                {work.question ? <text fg={color.warning}>Asks: {safe(work.question)}</text> : null}
                {(detail?.activity ?? []).slice(-8).map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: activity is append-only.
                  <text key={index} fg={color.faint}>
                    {clip(`› ${line}`, inner - 2)}
                  </text>
                ))}
                {detail?.report ? (
                  <text fg={color.text}>Report: {clip(detail.report, (inner - 10) * 3)}</text>
                ) : null}
                {work.delivery ? (
                  <text fg={color.muted}>
                    Delivered {work.delivery.changedFiles}{" "}
                    {work.delivery.changedFiles === 1 ? "file" : "files"}
                    {work.delivery.headCommit ? ` at ${work.delivery.headCommit.slice(0, 12)}` : ""}
                  </text>
                ) : null}
              </box>
            ) : null}
            {branchOf(work) ? (
              <text fg={color.accent} paddingLeft={2}>
                {clip(`Branch ${branchOf(work)?.branch}`, inner - 22)}
                <span fg={color.faint}>
                  {"   d diff"}
                  {branchOf(work)?.pullRequest ? "  o open" : ""}
                </span>
              </text>
            ) : null}
          </box>
        );
      })}
      {problem ? <text fg={color.warning}>{safe(problem)}</text> : null}
      <text fg={color.faint}>
        ↑ ↓ move · Enter expand · d diff · o open the pull request · Esc back
      </text>
    </box>
  );
}
