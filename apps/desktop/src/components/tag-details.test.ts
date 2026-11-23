// @vitest-environment happy-dom

import type { Gateway, NetworkLog, Tag, TagActivity } from "@supertag/client/model";
import { watchFeed } from "@supertag/client/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gatewaySession } from "../gateway";
import {
  attentionLine,
  networkRequestLine,
  networkTotals,
  periodWords,
  startRateLine,
  TagDetails,
} from "./tag-details";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tag: Tag = {
  tagId: "lead",
  name: "Lead",
  instructions: "",
  allowedActions: [],
  revision: 1,
  harnessKind: "codex",
};
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

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

function inspectorTab(name: string) {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (element) => element.textContent === name,
  );
  if (!tab) throw new Error(`Missing ${name} tab`);
  return tab;
}

async function openTab(name: string) {
  act(() => inspectorTab(name).click());
  await settle();
  expect(inspectorTab(name).getAttribute("aria-selected")).toBe("true");
}

const networkLog: NetworkLog = {
  taskId: "9f1c2d3e4b5a",
  attemptId: "attempt-1",
  allowed: 2,
  denied: 1,
  unrecorded: 0,
  requests: [
    {
      atMs: Date.now(),
      method: "GET",
      origin: "https://api.github.com",
      path: "/repos/acme",
      allowed: true,
      status: 200,
      credential: "github",
    },
    {
      atMs: Date.now(),
      method: "CONNECT",
      origin: "https://example.org",
      path: "",
      allowed: false,
      reason: "origin is not in the Task's network scope",
    },
  ],
};

it("words each network request and an Attempt's totals", () => {
  expect(networkRequestLine(networkLog.requests[0]!)).toBe(
    "GET https://api.github.com/repos/acme → 200 · with github",
  );
  expect(networkRequestLine(networkLog.requests[1]!)).toBe(
    "CONNECT https://example.org refused: origin is not in the Task's network scope",
  );
  expect(networkTotals({ ...networkLog, unrecorded: 4 })).toBe(
    "2 allowed · 1 refused · 4 more not listed",
  );
});

it("shows the Tag's network log as its own section and rereads when a turn ends", async () => {
  let held: NetworkLog[] = [];
  const networkLogs = vi.fn(async () => held);
  const gateway = { networkLogs } as unknown as Gateway;
  const feed = watchFeed();
  act(() => root.render(createElement(TagDetails, { gateway, watch: feed, tag, onClose() {} })));
  await settle();
  await openTab("Network");
  expect(networkLogs).toHaveBeenCalledWith("lead");
  expect(host.textContent).toContain("No network log yet.");
  held = [networkLog];
  act(() => feed.publish({ kind: "conversation", tagId: "lead" }));
  await settle();
  const lines = [...host.querySelectorAll(".network-request")].map((node) => node.textContent);
  expect(lines).toEqual([
    "GET https://api.github.com/repos/acme → 200 · with github",
    "CONNECT https://example.org refused: origin is not in the Task's network scope",
  ]);
  expect(host.textContent).toContain("Task 9f1c2d3e");
});

it("tells a person who is not an operator that only operators see the network log", async () => {
  const gateway = {
    networkLogs: async () => {
      throw new Error("This connection cannot access that resource.");
    },
  } as unknown as Gateway;
  act(() => root.render(createElement(TagDetails, { gateway, tag, onClose() {} })));
  await settle();
  await openTab("Network");
  expect(host.textContent).toContain("Only operators can see the network log.");
});

it("words a period, the unprompted messages, and a start rate", () => {
  expect(periodWords(60 * 60 * 1000)).toBe("hour");
  expect(periodWords(2 * 60 * 60 * 1000)).toBe("2 hours");
  expect(periodWords(24 * 60 * 60 * 1000)).toBe("day");
  expect(periodWords(30 * 60 * 1000)).toBe("30 minutes");
  expect(attentionLine({ windowDays: 30, posted: 6, read: 4, answered: 2, quiet: 19 })).toBe(
    "6 posted · 4 read · 2 answered · 19 stayed quiet",
  );
  expect(startRateLine({ starts: 10, perMs: 60 * 60 * 1000, inWindow: 3 })).toBe(
    "At most 10 per hour · 3 started in the last hour",
  );
});

it("opens the Activity disclosure and rereads it when one of the Tag's turns ends", async () => {
  let activity: TagActivity = { windowDays: 30, posted: 0, read: 0, answered: 0, quiet: 0 };
  const tagActivity = vi.fn(async () => activity);
  const feed = watchFeed();
  const gateway = { tagActivity } as unknown as Gateway;
  act(() => root.render(createElement(TagDetails, { gateway, watch: feed, tag, onClose() {} })));
  await settle();
  const summary = [...host.querySelectorAll("summary")].find((entry) =>
    entry.textContent?.includes("Activity"),
  );
  const section = summary?.closest("details");
  expect(section?.open).toBe(false);
  act(() => summary?.click());
  await settle();
  expect(section?.open).toBe(true);
  expect(section?.textContent).toContain("Lead sent nothing unprompted.");
  expect(section?.textContent).toContain("Start rate");
  expect(section?.textContent).toContain("None");
  activity = {
    windowDays: 30,
    posted: 6,
    read: 4,
    answered: 2,
    quiet: 19,
    startRate: { starts: 10, perMs: 60 * 60 * 1000, inWindow: 3 },
  };
  act(() => feed.publish({ kind: "conversation", tagId: "lead" }));
  await settle();
  expect(tagActivity).toHaveBeenCalledTimes(2);
  expect(section?.textContent).toContain("6 posted · 4 read · 2 answered · 19 stayed quiet");
  expect(section?.textContent).toContain("At most 10 per hour · 3 started in the last hour");
  expect(section?.textContent).not.toContain("Idle Objectives");
  activity = {
    ...activity,
    idleObjectives: [
      { objectiveId: "ship", outcome: "Ship SSO\nwith tests", idleSinceMs: Date.now() },
    ],
  };
  act(() => feed.publish({ kind: "conversation", tagId: "lead" }));
  await settle();
  expect(section?.textContent).toContain("Idle Objectives");
  expect(section?.textContent).toMatch(/Ship SSO · idle since /);
});

it("navigates the available inspector tabs with the keyboard and resets on Tag change", async () => {
  const harnessMemory = vi.fn();
  const gateway = {
    harnessMemory,
    networkLogs: async () => [],
  } as unknown as Gateway;
  const render = (shown: Tag) =>
    act(() => root.render(createElement(TagDetails, { tag: shown, gateway, onClose() {} })));
  render(tag);
  const names = () => [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
  expect(names()).toEqual(["Overview", "Network"]);
  expect(inspectorTab("Overview").getAttribute("aria-selected")).toBe("true");
  expect(inspectorTab("Overview").tabIndex).toBe(0);
  expect(inspectorTab("Network").tabIndex).toBe(-1);

  const press = async (name: string, key: string, next: string) => {
    act(() => {
      const tab = inspectorTab(name);
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await settle();
    const selected = inspectorTab(next);
    expect(document.activeElement).toBe(selected);
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.id).toBe(
      selected.getAttribute("aria-controls"),
    );
  };
  await press("Overview", "ArrowRight", "Network");
  await press("Network", "ArrowRight", "Overview");
  await press("Overview", "ArrowLeft", "Network");
  await press("Network", "Home", "Overview");
  await openTab("Network");
  expect(harnessMemory).not.toHaveBeenCalled();
  render({ ...tag, tagId: "reviewer", name: "Reviewer" });
  expect(inspectorTab("Overview").getAttribute("aria-selected")).toBe("true");
});

it("shows only features provided by the connected Gateway", () => {
  const gateway = {} as Gateway;
  const configured = {
    ...tag,
    instructions: "Review changes to the identity service.",
    allowedActions: ["web:fetch"],
    openWorkSessions: 0,
    maxWorkSessions: 2,
  };
  act(() => root.render(createElement(TagDetails, { tag: configured, gateway, onClose() {} })));
  expect([...host.querySelectorAll("dl dd")].map((fact) => fact.textContent)).toEqual([
    "Codex",
    "0 of 2",
    configured.instructions,
  ]);
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  const summaries = [...host.querySelectorAll("summary")];
  expect(summaries).toHaveLength(1);
  expect(summaries[0]?.textContent).toContain("Permissions");
  const permissions = summaries[0]?.closest("details");
  expect(permissions?.open).toBe(false);
  act(() => summaries[0]?.click());
  expect(permissions?.open).toBe(true);
  expect(permissions?.querySelector("li")?.textContent).toBe("web:fetch");
});

it("exposes network logs for operator connections to the desktop app", () => {
  expect(gatewaySession("c", "local", "operator:local").networkLogs).toBeTypeOf("function");
  expect(gatewaySession("c", "prod", "client:mac").networkLogs).toBeUndefined();
  expect(gatewaySession("c", "unknown").networkLogs).toBeUndefined();
});

it("closes on Esc, unless a dialog or menu is open and takes it first", async () => {
  const onClose = vi.fn();
  const gateway = {} as unknown as Gateway;
  act(() => root.render(createElement(TagDetails, { gateway, tag, onClose })));
  await settle();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onClose).not.toHaveBeenCalled();
  dialog.remove();
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});
