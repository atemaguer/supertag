import { expect, it } from "vitest";
import { evaluateMcpPreflight } from "../examples/shared-organization/mcp-preflight.mjs";

const identity = {
  actor: "probe",
  taskId: "mcp-preflight",
  attemptId: "current",
  transport: "http",
  collection: "docs",
};
const write = { ...identity, action: "publish", committed: true, text: "INTERRUPTED_HANDOFF" };
const read = { ...identity, action: "read", text: "INTERRUPTED_HANDOFF" };
function evaluate(entries: object[], extra = {}) {
  return evaluateMcpPreflight({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    entries,
    denied: true,
    interrupted: true,
    observedText: "INTERRUPTED_HANDOFF",
    ...extra,
  });
}

it("requires the exact probe's committed write, readback, and locally denied call", () => {
  expect(evaluate([write, read])).toMatchObject({
    passed: true,
    interruptedWriteObserved: true,
    deniedCallObserved: true,
    committedWrites: 1,
    forbiddenCalls: 0,
  });
  for (const foreign of [
    { actor: "claude" },
    { attemptId: "previous" },
    { taskId: "manager-work" },
  ])
    expect(
      evaluate([
        { ...write, ...foreign },
        { ...read, ...foreign },
      ]).passed,
    ).toBe(false);
  expect(evaluate([write], { observedText: "INTERRUPTED_HANDOFF" }).passed).toBe(false);
  expect(evaluate([write, read], { denied: false }).passed).toBe(false);
  expect(evaluate([write, read], { interrupted: false }).passed).toBe(false);
});

it("rejects duplicate effects, backend policy bypass, and stale readback", () => {
  expect(evaluate([write, write, read])).toMatchObject({ passed: false, committedWrites: 2 });
  expect(evaluate([write, { ...write, transport: "stdio" }, read])).toMatchObject({
    passed: false,
    committedWrites: 2,
  });
  expect(
    evaluate([write, read, { ...read, collection: "private", forbidden: true }]),
  ).toMatchObject({ passed: false, deniedCallObserved: false, forbiddenCalls: 1 });
  expect(evaluate([write, { ...read, text: "stale" }]).passed).toBe(false);
  expect(evaluate([write, read], { observedText: "stale" }).passed).toBe(false);
});
