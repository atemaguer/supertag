import { describe, expect, it } from "vitest";
import { normalizeActionFirstCommand } from "./src/action-command.js";

describe("action-first CLI normalization", () => {
  it.each([
    [
      ["create", "tag", "researcher"],
      ["tag", "create", "researcher"],
    ],
    [
      ["list", "tag"],
      ["get", "tag"],
    ],
    [
      ["get", "task", "task-a"],
      ["get", "task", "task-a"],
    ],
    [
      ["cancel", "objective", "launch", "--reason", "Dropped"],
      ["objective", "cancel", "launch", "--reason", "Dropped"],
    ],
    [
      ["update", "tag", "researcher", "--add-location", "slack", "--channel-id", "C1"],
      ["tag", "add", "researcher", "slack", "--channel-id", "C1"],
    ],
    [
      ["update", "tag", "researcher", "--add-worker-host", "laptop-a"],
      ["tag", "bind-worker-host", "researcher", "laptop-a"],
    ],
    [
      ["update", "tag", "researcher", "--remove-worker-host", "laptop-a"],
      ["tag", "unbind-worker-host", "researcher", "laptop-a"],
    ],
    [
      [
        "activate",
        "context-set",
        "research",
        "--tag",
        "researcher",
        "--provider",
        "slack",
        "--channel-id",
        "C1",
      ],
      ["tag", "context", "activate", "researcher", "research", "slack", "--channel-id", "C1"],
    ],
    [
      ["create", "team", "alpha", "--member", "one", "--member", "two"],
      ["team", "create", "alpha", "--members", "one,two"],
    ],
    [
      ["update", "objective", "goal", "--status", "ready-for-review", "--revision", "3"],
      ["objective", "status", "goal", "ready_for_review", "--revision", "3"],
    ],
    [
      ["list", "workstream-post", "--team", "crew", "--limit", "10"],
      ["workstream", "posts", "--team", "crew", "--limit", "10"],
    ],
    [
      ["grant", "mailbox", "reviewer", "--sender", "researcher"],
      ["tag", "messaging", "grant", "researcher", "reviewer"],
    ],
    [
      ["connect", "worklet", "--worker-host", "laptop-a"],
      ["worklet", "connect", "--worker-host", "laptop-a"],
    ],
    [
      ["connect", "control-plane", "https://control.example", "--name", "production"],
      ["control-plane", "connect", "https://control.example", "--name", "production"],
    ],
    [
      ["get", "control-plane", "--current"],
      ["control-plane", "current"],
    ],
    [
      ["apply", "-f", "org.yaml"],
      ["apply", "-f", "org.yaml"],
    ],
  ])("translates %j", (input, expected) => {
    expect(normalizeActionFirstCommand(input)).toEqual(expected);
  });

  it("leaves an unsupported action untouched so the dispatcher fails closed", () => {
    expect(normalizeActionFirstCommand(["delete", "objective", "goal"])).toEqual([
      "delete",
      "objective",
      "goal",
    ]);
  });
});

it.each(["create", "update"])("passes scaling flags unchanged through %s team", (action) => {
  expect(
    normalizeActionFirstCommand([
      action,
      "team",
      "research",
      "--objective",
      "goal",
      "--max-breadth",
      "0",
      "--max-depth",
      "2",
      "--max-concurrency",
      "3",
    ]),
  ).toEqual([
    "team",
    action,
    "research",
    "--objective",
    "goal",
    "--max-breadth",
    "0",
    "--max-depth",
    "2",
    "--concurrency",
    "3",
  ]);
});
