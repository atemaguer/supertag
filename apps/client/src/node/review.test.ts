import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ObjectiveStatus,
  TaskState,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import { objective, sessionBranch, workSession } from "./coordination";
import { deliveryDiff, validRef } from "./review";

const made: string[] = [];
afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const directory = mkdtempSync(path.join(tmpdir(), "supertag-review-"));
  made.push(directory);
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
  writeFileSync(path.join(directory, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return { directory, git, base: git("rev-parse", "HEAD") };
}

describe("a Work Session's diff", () => {
  it("diffs the recorded base and head in a checkout", async () => {
    const repo = repository();
    repo.git("checkout", "-qb", "supertag/session/abc");
    writeFileSync(path.join(repo.directory, "a.txt"), "one\ntwo\n");
    repo.git("commit", "-qam", "work");
    const head = repo.git("rev-parse", "HEAD");
    const diff = await deliveryDiff(repo.directory, {
      branch: "supertag/session/abc",
      baseCommit: repo.base,
      headCommit: head,
    });
    expect(diff.reason).toBeUndefined();
    expect(diff.text).toContain("+two");
  });

  it("fetches a branch the checkout lacks from origin, without prompting", async () => {
    const remote = repository();
    remote.git("checkout", "-qb", "supertag/session/xyz");
    writeFileSync(path.join(remote.directory, "a.txt"), "one\nfrom the remote\n");
    remote.git("commit", "-qam", "work");
    const head = remote.git("rev-parse", "HEAD");
    const local = mkdtempSync(path.join(tmpdir(), "supertag-review-clone-"));
    made.push(local);
    // Only main is cloned, so the Session's branch must be fetched.
    execFileSync("git", [
      "clone",
      "-q",
      "--single-branch",
      "--branch",
      "main",
      remote.directory,
      local,
    ]);
    const diff = await deliveryDiff(local, {
      branch: "supertag/session/xyz",
      baseCommit: "",
      baseRef: "main",
      headCommit: head,
    });
    expect(diff.reason).toBeUndefined();
    expect(diff.text).toContain("+from the remote");
  });

  it("says why when it cannot diff", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "supertag-review-none-"));
    made.push(outside);
    expect(
      (await deliveryDiff(outside, { branch: "b", baseCommit: "", headCommit: "" })).reason,
    ).toContain("not in a git repository");
    const repo = repository();
    expect(
      (await deliveryDiff(repo.directory, { branch: "gone", baseCommit: "", headCommit: "" }))
        .reason,
    ).toBe("This checkout does not have branch gone and has no remote to fetch it from.");
    expect(
      (
        await deliveryDiff(repo.directory, {
          branch: "--upload-pack=x",
          baseCommit: "",
          headCommit: "",
        })
      ).reason,
    ).toContain("cannot be passed to git");
  });

  it("passes only plain refs to git", () => {
    expect(validRef("supertag/session/0af3")).toBe(true);
    for (const bad of ["-x", "a..b", "a/", "/a", "a.lock", "a//b", "a b"]) {
      expect(validRef(bad)).toBe(false);
    }
  });
});

it("names a Session's branch as the Control Plane does", () => {
  const digest = createHash("sha256").update('["lead","work/1"]').digest("hex");
  expect(sessionBranch("lead", "work/1")).toBe(`supertag/session/${digest}`);
});

it("converts Objectives and Work Sessions for the views", () => {
  expect(
    objective({
      objectiveId: "o",
      ownerTagId: "lead",
      sessionId: "s",
      outcome: "x",
      status: ObjectiveStatus.READY_FOR_REVIEW,
      revision: 3n,
      ongoing: false,
      startingTaskId: "t",
      budgetLimitMinor: 30_000n,
      budgetCurrency: "USD",
      reportedSpendMinor: 125n,
      teamId: "",
      createdBy: "operator:local",
    } as never),
  ).toEqual({
    objectiveId: "o",
    ownerTagId: "lead",
    sessionId: "s",
    outcome: "x",
    status: "ready_for_review",
    revision: 3,
    ongoing: false,
    startingTaskId: "t",
    budget: { minor: 30_000, currency: "USD" },
    spentMinor: 125,
    createdBy: "operator:local",
  });
  const work = workSession({
    workSessionId: "work/1",
    title: "t",
    parentTagId: "lead",
    parentSessionId: "conversation/lead",
    starterTaskId: "a",
    tagId: "lead",
    latestTaskId: "b",
    latestTaskState: TaskState.RUNNING,
    question: { text: "Which region?", workSessionId: "work/1" },
    createdOrder: 1n,
  } as never);
  expect(work).toMatchObject({ latestTaskState: "running", question: "Which region?" });
  expect(work.delivery).toBeUndefined();
});
