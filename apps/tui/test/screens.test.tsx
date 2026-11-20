/**
 * Screen tests for the screens around conversations: the rail's Objectives, inbox and Teams,
 * the Objective view and form, inbox answers and approvals, a Team, Work Sessions and their
 * diff, New Tag, the Tag panels (Memory, Schedules, Network, Activity), a long rail, and
 * forgetting a saved Gateway. Run with `bun test` in apps/tui.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessMemory } from "@supertag/client/model";
import {
  AttemptCleanup,
  AttemptDecision,
  HarnessKind,
  InboxItemKind,
  ObjectiveStatus,
  TaskState,
} from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import { ScheduleState } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/schedules_pb";
import type { TuiGateway } from "../src/connection";
import { FakeGateway, type FakeTag } from "./fake-gateway";
import { render, reset, type Setup, setup, TAGS } from "./harness";

let current: Setup | undefined;
afterEach(() => {
  reset(current);
  current = undefined;
});

const gatewayOf = (given: Setup) => given.controller.gateway as TuiGateway;

function coordinated() {
  const fake = new FakeGateway(TAGS);
  fake.objectives = [
    {
      objectiveId: "ship-sso",
      ownerTagId: "lead",
      outcome: "Ship single sign-on",
      teamId: "release",
      budgetLimitMinor: 30_000n,
      budgetCurrency: "USD",
      reportedSpendMinor: 1_250n,
      startingTaskId: "task-start",
    },
    {
      objectiveId: "fix-ci",
      ownerTagId: "engineer",
      outcome: "Fix the flaky CI job",
      status: ObjectiveStatus.BLOCKED,
      startingTaskId: "task-ci",
    },
    {
      objectiveId: "old",
      ownerTagId: "lead",
      outcome: "An old finished one",
      status: ObjectiveStatus.COMPLETED,
    },
  ];
  fake.inbox = [
    {
      key: "question/task-q",
      kind: InboxItemKind.QUESTION,
      taskId: "task-q",
      objectiveId: "ship-sso",
      question: "Which branch should I release?",
    },
    {
      key: "approval/ap-1",
      kind: InboxItemKind.APPROVAL,
      taskId: "task-a",
      objectiveId: "ship-sso",
      approval: {
        approvalId: "ap-1",
        tagId: "lead",
        action: "workstream:post",
        resource: "release",
        summary: "Post to the release Workstream",
      },
    },
  ];
  fake.teams = [
    { teamId: "release", name: "Release", memberTagIds: ["lead", "engineer"], maxConcurrency: 2 },
  ];
  fake.posts = [
    {
      postId: "p1",
      teamId: "release",
      authorTagId: "lead",
      body: "The rollout is ready.",
      sequence: 1,
    },
  ];
  return fake;
}

/** Moves the rail's cursor down `times` rows from the selected Tag. */
async function railDown(screen: Awaited<ReturnType<typeof render>>, times: number) {
  await screen.press("TAB");
  for (let i = 0; i < times; i++) await screen.press("j");
}

test("the rail lists open Objectives with spend or hold, the inbox, and Teams", async () => {
  current = setup(coordinated());
  const screen = await render(current, { width: 120, height: 40 });
  const frame = await screen.waitFor("Waiting on you (2)");
  expect(frame).toContain("Objectives");
  expect(frame).toContain("$12.50 of $300");
  expect(frame).toContain("blocked");
  expect(frame).not.toContain("An old finished one");
  expect(frame).toContain(" ? Which branch should");
  expect(frame).toContain(" ! workstream:post on");
  expect(frame).toMatch(/Release\s+2/u);
  await screen.close();
});

test("an Objective shows what describe objective shows, and m messages its owner", async () => {
  const fake = coordinated();
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Waiting on you (2)");
  // lead, engineer, reviewer, then the first Objective.
  await railDown(screen, 3);
  const frame = await screen.waitFor("ship-sso · working");
  expect(frame).toContain("Owner: lead · Team: release");
  expect(frame).toContain("Budget: $12.50 of $300.00 spent · $287.50 left");
  await screen.press("TAB");
  await screen.press("m");
  await screen.waitFor("Message lead");
  await screen.type("Use the main branch");
  await screen.press("RETURN");
  await screen.waitFor("lead: Noted: Use the main branch");
  expect(fake.submitted).toEqual([
    expect.objectContaining({
      tagId: "lead",
      sessionId: "objective/ship-sso",
      prompt: "Use the main branch",
    }),
  ]);
  await screen.close();
});

test("an Objective ready for review is approved with a, and its home line says so", async () => {
  const fake = coordinated();
  const ready = fake.objectives[0];
  if (ready) {
    ready.status = ObjectiveStatus.READY_FOR_REVIEW;
    ready.completionSummary = "SSO is live behind a flag.";
  }
  fake.addTurn(
    "lead",
    "/goal Ship single sign-on",
    "Created Objective ship-sso: Ship single sign-on\nlead owns it, and its first turn has started.",
  );
  current = setup(fake);
  const screen = await render(current, { width: 140, height: 40 });
  await screen.waitFor("Objective ship-sso is ready for your review: SSO is live behind a flag.");
  await railDown(screen, 3);
  await screen.waitFor("a approve · c request changes");
  await screen.press("TAB");
  await screen.press("a");
  await screen.waitFor("ship-sso · completed");
  expect(fake.reviews).toEqual([{ objectiveId: "ship-sso", approved: true, feedback: "" }]);
  await screen.close();
});

test("/goal alone opens the form; it creates with a Team and a budget, and r starts one that did not", async () => {
  const fake = coordinated();
  fake.unstartedObjectives = 1;
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  // `/` on an empty message opens the palette; `goal` after it leaves only Create Objective.
  await screen.type("/");
  await screen.waitFor("Search Tags");
  await screen.type("goal");
  const palette = await screen.waitFor("/goal · Create Objective");
  expect(palette).not.toContain("Keyboard shortcuts");
  await screen.press("RETURN");
  await screen.waitFor("New Objective for lead");
  expect(fake.sent).toEqual([]);
  await screen.type("Cut the release");
  await screen.press("RETURN");
  await screen.press("ARROW_RIGHT");
  await screen.waitFor("‹ Release ›");
  await screen.press("RETURN");
  await screen.type("12.5 eur");
  await screen.press("RETURN");
  await screen.waitFor("It did not start");
  const first = fake.createdObjectives[0] as Record<string, unknown>;
  expect(first).toMatchObject({
    ownerTagId: "lead",
    outcome: "Cut the release",
    teamId: "release",
    budgetLimitMinor: 1250n,
    budgetCurrency: "EUR",
  });
  expect(String(first["objectiveId"])).toMatch(/^cut-the-release-[0-9a-f]{8}$/u);
  await screen.press("r");
  await screen.waitFor("took its first turn");
  expect(fake.createdObjectives.map((request) => request["objectiveId"])).toEqual([
    first["objectiveId"],
    first["objectiveId"],
  ]);
  await screen.press("RETURN");
  await screen.waitFor("· working");
  await screen.close();
});

test("the Objective form refuses a budget it cannot read", async () => {
  current = setup(coordinated());
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  await screen.type("create objective");
  await screen.press("RETURN");
  await screen.waitFor("New Objective for lead");
  await screen.type("Anything");
  await screen.press("RETURN");
  await screen.press("RETURN");
  await screen.type("lots");
  await screen.press("RETURN");
  await screen.waitFor("A budget is an amount and its currency, such as 300 USD or $12.50.");
  expect(current.fake.createdObjectives).toEqual([]);
  await screen.close();
});

test("/goal with an outcome goes to the conversation like any message", async () => {
  current = setup(coordinated());
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("/");
  await screen.waitFor("Search Tags");
  await screen.type("goal Ship it");
  await screen.press("RETURN");
  await screen.waitFor("Process requests: /goal Ship it");
  expect(current.fake.sent.map((sent) => sent.text)).toEqual(["/goal Ship it"]);
  await screen.close();
});

test("an inbox question is answered in place", async () => {
  const fake = coordinated();
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Waiting on you (2)");
  // Three Tags, two Objectives, then the question.
  await railDown(screen, 5);
  await screen.waitFor("A question · Objective ship-sso");
  await screen.press("TAB");
  await screen.type("Release from main");
  await screen.press("RETURN");
  await screen.waitFor("Answered.");
  expect(fake.answers).toEqual([{ taskId: "task-q", text: "Release from main" }]);
  await screen.waitFor("Waiting on you (1)");
  await screen.close();
});

test("an approval request is approved once with a then Enter, or denied with a reason", async () => {
  const fake = coordinated();
  fake.inbox.push({
    key: "approval/ap-2",
    kind: InboxItemKind.APPROVAL,
    taskId: "task-b",
    approval: {
      approvalId: "ap-2",
      tagId: "engineer",
      action: "github:merge",
      resource: "app",
      summary: "",
    },
  });
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Waiting on you (3)");
  await railDown(screen, 6);
  const shown = await screen.waitFor("lead asks to workstream:post on release");
  expect(shown).toContain('"body": "The rollout is ready."');
  await screen.press("TAB");
  await screen.press("a");
  await screen.waitFor("Enter approves it once");
  await screen.press("RETURN");
  await screen.waitFor("Approved once.");
  await screen.press("TAB");
  await screen.press("j");
  await screen.waitFor("engineer asks to github:merge on app");
  await screen.press("TAB");
  await screen.press("d");
  await screen.waitFor("Why is it denied?");
  await screen.type("Not before the freeze ends");
  await screen.press("RETURN");
  await screen.waitFor("Denied.");
  expect(fake.decisions).toEqual([
    { approvalId: "ap-1", approve: true, reason: "" },
    { approvalId: "ap-2", approve: false, reason: "Not before the freeze ends" },
  ]);
  await screen.close();
});

test("an interrupted turn in the inbox runs again with r", async () => {
  const fake = new FakeGateway(TAGS);
  fake.inbox = [
    {
      key: "task_attention:task-u",
      kind: InboxItemKind.TASK_ATTENTION,
      taskId: "task-u",
      attemptId: "attempt-u",
      reason: "Execution of Task task-u of Tag lead is uncertain.",
      uncertainAttempt: {
        tagId: "lead",
        sessionId: "conversation/lead",
        blockedTasks: 2,
        executionReport: { cleanup: AttemptCleanup.CONFIRMED, complete: true },
        heldReason: "SuperTag cannot settle it on its own because it already said something.",
      },
    },
  ];
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Waiting on you (1)");
  await railDown(screen, 3);
  const frame = await screen.waitFor("An interrupted turn");
  expect(frame).toContain("lead · cleanup confirmed · report complete · 2 later turns wait");
  expect(frame).toContain("r retry · f mark failed");
  await screen.press("TAB");
  await screen.press("r");
  await screen.waitFor("It runs again; the later turns follow.");
  expect(fake.resolutions).toEqual([
    {
      taskId: "task-u",
      attemptId: "attempt-u",
      decision: AttemptDecision.RETRY,
      evidence:
        "Resolved from the terminal UI by operator:local: cleanup confirmed, complete true per execution report.",
      confirmedStopped: false,
    },
  ]);
  await screen.close();
});

test("an interrupted conversation turn is marked failed with Ctrl-X", async () => {
  const fake = new FakeGateway(TAGS);
  const turn = fake.addTurn("lead", "Check CI", "");
  turn.state = TaskState.UNCERTAIN;
  delete turn.result;
  turn.attemptId = "attempt-1";
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  const frame = await screen.waitFor("Ctrl-R retry · Ctrl-X mark failed");
  expect(frame).toContain("Interrupted: needs attention");
  await screen.press("x", { ctrl: true });
  await screen.waitFor("Failed");
  expect(fake.resolutions).toMatchObject([
    { taskId: turn.taskId, attemptId: "attempt-1", decision: AttemptDecision.FAILED },
  ]);
  expect(await screen.frame()).not.toContain("Ctrl-X mark failed");
  await screen.close();
});

test("an interrupted turn its host did not confirm stopped says who can decide", async () => {
  const fake = new FakeGateway(TAGS);
  fake.uncertainCleanup = AttemptCleanup.UNKNOWN;
  const turn = fake.addTurn("lead", "Check CI", "");
  turn.state = TaskState.UNCERTAIN;
  delete turn.result;
  turn.attemptId = "attempt-1";
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Ctrl-R retry · Ctrl-X mark failed");
  await screen.press("r", { ctrl: true });
  await screen.waitFor("has not confirmed this turn stopped");
  expect(fake.resolutions).toEqual([]);
  await screen.close();
});

test("a Team shows its members, its turn limit, and its Workstream", async () => {
  current = setup(coordinated());
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Waiting on you (2)");
  await railDown(screen, 7);
  const frame = await screen.waitFor("The rollout is ready.");
  expect(frame).toContain("Members: lead, engineer");
  expect(frame).toContain("at most 2 turns at once");
  await screen.close();
});

function repository() {
  const directory = mkdtempSync(path.join(tmpdir(), "supertag-tui-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(directory, "app.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(path.join(directory, "app.txt"), "one\nadded by the Work Session\n");
  git("commit", "-qam", "work");
  const head = git("rev-parse", "HEAD");
  return { directory, base, head };
}

test("↑ on an empty message opens Work Sessions; Enter expands, d diffs, o opens the pull request", async () => {
  const repo = repository();
  const fake = new FakeGateway(TAGS);
  fake.addTurn("lead", "Investigate", "On it.");
  fake.workSessions = [
    {
      workSessionId: "work/1",
      title: "Bounded investigation",
      tagId: "lead",
      parentSessionId: "conversation/lead",
      latestTaskId: "task-child",
      latestTaskState: TaskState.SUCCEEDED,
      reportTaskId: "task-report",
      baseCommit: repo.base,
      headCommit: repo.head,
      pullRequest: "https://github.com/acme/app/pull/7",
    },
  ];
  fake.activity.set("task-child", ["ran cargo test"]);
  current = setup(fake);
  const opened: string[] = [];
  const gateway = gatewayOf(current);
  gateway.workDirectory = repo.directory;
  gateway.opener = (url) => opened.push(url);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("On it.");
  await screen.press("ARROW_UP");
  await screen.waitFor("Bounded investigation");
  await screen.press("RETURN");
  const expanded = await screen.waitFor("› ran cargo test");
  expect(expanded).toContain("Report: The report of task-report");
  await screen.waitFor("o open");
  await screen.press("d");
  const diff = await screen.waitFor("+added by the Work Session");
  expect(diff).toContain("Diff · Bounded investigation");
  await screen.press("o");
  expect(opened).toEqual(["https://github.com/acme/app/pull/7"]);
  await screen.press("ESCAPE");
  await screen.waitFor("Enter expand");
  await screen.press("ESCAPE");
  await screen.waitFor("Message lead");
  await screen.close();
});

test("a diff outside a checkout says why", async () => {
  const fake = new FakeGateway(TAGS);
  fake.addTurn("lead", "Investigate", "On it.");
  fake.workSessions = [
    {
      workSessionId: "work/1",
      title: "Bounded investigation",
      tagId: "lead",
      parentSessionId: "conversation/lead",
      latestTaskId: "task-child",
      latestTaskState: TaskState.SUCCEEDED,
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
    },
  ];
  current = setup(fake);
  gatewayOf(current).workDirectory = mkdtempSync(path.join(tmpdir(), "supertag-tui-empty-"));
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("On it.");
  await screen.press("ARROW_UP");
  await screen.waitFor("Bounded investigation");
  await screen.press("d");
  await screen.waitFor("not in a git repository");
  await screen.close();
});

test("New Tag offers the hosts' harnesses and Workspaces, Web access on by default", async () => {
  const fake = new FakeGateway(TAGS);
  fake.hosts = [
    {
      hostId: "laptop",
      harnesses: [HarnessKind.CODEX, HarnessKind.CLAUDE_CODE],
      workspaces: ["app"],
    },
  ];
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("n", { ctrl: true });
  await screen.waitFor("‹ Codex ›");
  await screen.type("Release Bot");
  await screen.waitFor("ID: release-bot.");
  await screen.press("ARROW_DOWN");
  await screen.press("ARROW_RIGHT");
  await screen.waitFor("‹ Claude Code ›");
  await screen.press("ARROW_DOWN");
  await screen.waitFor("‹ app ›");
  await screen.press("ARROW_DOWN");
  await screen.press("ARROW_DOWN");
  const web = await screen.waitFor("[x] on");
  expect(web).toContain("Web pages can");
  await screen.press(" ");
  await screen.waitFor("[ ] off");
  await screen.press("RETURN");
  await screen.waitFor("Message Release Bot");
  expect(fake.putTags).toHaveLength(1);
  const put = fake.putTags[0] as Record<string, unknown>;
  expect(put).toMatchObject({
    tagId: "release-bot",
    name: "Release Bot",
    harnessKind: HarnessKind.CLAUDE_CODE,
    maxWorkSessions: 8,
    expectedRevision: 0n,
  });
  expect(put["allowedActions"]).not.toContain("web:fetch");
  expect((put["workspace"] as { workspaceId: string }).workspaceId).toBe("app");
  await screen.close();
});

test("New Tag on Local adds a folder with supertag workspace add", async () => {
  current = setup(new FakeGateway(TAGS));
  const gateway = gatewayOf(current);
  const folders: string[] = [];
  gateway.addFolder = async (folder: string) => {
    folders.push(folder);
    return { workspace: "my-repo", workspaceRef: "main" };
  };
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("n", { ctrl: true });
  await screen.waitFor("‹ Codex ›");
  await screen.type("Helper");
  await screen.press("ARROW_DOWN");
  await screen.press("ARROW_DOWN");
  await screen.press("ARROW_LEFT");
  await screen.waitFor("Choose a folder");
  await screen.press("RETURN");
  await screen.waitFor("Folder of this machine");
  await screen.type("/tmp/my-repo");
  await screen.press("RETURN");
  await screen.waitFor("‹ my-repo ›");
  expect(folders).toEqual(["/tmp/my-repo"]);
  await screen.press("s", { ctrl: true });
  await screen.waitFor("Message Helper");
  const put = current.fake.putTags[0] as { workspace: { workspaceId: string; baseRef: string } };
  expect(put.workspace).toMatchObject({ workspaceId: "my-repo", baseRef: "main" });
  expect((current.fake.putTags[0] as { allowedActions: string[] }).allowedActions).toContain(
    "web:fetch",
  );
  await screen.close();
});

test("a client device is told only an operator creates Tags", async () => {
  current = setup(new FakeGateway(TAGS, "client:alice-laptop"));
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.press("n", { ctrl: true });
  await screen.waitFor(
    "Only an operator can create Tags. This app is connected as client:alice-laptop.",
  );
  await screen.close();
});

test("Memory lists the Tag's memory on this machine, marks proposals, and x deletes one", async () => {
  const fake = new FakeGateway(TAGS);
  current = setup(fake);
  const memory = (memoryId: string, title: string, extra: Partial<HarnessMemory> = {}) => ({
    memoryId,
    tagId: "lead",
    harness: "codex",
    private: false,
    kind: "fact",
    title,
    text: title,
    truncated: false,
    status: "owned" as const,
    path: "extensions/ad_hoc/notes/n.md",
    updatedAtMs: Date.now(),
    ...extra,
  });
  let held: HarnessMemory[] = [
    memory("hmem_1", "Staging runs in eu-north-1."),
    memory("hmem_2", "Prefers small pull requests.", {
      harness: "claude-code",
      kind: "preference",
      private: true,
      trust: "proposed-only",
    }),
    memory("hmem_3", "The staging host is flaky.", { status: "proposed" }),
  ];
  const gateway = current.controller.gateway as TuiGateway;
  gateway.harnessMemory = async () => ({ memories: held, keptOn: ["laptop-2"] });
  gateway.deleteHarnessMemory = async (memoryId) => {
    const deleted = held.find((entry) => entry.memoryId === memoryId) as HarnessMemory;
    held = held.filter((entry) => entry !== deleted);
    return deleted;
  };
  const screen = await render(current, { width: 140, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  await screen.type("memory");
  await screen.press("RETURN");
  const frame = await screen.waitFor(/Memory · lead[\s\S]*Staging runs in eu-north-1/u);
  expect(frame).toContain("Codex · fact · everyone");
  expect(frame).toContain("Claude Code · preference · only you · changed by a Work Session");
  expect(frame).toContain("proposed The staging host is flaky.");
  expect(frame).toContain("waits for review");
  expect(frame).toContain("More memory is kept on Worker Host laptop-2.");
  await screen.press("x");
  for (let i = 0; i < 50 && screen.frame().includes("eu-north-1"); i++) await screen.settle(1);
  expect(screen.frame()).not.toContain("eu-north-1");
  expect(screen.frame()).toContain("Prefers small pull requests.");
  expect(held.map((entry) => entry.memoryId)).toEqual(["hmem_2", "hmem_3"]);
  await screen.close();
});

test("Memory says when the Tag keeps none on this machine", async () => {
  current = setup(new FakeGateway(TAGS));
  const gateway = current.controller.gateway as TuiGateway;
  gateway.harnessMemory = async () => ({ memories: [], keptOn: [] });
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  await screen.type("memory");
  await screen.press("RETURN");
  await screen.waitFor("lead keeps no memory on this machine yet.");
  await screen.close();
});

test("Schedules pauses and resumes with p and deletes with x", async () => {
  const fake = new FakeGateway(TAGS);
  fake.schedules = [
    { scheduleId: "sch-1", tagId: "lead", note: "Check PR 412", state: ScheduleState.ACTIVE },
  ];
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  await screen.type("schedules");
  await screen.press("RETURN");
  await screen.waitFor("Check PR 412");
  await screen.press("p");
  await screen.waitFor("paused ·");
  expect(fake.schedules[0]?.state).toBe(ScheduleState.PAUSED);
  await screen.press("p");
  for (let i = 0; i < 50 && fake.schedules[0]?.state !== ScheduleState.ACTIVE; i++)
    await screen.settle(1);
  expect(fake.schedules[0]?.state).toBe(ScheduleState.ACTIVE);
  await screen.press("x");
  await screen.waitFor("has no Schedules that will fire");
  await screen.close();
});

test("Network shows a Task Attempt's allowed and refused requests; Activity how messages landed", async () => {
  const fake = new FakeGateway(TAGS);
  fake.networkLogs = [
    {
      tagId: "lead",
      taskId: "task-9",
      allowed: 1,
      denied: 1,
      requests: [
        { method: "GET", origin: "https://api.github.com", path: "/repos", allowed: true },
        {
          method: "POST",
          origin: "https://evil.example",
          path: "/",
          allowed: false,
          reason: "not allowed",
        },
      ],
    },
  ];
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  await screen.type("network");
  await screen.press("RETURN");
  const frame = await screen.waitFor("✗ POST https://evil.example/ · not allowed");
  expect(frame).toContain("1 allowed · 1 refused");
  expect(frame).toContain("✓ GET https://api.github.com/repos 200");
  await screen.press("ESCAPE");
  await screen.press("k", { ctrl: true });
  await screen.type("activity");
  await screen.press("RETURN");
  const activity = await screen.waitFor("posted 4 messages nobody asked for");
  expect(activity).toContain("3 read · 1 answered · 2 quiet checks");
  await screen.close();
});

test("a long Tag list scrolls to keep the selected Tag in view", async () => {
  const many: FakeTag[] = Array.from({ length: 30 }, (_, index) => ({
    tagId: `tag-${String(index).padStart(2, "0")}`,
    ...(index === 0 ? { lead: true } : {}),
  }));
  current = setup(new FakeGateway(many));
  const screen = await render(current, { width: 100, height: 24 });
  await screen.waitFor("Message tag-00");
  expect(screen.frame()).not.toContain("tag-29");
  await screen.press("TAB");
  for (let i = 0; i < 29; i++) await screen.press("j");
  const frame = await screen.waitFor("Message tag-29");
  const rail = frame
    .split("\n")
    .map((line) => line.slice(0, 32))
    .join("\n");
  expect(rail).toContain("tag-29");
  expect(rail).not.toContain("tag-00");
  expect(rail).toContain("↑ more");
  await screen.close();
});

test("d in Gateways forgets a Gateway saved in the desktop app, and its cache", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "supertag-tui-test-"));
  const desktop = path.join(root, "config/desktop");
  mkdirSync(desktop, { recursive: true, mode: 0o700 });
  chmodSync(desktop, 0o700);
  const store = path.join(desktop, "gateways.json");
  writeFileSync(
    store,
    JSON.stringify({
      active: null,
      gateways: [{ profile: { name: "work", origin: "https://gw.example.com" }, token: "stcr_x" }],
    }),
    { mode: 0o600 },
  );
  current = setup(new FakeGateway(TAGS), { root });
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("p", { ctrl: true });
  await screen.waitFor("https://gw.example.com · desktop app");
  await screen.press("j");
  await screen.press("d");
  await screen.waitFor("Forget work and its cache on this device?");
  await screen.press("RETURN");
  for (let i = 0; i < 100 && screen.frame().includes("gw.example.com"); i++) await screen.settle(1);
  expect(screen.frame()).not.toContain("gw.example.com");
  const saved = JSON.parse(readFileSync(store, "utf8")) as { gateways: unknown[] };
  expect(saved.gateways).toEqual([]);
  await screen.close();
});

test("Gateways offers its keys only once the list is read, and keys before it do nothing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "supertag-tui-test-"));
  const desktop = path.join(root, "config/desktop");
  mkdirSync(desktop, { recursive: true, mode: 0o700 });
  chmodSync(desktop, 0o700);
  writeFileSync(
    path.join(desktop, "gateways.json"),
    JSON.stringify({
      active: null,
      gateways: [{ profile: { name: "work", origin: "https://gw.example.com" }, token: "stcr_x" }],
    }),
    { mode: 0o600 },
  );
  current = setup(new FakeGateway(TAGS), { root });
  const connections = current.controller.connections;
  // Connected to the saved Gateway, so the list starts on it once it is read.
  current.controller.entry = {
    id: "saved:https://gw.example.com",
    name: "work",
    detail: "",
    kind: "saved",
    available: true,
  };
  const read = connections.entries.bind(connections);
  let release = () => {};
  const listed = new Promise<void>((resolve) => {
    release = resolve;
  });
  connections.entries = async () => {
    await listed;
    return read();
  };
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("p", { ctrl: true });
  const loading = await screen.waitFor("Looking for Gateways…");
  expect(loading).not.toContain("d forget");
  await screen.press("j");
  await screen.press("d");
  expect(screen.frame()).not.toContain("Forget work");
  release();
  const shown = await screen.waitFor("d forget");
  expect(shown).not.toContain("Forget work");
  expect(shown).toContain("● work");
  await screen.press("d");
  await screen.waitFor("Forget work and its cache on this device?");
  await screen.close();
});

test("Ctrl-S in the same read as the token's last keys saves the whole token", async () => {
  current = setup();
  const connections = current.controller.connections;
  const saved: { name: string; url: string; token: string }[] = [];
  connections.save = async (gateway) => {
    saved.push(gateway);
    return "saved:https://gw.example.com";
  };
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("p", { ctrl: true });
  await screen.waitFor("d forget");
  await screen.press("a");
  await screen.waitFor("Tab next field");
  await screen.type("work");
  await screen.press("TAB");
  await screen.type("https://gw.example.com");
  await screen.press("TAB");
  // The token and Ctrl-S land before the next render, as from a busy terminal.
  await screen.inAct(async () => {
    await screen.view.mockInput.typeText("stcr_secret");
    screen.view.mockInput.pressKey("s", { ctrl: true });
  });
  for (let i = 0; i < 100 && saved.length === 0; i++) await screen.settle(1);
  expect(screen.frame()).not.toContain("Enter a name, the URL, and a token");
  expect(saved).toEqual([{ name: "work", url: "https://gw.example.com", token: "stcr_secret" }]);
  await screen.close();
});

test("text typed right after Tab lands in the next field, never the URL field", async () => {
  current = setup();
  const connections = current.controller.connections;
  const saved: { name: string; url: string; token: string }[] = [];
  connections.save = async (gateway) => {
    saved.push(gateway);
    return "saved:https://gw.example.com";
  };
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("p", { ctrl: true });
  await screen.waitFor("d forget");
  await screen.press("a");
  await screen.waitFor("Tab next field");
  // Every key of the form in one read, as a busy terminal delivers them.
  await screen.inAct(async () => {
    const input = screen.view.mockInput;
    await input.typeText("work");
    input.pressTab();
    await input.typeText("https://gw.example.com");
    input.pressTab();
    await input.typeText("stcr_secret");
    input.pressKey("s", { ctrl: true });
  });
  for (let i = 0; i < 100 && saved.length === 0; i++) await screen.settle(1);
  expect(screen.frame()).not.toContain("stcr_secret");
  expect(saved).toEqual([{ name: "work", url: "https://gw.example.com", token: "stcr_secret" }]);
  await screen.close();
});

test("a name and Enter in one read open that Tag from the palette", async () => {
  current = setup();
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  await screen.waitFor("Search Tags");
  await screen.inAct(async () => {
    await screen.view.mockInput.typeText("reviewer");
    screen.view.mockInput.pressEnter();
  });
  await screen.waitFor("Message reviewer");
  await screen.close();
});

test("a name and Ctrl-S in one read create the Tag with that name", async () => {
  const fake = new FakeGateway(TAGS);
  fake.hosts = [{ hostId: "laptop", harnesses: [HarnessKind.CODEX], workspaces: [] }];
  current = setup(fake);
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("n", { ctrl: true });
  await screen.waitFor("‹ Codex ›");
  await screen.inAct(async () => {
    await screen.view.mockInput.typeText("Release Bot");
    screen.view.mockInput.pressKey("s", { ctrl: true });
  });
  await screen.waitFor("Message Release Bot");
  expect(fake.putTags[0]).toMatchObject({ tagId: "release-bot", name: "Release Bot" });
  await screen.close();
});

test("Keyboard shortcuts lists the new keys", async () => {
  current = setup();
  const screen = await render(current, { width: 120, height: 40 });
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  await screen.type("keyboard");
  await screen.press("RETURN");
  const frame = await screen.waitFor("Create a Tag");
  expect(frame).toContain("Work Sessions: Enter expands");
  expect(frame).toContain("Approve once or deny an approval");
  await screen.close();
});
