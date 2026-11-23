// @vitest-environment happy-dom

import type { Gateway, Tag, TaskFilesPlace } from "@supertag/client/model";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WhereItRuns, whereItRuns } from "./where-it-runs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tag: Tag = {
  tagId: "finch",
  instructions: "",
  allowedActions: [],
  revision: 1,
  harnessKind: "codex",
};

it("names the host, the Workspace with its branch, and the harness, leaving out what is unknown", () => {
  const workspace = { id: "supertag", ref: "main" };
  expect(whereItRuns({ ...tag, workspace }, { local: true, hostId: "laptop" }, true)).toEqual([
    "This Mac",
    "supertag (main)",
    "Codex",
  ]);
  expect(whereItRuns({ ...tag, workspace }, { local: true }, false)[0]).toBe("This computer");
  // Another Worker Host is named by its ID; a Workspace without a branch by its name alone.
  expect(
    whereItRuns({ ...tag, workspace: { id: "site" } }, { local: false, hostId: "build-1" }, true),
  ).toEqual(["build-1", "site", "Codex"]);
  // Before the first turn, and for a Tag without a Workspace, the harness alone.
  expect(whereItRuns(tag, undefined, true)).toEqual(["Codex"]);
  expect(whereItRuns({ harnessKind: "something_new" }, undefined, true)).toEqual(["something_new"]);
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("reads the latest turn's host once per turn, and keeps the line when that fails", async () => {
  let place: Promise<TaskFilesPlace> = Promise.resolve({ local: false, live: true, hostId: "ci" });
  const locateTaskFiles = vi.fn(() => place);
  const gateway = { locateTaskFiles } as unknown as Gateway;
  const show = (taskId?: string) =>
    act(async () => root.render(createElement(WhereItRuns, { gateway, tag, taskId })));
  await show();
  expect(locateTaskFiles).not.toHaveBeenCalled();
  expect(host.textContent).toBe("Runs on Codex");
  await show("task-1");
  expect(locateTaskFiles).toHaveBeenCalledWith("task-1");
  expect(host.textContent).toBe("Runs on ci · Codex");
  await show("task-1");
  expect(locateTaskFiles).toHaveBeenCalledTimes(1);
  place = Promise.reject(new Error("unreachable"));
  await show("task-2");
  expect(locateTaskFiles).toHaveBeenCalledTimes(2);
  expect(host.textContent).toBe("Runs on ci · Codex");
});
