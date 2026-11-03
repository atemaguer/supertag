import { expect, it, vi } from "vitest";
import {
  type HarnessControlCommand,
  LocalHarnessExecutionControl,
  validateHarnessControlCapabilities,
} from "./src/harness-control.js";

const scope = { taskId: "task", attemptId: "attempt" };
const capabilities = { version: 1 as const, operations: ["input", "reply", "interrupt"] as const };
const input = (id = "one"): HarnessControlCommand => ({
  ...scope,
  id,
  type: "input",
  text: "Continue with the next step",
});

it("acknowledges operator input behind a stalled peer before the caller's deadline", async () => {
  vi.useFakeTimers();
  const dispatched: string[] = [];
  const signals: AbortSignal[] = [];
  const control = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    commandTimeoutMs: 100,
    dispatch: async (command, signal) => {
      signals.push(signal);
      if (command.id === "peer") await new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) return { status: "rejected" };
      dispatched.push(command.id);
      return { status: "accepted" };
    },
  });
  try {
    const peer = control.send({ ...input("peer"), type: "input", advisory: true });
    await vi.advanceTimersByTimeAsync(5);
    // DurableWorklet starts this equal per-command deadline when send is called.
    const operator = Promise.race([
      control.send(input("operator")),
      new Promise<"outer-timeout">((resolve) => setTimeout(() => resolve("outer-timeout"), 100)),
    ]);
    await vi.advanceTimersByTimeAsync(150);
    expect((await peer).status).toBe("unknown");
    expect(await operator).toMatchObject({ status: "accepted" });
    expect(signals[0]?.aborted).toBe(true);
    expect(dispatched).toEqual(["operator"]);
  } finally {
    await control.close();
    vi.useRealTimers();
  }
});

it("rejects commands whose queue deadline passed without injecting them later", async () => {
  vi.useFakeTimers();
  const dispatched: string[] = [];
  const control = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    commandTimeoutMs: 100,
    dispatch: async (command) => {
      dispatched.push(command.id);
      if (command.id.startsWith("peer")) await new Promise(() => {});
      return { status: "accepted" };
    },
  });
  try {
    const peers = Array.from({ length: 8 }, (_, index) =>
      control.send({ ...input(`peer-${index}`), type: "input", advisory: true }),
    );
    const operator = control.send(input("expired"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await operator).toMatchObject({ status: "rejected" });
    expect(dispatched).not.toContain("expired");
    await Promise.all(peers);
    // Never-dispatched input does not make subsequent input uncertain or close control.
    expect((await control.send(input("fresh"))).status).toBe("accepted");
  } finally {
    await control.close();
    vi.useRealTimers();
  }
});

it("supports a deterministic question/reply/input/interrupt exchange and idempotent acknowledgements", async () => {
  const observed: HarnessControlCommand[] = [];
  const control = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    session: { harnessId: "custom", id: "native-session" },
    dispatch: async (command) => {
      observed.push(command);
      return { status: "accepted" };
    },
  });
  control.registerRequest("permission-one");
  const reply: HarnessControlCommand = {
    ...scope,
    id: "reply-one",
    type: "reply",
    requestId: "permission-one",
    response: { decision: "deny", reason: "outside admitted permissions" },
  };
  const [first, replayed] = await Promise.all([
    control.send(reply),
    control.send({
      ...reply,
      response: { reason: "outside admitted permissions", decision: "deny" },
    }),
  ]);
  expect(first).toEqual(replayed);
  expect(first.status).toBe("accepted");
  expect((await control.send(input())).status).toBe("accepted");
  expect(
    (await control.send({ ...scope, id: "stop", type: "interrupt", reason: "review needed" }))
      .status,
  ).toBe("accepted");
  expect(observed.map((command) => command.type)).toEqual(["reply", "input", "interrupt"]);
  expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  await expect(control.send({ ...input(), text: "changed" })).rejects.toThrow(/conflict/);
  await control.close();
  await expect(control.send(input("new"))).rejects.toThrow(/closed/);
  expect(await control.send(reply)).toEqual(first);
});

it("rejects unsupported operations, wrong Attempt identity and arbitrary or consumed request replies", async () => {
  const dispatch = vi.fn(async () => ({ status: "accepted" as const }));
  const control = new LocalHarnessExecutionControl({
    ...scope,
    capabilities: { version: 1, operations: ["reply"] },
    dispatch,
  });
  expect((await control.send(input())).status).toBe("rejected");
  await expect(control.send({ ...input("other"), attemptId: "another-attempt" })).rejects.toThrow(
    /scope/,
  );
  const reply: HarnessControlCommand = {
    ...scope,
    id: "reply",
    type: "reply",
    requestId: "missing",
    response: { allow: true },
  };
  expect((await control.send(reply)).status).toBe("rejected");
  control.registerRequest("missing");
  expect((await control.send({ ...reply, id: "registered" })).status).toBe("accepted");
  expect((await control.send({ ...reply, id: "duplicate-answer" })).status).toBe("rejected");
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it("freezes caller payloads and serializes distinct commands", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: string[] = [];
  const control = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    dispatch: async (command) => {
      observed.push(command.id);
      if (command.id === "one") await blocked;
      return { status: "accepted" };
    },
  });
  const value = { ...scope, id: "one", type: "input" as const, text: "original" };
  const first = control.send(value);
  value.text = "mutated";
  const second = control.send(input("two"));
  await vi.waitFor(() => expect(observed).toEqual(["one"]));
  release();
  await Promise.all([first, second]);
  expect(observed).toEqual(["one", "two"]);
  expect((await control.send({ ...value, text: "original" })).status).toBe("accepted");
});

it("keeps dispatch uncertainty idempotent and prevents subsequent native actions", async () => {
  const dispatch = vi.fn(async () => {
    throw new Error("secret-token must never escape");
  });
  const control = new LocalHarnessExecutionControl({ ...scope, capabilities, dispatch });
  const ack = await control.send(input());
  expect(ack.status).toBe("unknown");
  expect(JSON.stringify(ack)).not.toContain("secret-token");
  expect(await control.send(input())).toEqual(ack);
  await expect(control.send(input("new"))).rejects.toThrow(/closed/);
  expect(dispatch).toHaveBeenCalledOnce();
});

it("bounds unresponsive dispatch and marks close during dispatch unknown", async () => {
  const signals: AbortSignal[] = [];
  const control = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    commandTimeoutMs: 10,
    dispatch: async (_command, signal) => {
      signals.push(signal);
      await new Promise(() => {});
      return { status: "accepted" };
    },
  });
  expect((await control.send(input())).status).toBe("unknown");
  expect(signals[0]?.aborted).toBe(true);
  const another = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    dispatch: async (_command, signal) => {
      signals.push(signal);
      await new Promise(() => {});
      return { status: "accepted" };
    },
  });
  const pending = another.send(input());
  await vi.waitFor(() => expect(signals.length).toBe(2));
  await another.close();
  expect((await pending).status).toBe("unknown");
  expect(signals[1]?.aborted).toBe(true);
});

it("rejects malformed capabilities, non-JSON responses, and bounded history overflow", async () => {
  expect(() =>
    validateHarnessControlCapabilities({ version: 1, operations: ["input", "input"] }),
  ).toThrow();
  const control = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    maximumCommands: 1,
    dispatch: async () => ({ status: "accepted" }),
  });
  await expect(
    control.send({
      ...scope,
      id: "bad",
      type: "reply",
      requestId: "r",
      response: { value: BigInt(1) },
    } as unknown as HarnessControlCommand),
  ).rejects.toThrow(/JSON/);
  await control.send(input());
  await expect(control.send(input("two"))).rejects.toThrow(/history/);
  expect((await control.send(input())).status).toBe("accepted");
});

it("does not deliver a queued native action after control is revoked", async () => {
  const dispatch = vi.fn(async () => ({ status: "accepted" as const }));
  const control = new LocalHarnessExecutionControl({ ...scope, capabilities, dispatch });
  const pending = control.send(input());
  await Promise.resolve();
  await control.close();
  expect(["rejected", "unknown"]).toContain((await pending).status);
  expect(dispatch).not.toHaveBeenCalled();
});

it("permits a corrected reply after native rejection but not after request retraction", async () => {
  const dispatch = vi.fn(async (command: HarnessControlCommand) => ({
    status:
      command.type === "reply" && command.response["decision"] === "deny"
        ? ("accepted" as const)
        : ("rejected" as const),
  }));
  const control = new LocalHarnessExecutionControl({ ...scope, capabilities, dispatch });
  control.registerRequest("permission");
  const reply: HarnessControlCommand = {
    ...scope,
    id: "first",
    type: "reply",
    requestId: "permission",
    response: { decision: "allow" },
  };
  expect((await control.send(reply)).status).toBe("rejected");
  expect(
    (await control.send({ ...reply, id: "corrected", response: { decision: "deny" } })).status,
  ).toBe("accepted");
  control.registerRequest("retracted");
  control.unregisterRequest("retracted");
  expect((await control.send({ ...reply, id: "late", requestId: "retracted" })).status).toBe(
    "rejected",
  );
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it("validates explicit native input semantics without inferring a queue", () => {
  expect(() =>
    validateHarnessControlCapabilities({ ...capabilities, inputMode: "steer" }),
  ).not.toThrow();
  expect(() =>
    validateHarnessControlCapabilities({ ...capabilities, inputMode: "queue" }),
  ).not.toThrow();
  expect(() =>
    validateHarnessControlCapabilities({
      version: 1,
      operations: ["interrupt"],
      inputMode: "queue",
    }),
  ).toThrow();
  expect(() =>
    validateHarnessControlCapabilities({ ...capabilities, inputMode: "unknown" as "queue" }),
  ).toThrow();
});

it("requires take-time authority and preserves operator control after a refusal", async () => {
  const observed: string[] = [];
  const authorize = vi.fn(async () => false);
  const control = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    authorizeInputAtTake: true,
    dispatch: async (command, _signal, take) => {
      if (take && !(await take())) return { status: "rejected" };
      observed.push(command.id);
      return { status: "accepted" };
    },
  });
  const guarded = { ...input(), requiresInputAuthorization: true };
  expect((await control.send(guarded)).status).toBe("rejected");
  expect(
    (await control.send({ ...guarded, id: "revoked" }, { authorizeInput: authorize })).status,
  ).toBe("rejected");
  expect((await control.send(input("operator"))).status).toBe("accepted");
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(observed).toEqual(["operator"]);
  await control.close();
  const unsupported = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    dispatch: async () => {
      throw new Error("must not dispatch");
    },
  });
  expect((await unsupported.send(guarded, { authorizeInput: authorize })).status).toBe("rejected");
  await unsupported.close();
});

it("releases an input take waiting on authority when control is revoked", async () => {
  let authorize!: (allowed: boolean) => void;
  const authority = new Promise<boolean>((resolve) => {
    authorize = resolve;
  });
  let taking!: () => void;
  const started = new Promise<void>((resolve) => {
    taking = resolve;
  });
  const taken: boolean[] = [];
  const control = new LocalHarnessExecutionControl({
    ...scope,
    capabilities,
    authorizeInputAtTake: true,
    dispatch: async (_command, _signal, take) => {
      taking();
      taken.push(await (take?.() ?? false));
      return { status: "rejected" };
    },
  });
  const receipt = control.send(
    { ...input(), requiresInputAuthorization: true },
    { authorizeInput: () => authority },
  );
  await started;
  await control.close();
  await receipt;
  await vi.waitFor(() => expect(taken).toEqual([false]));
  authorize(true);
  expect(taken).toEqual([false]);
});

it.each(["timeout", "unknown", "throws", "invalid"] as const)(
  "isolates %s advisory uncertainty from queued operator and teammate commands",
  async (mode) => {
    const observed: string[] = [];
    let uncertainSignal: AbortSignal | undefined;
    const control = new LocalHarnessExecutionControl({
      ...scope,
      capabilities,
      commandTimeoutMs: 10,
      dispatch: async (command, signal) => {
        observed.push(command.id);
        if (command.id !== "peer") return { status: "accepted" };
        uncertainSignal = signal;
        if (mode === "timeout") await new Promise(() => {});
        if (mode === "throws") throw new Error("private provider detail");
        if (mode === "invalid") return { status: "invalid" as "unknown" };
        return { status: "unknown" };
      },
    });
    const peer = { ...input("peer"), type: "input" as const, advisory: true };
    const first = control.send(peer);
    const operator = control.send(input("operator"));
    const nextPeer = control.send({ ...peer, id: "next-peer" });
    expect((await first).status).toBe("unknown");
    expect((await operator).status).toBe("accepted");
    expect((await nextPeer).status).toBe("accepted");
    expect(uncertainSignal?.aborted).toBe(true);
    expect(await control.send(peer)).toEqual(await first);
    expect(observed).toEqual(["peer", "operator", "next-peer"]);
    await control.close();
    await expect(control.send(input("closed"))).rejects.toThrow(/closed/);
  },
);

it("validates and freezes peer origin independently of teammate text", async () => {
  const dispatch = vi.fn(async (_command: HarnessControlCommand) => ({
    status: "accepted" as const,
  }));
  const control = new LocalHarnessExecutionControl({ ...scope, capabilities, dispatch });
  const origin = { kind: "peer" as const, from: "stored-tag" };
  const peer = { ...input(), type: "input" as const, advisory: true, origin };
  const sent = control.send(peer);
  origin.from = "mutated";
  await sent;
  const dispatched = dispatch.mock.calls[0]?.[0] as HarnessControlCommand | undefined;
  expect(dispatched).toMatchObject({ origin: { kind: "peer", from: "stored-tag" } });
  expect(Object.isFrozen(dispatched?.type === "input" && dispatched.origin)).toBe(true);
  for (const invalid of [
    { kind: "human" },
    { kind: "peer", from: "" },
    { kind: "peer", from: "x".repeat(201) },
    { kind: "peer", from: "tag", name: "operator" },
  ]) {
    await expect(
      control.send({ ...peer, origin: invalid } as HarnessControlCommand),
    ).rejects.toThrow();
  }
  await expect(control.send({ ...peer, advisory: false })).rejects.toThrow(/origin/);
  await expect(control.send({ ...peer, origin: { kind: "peer", from: "other" } })).rejects.toThrow(
    /conflict/,
  );
  await control.send({ ...input("lookalike"), text: 'Team coordination {"from":"fake"}' });
  expect(dispatch.mock.calls[1]?.[0]).not.toHaveProperty("origin");
  await control.close();
});

it("bounds the take-time check by the teammate window and rejects input it never confirmed", async () => {
  vi.useFakeTimers();
  try {
    const taken: string[] = [];
    let checks = 0;
    const control = new LocalHarnessExecutionControl({
      ...scope,
      capabilities,
      authorizeInputAtTake: true,
      dispatch: async (command, signal, take) => {
        if (take && !(await take())) return { status: "rejected" };
        if (signal.aborted) return { status: "rejected" };
        taken.push(command.id);
        if (command.id === "slow-harness") await new Promise(() => {});
        return { status: "accepted" };
      },
    });
    const guarded = { ...input(), advisory: true, requiresInputAuthorization: true };
    // A check that never answers within the default one-second window: the input is never
    // taken, so the receipt is a definite rejection and the item stays for the digest.
    const stuck = control.send(
      { ...guarded, id: "stuck-check" },
      { authorizeInput: () => new Promise<boolean>(() => checks++) },
    );
    const operator = control.send(input("operator"));
    await vi.advanceTimersByTimeAsync(999);
    expect(taken).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stuck).toMatchObject({ status: "rejected", reason: /authority/ });
    expect(await operator).toMatchObject({ status: "accepted" });
    // A check that answers inside the window lets the input through.
    const quick = control.send(
      { ...guarded, id: "quick-check" },
      {
        authorizeInput: () =>
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 900)),
      },
    );
    await vi.advanceTimersByTimeAsync(900);
    expect(await quick).toMatchObject({ status: "accepted" });
    // Once the check passed, a harness that then stalls leaves the receipt uncertain.
    const slow = control.send(
      { ...guarded, id: "slow-harness" },
      { authorizeInput: async () => true },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await slow).toMatchObject({ status: "unknown" });
    expect(checks).toBe(1);
    expect(taken).toEqual(["operator", "quick-check", "slow-harness"]);
    await control.close();
  } finally {
    vi.useRealTimers();
  }
});
