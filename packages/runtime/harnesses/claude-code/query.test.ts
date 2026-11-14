import { EventEmitter } from "node:events";
import type { query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeProcessTree } from "./src/process-tree.js";
import { ClaudeLiveInput, claudeQuery, isClaudeFinalResult } from "./src/query.js";

// These integration cases require a readable host process inventory. A pre-launch cleanup
// error otherwise satisfies their generic cleanup-failure branch without launching Claude Code.
const processTreeAvailable =
  process.platform !== "win32" &&
  (await ClaudeProcessTree.prepare().then(
    (tree) => {
      tree.close();
      return true;
    },
    () => false,
  ));

it.each(["rejected", "stalled"])(
  "hard-aborts a %s interrupt without waiting indefinitely",
  async (mode) => {
    const controller = new AbortController();
    let processSignal: AbortSignal | undefined;
    const run = (({ options }) =>
      Object.assign(
        (async function* () {
          processSignal = options.abortController.signal;
          controller.abort(new Error("stop"));
          await new Promise<void>((resolve) =>
            processSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          throw processSignal?.reason;
        })(),
        {
          interrupt: () =>
            mode === "rejected" ? Promise.reject(new Error("unsupported")) : new Promise(() => {}),
        },
      )) as typeof query;
    await expect(
      (async () => {
        for await (const _ of claudeQuery(run, "test", {}, controller.signal, { drainMs: 20 })) {
        }
      })(),
    ).rejects.toThrow("stop");
    expect(processSignal?.aborted).toBe(true);
  },
);
it("stops waiting for a stream that stays open after the process is aborted", async () => {
  const controller = new AbortController();
  let processSignal: AbortSignal | undefined;
  let released = false;
  // A process with running background subagents keeps its stream open after termination.
  const run = (({ options }) => {
    processSignal = options.abortController.signal;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        controller.abort(new Error("durable wait"));
        return new Promise(() => {});
      },
      return: async () => {
        released = true;
        return { done: true, value: undefined };
      },
      interrupt: () => new Promise(() => {}),
    };
  }) as unknown as typeof query;
  const started = Date.now();
  await expect(
    (async () => {
      for await (const _ of claudeQuery(run, "test", {}, controller.signal, {
        drainMs: 20,
        exitMs: 20,
      })) {
      }
    })(),
  ).rejects.toThrow("durable wait");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(processSignal?.aborted).toBe(true);
  expect(released).toBe(true);
});
it("does not start an already cancelled query", async () => {
  const run = vi.fn() as unknown as typeof query;
  await expect(
    (async () => {
      for await (const _ of claudeQuery(run, "test", {}, AbortSignal.abort(new Error("stop")))) {
      }
    })(),
  ).rejects.toThrow("stop");
  expect(run).not.toHaveBeenCalled();
});
it("closes the process when a consumer stops reading", async () => {
  let signal: AbortSignal | undefined;
  const run = (({ options }) =>
    (async function* () {
      signal = options.abortController.signal;
      yield { type: "system", subtype: "init" } as SDKMessage;
    })()) as typeof query;
  for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal)) break;
  expect(signal?.aborted).toBe(true);
});

it("continues normal completion through trailing persistence diagnostics", async () => {
  const run = (() =>
    (async function* () {
      yield { type: "result", subtype: "success" } as SDKMessage;
      yield { type: "system", subtype: "mirror_error" } as SDKMessage;
    })()) as typeof query;
  const messages = [];
  for await (const message of claudeQuery(run, "test", {}, new AbortController().signal))
    messages.push(message);
  expect(messages).toHaveLength(2);
});

it("keeps input open until a turn ends with no background tasks running", async () => {
  const events: string[] = [];
  const run = (({ prompt }) =>
    (async function* () {
      const input = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await input.next();
      let closed = false;
      void input.next().then(() => {
        closed = true;
      });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
      const background = (ids: string[]) =>
        ({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: ids.map((id) => ({ task_id: id, task_type: "local_agent", description: id })),
        }) as unknown as SDKMessage;
      yield background(["fix-1"]);
      yield { type: "result", subtype: "success", result: "started" } as SDKMessage;
      await settle();
      events.push(`after first turn: ${closed ? "closed" : "open"}`);
      yield { type: "assistant", message: { content: [] } } as unknown as SDKMessage;
      yield background([]);
      await settle();
      events.push(`during follow-up turn: ${closed ? "closed" : "open"}`);
      yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
      await settle();
      events.push(`after final turn: ${closed ? "closed" : "open"}`);
    })()) as typeof query;
  for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal)) {
  }
  expect(events).toEqual([
    "after first turn: open",
    "during follow-up turn: open",
    "after final turn: closed",
  ]);
});

it("closes input when the last background task finishes after the final turn", async () => {
  let closed = false;
  const run = (({ prompt }) =>
    (async function* () {
      const input = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await input.next();
      void input.next().then(() => {
        closed = true;
      });
      yield {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "watch", task_type: "local_bash", description: "watch" }],
      } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
      yield {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
      } as unknown as SDKMessage;
      await new Promise((resolve) => setTimeout(resolve, 5));
    })()) as typeof query;
  for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal)) {
  }
  expect(closed).toBe(true);
});

const backgroundTasks = (descriptions: string[]) =>
  ({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: descriptions.map((description, index) => ({
      task_id: `task-${index}`,
      task_type: "local_agent",
      description,
    })),
  }) as unknown as SDKMessage;
const turnEnded = { type: "result", subtype: "success", result: "waiting" } as SDKMessage;
const working = { type: "assistant", message: { content: [] } } as unknown as SDKMessage;
const checkInText = (next: IteratorResult<unknown>) =>
  (next.value as { message: { content: string } }).message.content;

it("sends a check-in naming the running background tasks once they have held the session idle", async () => {
  let checkIn = "";
  let waitedMs = 0;
  const run = (({ prompt }) =>
    (async function* () {
      const input = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await input.next();
      yield backgroundTasks(["Fix the flaky test"]);
      yield turnEnded;
      const started = Date.now();
      checkIn = checkInText(await input.next());
      waitedMs = Date.now() - started;
      yield working;
      yield backgroundTasks([]);
      yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
    })()) as typeof query;
  for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
    drainMs: 20,
    exitMs: 20,
    checkInMs: 30,
  })) {
  }
  expect(waitedMs).toBeGreaterThanOrEqual(25);
  expect(checkIn).toContain("- Fix the flaky test");
  expect(checkIn).toContain("Keep waiting for any that are making progress");
  expect(checkIn).toContain("Work that must outlive this Attempt belongs in SuperTag Tasks.");
});

it("cancels a pending check-in when the model starts working", async () => {
  let received: unknown;
  const run = (({ prompt }) =>
    (async function* () {
      const input = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await input.next();
      yield backgroundTasks(["Run the migration"]);
      yield turnEnded;
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield working;
      void input.next().then((next) => {
        received = next;
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      yield backgroundTasks([]);
      yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
      await new Promise((resolve) => setTimeout(resolve, 5));
    })()) as typeof query;
  for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
    drainMs: 20,
    exitMs: 20,
    checkInMs: 40,
  })) {
  }
  // The only thing input produced after the prompt is its close, not a check-in.
  expect(received).toEqual({ done: true, value: undefined });
});

it("closes input after three check-ins when background work still holds the session", async () => {
  const checkIns: string[] = [];
  let closed = false;
  const run = (({ prompt }) =>
    (async function* () {
      const input = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await input.next();
      yield backgroundTasks(["Watch the deploy"]);
      yield turnEnded;
      for (let index = 0; index < 3; index++) {
        checkIns.push(checkInText(await input.next()));
        yield working;
        yield turnEnded;
      }
      closed = (await input.next()).done === true;
    })()) as typeof query;
  for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
    drainMs: 20,
    exitMs: 20,
    checkInMs: 10,
  })) {
  }
  expect(checkIns).toHaveLength(3);
  expect(closed).toBe(true);
});

describe("live input", () => {
  type Input = AsyncIterator<{
    message: { content: string };
    priority?: string;
    client_composed?: true;
    uuid?: string;
  }>;
  const promptOf = (prompt: unknown) =>
    (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]() as Input;
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const background = (tasks: unknown[]) =>
    ({ type: "system", subtype: "background_tasks_changed", tasks }) as SDKMessage;
  // Claude Code stamps a turn's replies with the client uuids of the input they answer.
  const replyTo = (uuid: string | undefined) =>
    ({
      type: "assistant",
      message: { content: [] },
      ...(uuid === undefined ? {} : { user_message_uuid: uuid, user_message_uuids: [uuid] }),
    }) as unknown as SDKMessage;

  it("joins the open prompt stream as written and is accepted once the SDK takes it", async () => {
    const live = new ClaudeLiveInput();
    let delivered: Awaited<ReturnType<Input["next"]>> | undefined;
    let status: Promise<string> | undefined;
    let closedAfterFollowUp = false;
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        yield working;
        status = live.send("Team coordination: use the new schema");
        delivered = await input.next();
        // Like the SDK, ask for the next message once this one is written.
        const closing = input.next();
        // The model reads the input at its next boundary between tool calls.
        yield replyTo(delivered?.value?.uuid);
        yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
        closedAfterFollowUp = (await closing).done === true;
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
    }
    expect(delivered?.value).toMatchObject({
      type: "user",
      message: { role: "user", content: "Team coordination: use the new schema" },
      priority: "next",
      client_composed: true,
    });
    expect(await status).toBe("accepted");
    expect(closedAfterFollowUp).toBe(true);
    // The finished query released the stream.
    expect(await live.send("late")).toBe("rejected");
  });

  it("refuses guarded input when a custom query cannot check at take", async () => {
    const live = new ClaudeLiveInput();
    const push = vi.fn(async () => "accepted" as const);
    const unbind = live.bind(push);
    expect(await live.send("peer", undefined, { authorizeInput: async () => true })).toBe(
      "rejected",
    );
    expect(push).not.toHaveBeenCalled();
    expect(await live.send("operator")).toBe("accepted");
    unbind();
  });

  it("checks membership when the SDK takes input, after the prompt queue", async () => {
    const live = new ClaudeLiveInput();
    let member = true;
    const authorize = vi.fn(async () => member);
    let receipt: Promise<string> | undefined;
    let received: unknown;
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        yield working;
        receipt = live.send("revoked teammate text", undefined, { authorizeInput: authorize });
        expect(authorize).not.toHaveBeenCalled();
        member = false;
        // This allowed input proves that the queue continues after withdrawing the first.
        void live.send("later operator input");
        received = (await input.next()).value;
        yield turnEnded;
        void input.next();
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
    }
    expect(await receipt).toBe("rejected");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(received).toMatchObject({ message: { content: "later operator input" } });
  });

  it("keeps labelled peer input on the ordinary CLI path with reply UUIDs", async () => {
    const live = new ClaudeLiveInput();
    const received: unknown[] = [];
    const run = (({ prompt }) =>
      (async function* () {
        const stream = promptOf(prompt);
        received.push((await stream.next()).value);
        yield working;
        void live.send("peer text", undefined, { origin: { kind: "peer", from: "lead-tag" } });
        received.push((await stream.next()).value);
        void live.send("operator text");
        received.push((await stream.next()).value);
        yield turnEnded;
        await stream.return?.();
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
    }
    expect(received[0]).not.toHaveProperty("origin");
    expect(received[1]).not.toHaveProperty("origin");
    expect(received[1]).toMatchObject({
      message: { role: "user", content: "peer text" },
      priority: "next",
      client_composed: true,
      uuid: expect.any(String),
    });
    expect(received[2]).not.toHaveProperty("origin");
  });

  it("rejects input without an open stream and after input closes", async () => {
    const live = new ClaudeLiveInput();
    expect(await live.send("before")).toBe("rejected");
    let afterClose: string | undefined;
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
        await input.next();
        afterClose = await live.send("after close");
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
    }
    expect(afterClose).toBe("rejected");
  });

  it("reports acceptance as unknown when the stream ends after taking the input", async () => {
    const live = new ClaudeLiveInput();
    let status: Promise<string> | undefined;
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        status = live.send("decision");
        await input.next();
        // The SDK stops reading before asking for the next message.
        await input.return?.();
        yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
    }
    expect(await status).toBe("unknown");
  });

  it("rejects input still queued when the Attempt is cancelled", async () => {
    const live = new ClaudeLiveInput();
    const controller = new AbortController();
    let status: Promise<string> | undefined;
    const run = (({ prompt }) =>
      Object.assign(
        (async function* () {
          promptOf(prompt).next();
          // The SDK never asks for the queued message before the Attempt is cancelled.
          await new Promise((resolve) => setTimeout(resolve, 5));
          status = live.send("decision");
          controller.abort(new Error("stop"));
          yield { type: "result", subtype: "success", result: "stopped" } as SDKMessage;
        })(),
        { interrupt: async () => {} },
      )) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, controller.signal, {
      input: live,
    })) {
    }
    expect(await status).toBe("rejected");
  });

  it("rejects input not yet taken when the final result arrives", async () => {
    const live = new ClaudeLiveInput();
    let status: Promise<string> | undefined;
    let closed = false;
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        yield working;
        // The SDK is not reading input while the final turn writes its result.
        status = live.send("decision");
        yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
        closed = (await input.next()).done === true;
      })()) as typeof query;
    const results: SDKMessage[] = [];
    for await (const message of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    }))
      if (message.type === "result") results.push(message);
    expect(await status).toBe("rejected");
    expect(closed).toBe(true);
    expect(results.map(isClaudeFinalResult)).toEqual([true]);
  });

  it("ends the session at the final result while taken input is unanswered", async () => {
    const live = new ClaudeLiveInput();
    let status: Promise<string> | undefined;
    let processSignal: AbortSignal | undefined;
    let stoppedBeforeYield = false;
    let replyTurnRan = false;
    const run = (({ prompt, options }) =>
      (async function* () {
        processSignal = options?.abortController?.signal;
        const input = promptOf(prompt);
        await input.next();
        yield working;
        status = live.send("decision");
        await input.next();
        void input.next();
        // The final turn's last assistant message was produced before Claude Code read the input.
        yield working;
        yield turnEnded;
        // Claude Code would now answer the queued input in a new turn.
        replyTurnRan = true;
        yield replyTo(undefined);
        yield { type: "result", subtype: "error_max_turns", errors: [] } as unknown as SDKMessage;
      })()) as typeof query;
    const seen: SDKMessage[] = [];
    for await (const message of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
      if (message.type === "result") stoppedBeforeYield = processSignal?.aborted === true;
      seen.push(message);
    }
    expect(await status).toBe("accepted");
    expect(stoppedBeforeYield).toBe(true);
    expect(replyTurnRan).toBe(false);
    expect(seen.at(-1)).toBe(turnEnded);
    expect(isClaudeFinalResult(turnEnded)).toBe(true);
    expect(await live.send("late")).toBe("rejected");
  });

  it("does not treat a result while background work runs as final", async () => {
    const results: SDKMessage[] = [];
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        yield background([{ task_id: "x", task_type: "local_bash", description: "x" }]);
        yield { type: "result", subtype: "success", result: "waiting" } as SDKMessage;
        yield background([]);
        yield working;
        yield { type: "result", subtype: "success", result: "done" } as SDKMessage;
      })()) as typeof query;
    for await (const message of claudeQuery(run, "test", {}, new AbortController().signal))
      if (message.type === "result") results.push(message);
    expect(results.map(isClaudeFinalResult)).toEqual([false, true]);
  });

  it("closes input when the last background task ends, with taken input unanswered", async () => {
    const live = new ClaudeLiveInput();
    let closedWithinBound = false;
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        yield background([{ task_id: "x", task_type: "local_bash", description: "x" }]);
        void live.send("decision");
        await input.next();
        let closed = false;
        void input.next().then((next) => {
          closed = next.done === true;
        });
        // The turn ends with background work running, which then finishes without a new turn.
        yield turnEnded;
        yield background([]);
        await delay(50);
        closedWithinBound = closed;
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
      checkInMs: 1_000,
    })) {
    }
    expect(closedWithinBound).toBe(true);
  });

  it("confirms input only once the Claude Code process has produced output", async () => {
    const live = new ClaudeLiveInput();
    let status: Promise<string> | undefined;
    let beforeStart: string | undefined;
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        // A resumed query buffers writes until it spawns Claude Code; the SDK still reads on.
        status = live.send("decision");
        const handed = await input.next();
        void input.next();
        beforeStart = await Promise.race([status, delay(10).then(() => "pending")]);
        yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
        yield replyTo(handed.value?.uuid);
        yield turnEnded;
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
    }
    expect(beforeStart).toBe("pending");
    expect(await status).toBe("accepted");
  });

  it("reports input taken before Claude Code started as unknown when the query ends", async () => {
    const live = new ClaudeLiveInput();
    let status: Promise<string> | undefined;
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        status = live.send("decision");
        await input.next();
        void input.next();
        await delay(5);
        // Spawning failed: the buffered write never reached a process.
        yield* [];
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
    }
    expect(await status).toBe("unknown");
  });

  it("rejects input whose take-time check is still running at the final result", async () => {
    const live = new ClaudeLiveInput();
    let allow!: (allowed: boolean) => void;
    const authority = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    let status: Promise<string> | undefined;
    let next: Promise<IteratorResult<SDKUserMessage>> | undefined;
    const results: SDKMessage[] = [];
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        yield working;
        status = live.send("teammate text", undefined, { authorizeInput: () => authority });
        // The SDK requests the input; its membership check has not answered yet.
        next = input.next();
        yield turnEnded;
      })()) as typeof query;
    for await (const message of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    }))
      if (message.type === "result") results.push(message);
    // The check allows the input only after the final result closed input.
    allow(true);
    expect(await status).toBe("rejected");
    expect(await next).toMatchObject({ done: true });
    expect(results).toHaveLength(1);
    expect(isClaudeFinalResult(results[0] as SDKMessage)).toBe(true);
  });

  it("withdraws accepted input that no reply names once the final result stops Claude Code", async () => {
    const live = new ClaudeLiveInput();
    let processSignal: AbortSignal | undefined;
    let status: Promise<string> | undefined;
    const withdrawn: { stopped: boolean | undefined; yielded: boolean }[] = [];
    let resultYielded = false;
    const run = (({ prompt, options }) =>
      (async function* () {
        processSignal = options?.abortController?.signal;
        const input = promptOf(prompt);
        await input.next();
        yield working;
        status = live.send("decision", undefined, {
          onWithdrawn: () =>
            withdrawn.push({ stopped: processSignal?.aborted, yielded: resultYielded }),
        });
        await input.next();
        void input.next();
        yield working;
        yield turnEnded;
      })()) as typeof query;
    for await (const message of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    }))
      if (message.type === "result") resultYielded = true;
    expect(await status).toBe("accepted");
    // Reported once, after Claude Code was stopped and before the final result is passed on.
    expect(withdrawn).toEqual([{ stopped: true, yielded: false }]);
  });

  it("does not withdraw input that a reply named before the final result", async () => {
    const live = new ClaudeLiveInput();
    const withdrawn: string[] = [];
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        yield working;
        void live.send("decision", undefined, { onWithdrawn: () => withdrawn.push("decision") });
        const handed = await input.next();
        void input.next();
        yield replyTo(handed.value?.uuid);
        yield turnEnded;
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
    }
    expect(withdrawn).toEqual([]);
  });

  it("reports unconfirmed input still being written at the final result as unknown", async () => {
    const live = new ClaudeLiveInput();
    const withdrawn = vi.fn();
    let status: Promise<string> | undefined;
    const run = (({ prompt }) =>
      (async function* () {
        const input = promptOf(prompt);
        await input.next();
        yield working;
        status = live.send("decision", undefined, { onWithdrawn: withdrawn });
        // Taken, but the SDK has not yet asked for the next message, which confirms the write.
        await input.next();
        yield turnEnded;
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "test", {}, new AbortController().signal, {
      input: live,
    })) {
    }
    // The model never reads it: it waits for the next activation's digest.
    expect(await status).toBe("unknown");
    expect(withdrawn).not.toHaveBeenCalled();
  });

  it("stops Claude Code at the final result while a check-in it took is unread", async () => {
    let processSignal: AbortSignal | undefined;
    let stoppedBeforeYield = false;
    let checkInTurnRan = false;
    const run = (({ prompt, options }) =>
      (async function* () {
        processSignal = options?.abortController?.signal;
        const input = promptOf(prompt);
        await input.next();
        yield background([{ task_id: "x", task_type: "local_bash", description: "Watch" }]);
        yield turnEnded;
        // The check-in is taken, then the background task finishes and a turn reports it.
        await input.next();
        void input.next();
        yield background([]);
        yield working;
        yield turnEnded;
        // Claude Code would now run the check-in in a new turn with tools.
        checkInTurnRan = true;
        yield working;
        yield { type: "result", subtype: "success", result: "checked" } as SDKMessage;
      })()) as typeof query;
    for await (const message of claudeQuery(run, "test", {}, new AbortController().signal, {
      checkInMs: 10,
    }))
      if (message.type === "result" && isClaudeFinalResult(message))
        stoppedBeforeYield = processSignal?.aborted === true;
    expect(stoppedBeforeYield).toBe(true);
    expect(checkInTurnRan).toBe(false);
  });

  it("stops Claude Code before passing on the final result and ends the stream after it exits", async () => {
    const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const { EventEmitter } = await import("node:events");
    const { PassThrough, Writable } = await import("node:stream");
    const output = new PassThrough();
    const live = new ClaudeLiveInput();
    const signals: string[] = [];
    let exited = false;
    let users = 0;
    const child = Object.assign(new EventEmitter(), {
      stdout: output,
      exitCode: null as number | null,
      signalCode: null as string | null,
      get killed() {
        return signals.length > 0;
      },
      kill(signal: string) {
        signals.push(signal);
        // A cancellation arrives while the stream waits for the exit.
        cancellation.abort();
        // Exit comes later, as from a real process.
        setTimeout(() => {
          child.signalCode = signal;
          exited = true;
          child.emit("exit", null, signal);
          output.end();
        }, 20);
        return true;
      },
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          for (const line of chunk.toString().trim().split("\n")) {
            const message = JSON.parse(line);
            if (message.type === "control_request")
              output.write(
                `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } })}\n`,
              );
            if (message.type !== "user") continue;
            users++;
            if (users === 1) {
              output.write(
                `${JSON.stringify({ type: "system", subtype: "init", session_id: "sdk" })}\n`,
              );
              setTimeout(() => void live.send("teammate note"), 10);
            } else
              setTimeout(
                () =>
                  output.write(
                    `${JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "sdk" })}\n`,
                  ),
                10,
              );
          }
          callback();
        },
      }),
    });
    const cancellation = new AbortController();
    const atResult: { signals: string[]; exited: boolean; final: boolean }[] = [];
    try {
      for await (const message of claudeQuery(
        sdkQuery,
        "main",
        { spawnClaudeCodeProcess: () => child as never },
        cancellation.signal,
        { input: live },
      ))
        if (message.type === "result")
          atResult.push({ signals: [...signals], exited, final: isClaudeFinalResult(message) });
      // The stream ends only once the process has exited.
      expect(exited).toBe(true);
    } finally {
      if (!exited) child.kill("SIGKILL");
    }
    // Claude Code is stopped before the result passes on, so it cannot answer the taken input,
    // but the result is not held for the exit, where a cancellation would reach the Worker first.
    expect(atResult).toEqual([{ signals: ["SIGKILL"], exited: false, final: true }]);
  });

  it("binds one query at a time", () => {
    const live = new ClaudeLiveInput();
    live.bind(async () => "accepted");
    expect(() => live.bind(async () => "accepted")).toThrow("already bound");
  });
});

describe("after the final result", () => {
  const promptOf = (prompt: unknown) => (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const finalResult = { type: "result", subtype: "success", result: "done" } as SDKMessage;
  const deny = { hookSpecificOutput: { permissionDecision: "deny" } };
  it.each([
    {
      name: "same-chunk post-result hook, fast consumer",
      blocked: false,
      fragmented: false,
      work: "none",
    },
    {
      name: "same-chunk post-result hook, blocked consumer",
      blocked: true,
      fragmented: false,
      work: "none",
    },
    {
      name: "fragmented post-result hook, blocked consumer",
      blocked: true,
      fragmented: true,
      work: "none",
    },
    {
      name: "non-final result with active background work",
      blocked: true,
      fragmented: false,
      work: "active",
    },
    {
      name: "final result with only ambient background work",
      blocked: true,
      fragmented: false,
      work: "ambient",
    },
    {
      name: "final result after background work completes",
      blocked: true,
      fragmented: true,
      work: "completed",
    },
  ])("guards the real SDK: $name", async ({ blocked, fragmented, work }) => {
    const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const { PassThrough, Writable } = await import("node:stream");
    const output = new PassThrough();
    const response = Promise.withResolvers<unknown>();
    let callbackId: string;
    const child = Object.assign(new EventEmitter(), {
      stdout: output,
      exitCode: null as number | null,
      signalCode: null as string | null,
      killed: false,
      kill(signal: string) {
        child.killed = true;
        child.signalCode = signal;
        child.emit("exit", null, signal);
        output.end();
        return true;
      },
      stdin: new Writable({
        write(chunk, _encoding, done) {
          for (const line of chunk.toString().trim().split("\n")) {
            const message = JSON.parse(line);
            if (message.type === "control_request") {
              if (message.request.subtype === "initialize")
                callbackId = message.request.hooks.PreToolUse.at(-1).hookCallbackIds[0];
              output.write(
                `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } })}\n`,
              );
            } else if (message.type === "user") {
              const background = (active: boolean) => ({
                type: "system",
                subtype: "background_tasks_changed",
                tasks: active
                  ? [
                      {
                        task_id: "background",
                        description: "Watch café",
                        ambient: work === "ambient",
                      },
                    ]
                  : [],
              });
              const wire = Buffer.from(
                [
                  { type: "system", subtype: "init", session_id: "sdk" },
                  ...(work === "none" ? [] : [background(true)]),
                  ...(work === "completed" ? [background(false)] : []),
                  { ...finalResult, session_id: "sdk" },
                  {
                    type: "control_request",
                    request_id: "post-final",
                    request: {
                      subtype: "hook_callback",
                      callback_id: callbackId,
                      input: hookInput("Write")[0],
                      tool_use_id: "tool-1",
                    },
                  },
                ]
                  .map((entry) => `${JSON.stringify(entry)}\n`)
                  .join(""),
              );
              // One chunk reproduces the race. Bytewise writes also split JSON and UTF-8.
              if (fragmented) {
                let offset = 0;
                const writeByte = () => {
                  if (offset < wire.length) {
                    output.write(wire.subarray(offset, ++offset));
                    setImmediate(writeByte);
                  }
                };
                writeByte();
              } else output.write(wire);
            } else if (message.type === "control_response") {
              response.resolve(message.response.response);
              setImmediate(() => {
                child.exitCode = 0;
                child.emit("exit", 0, null);
                output.end();
              });
            }
          }
          done();
        },
      }),
    });
    const results: SDKMessage[] = [];
    try {
      for await (const message of claudeQuery(
        sdkQuery,
        "main",
        { spawnClaudeCodeProcess: () => child as never },
        new AbortController().signal,
        { exitMs: 100 },
      )) {
        if (blocked && message.type === "system" && message.subtype === "init")
          await response.promise;
        if (message.type === "result") results.push(message);
      }
      if (work === "active") expect(await response.promise).toEqual({});
      else expect(await response.promise).toMatchObject(deny);
      expect(results).toMatchObject([finalResult]);
      expect(results.map(isClaudeFinalResult)).toEqual([work !== "active"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
  const hookInput = (tool: string) =>
    [
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: {},
        tool_use_id: "tool-1",
        session_id: "s",
        transcript_path: "",
        cwd: "/",
      },
      "tool-1",
      { signal: new AbortController().signal },
    ] as const;
  // A Claude Code process whose exit follows a kill, as from a real process.
  const fakeProcess = () => {
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      killed: false,
      kill(signal: string) {
        signals.push(signal);
        setTimeout(() => {
          child.signalCode = signal;
          child.emit("exit", null, signal);
        }, 5);
        return true;
      },
    });
    return { child, signals };
  };

  it("denies every tool, root or subagent, through PreToolUse once the final result exists", async () => {
    type Hooks = NonNullable<NonNullable<Parameters<typeof query>[0]["options"]>["hooks"]>;
    let hooks: Hooks["PreToolUse"];
    const before: unknown[] = [];
    const after: unknown[] = [];
    const call = async (into: unknown[]) => {
      for (const matcher of hooks ?? [])
        for (const hook of matcher.hooks) into.push(await hook(...hookInput("Write")));
    };
    const run = (({ prompt, options }) =>
      (async function* () {
        hooks = options?.hooks?.PreToolUse;
        await promptOf(prompt).next();
        yield working;
        await call(before);
        yield finalResult;
        await call(after);
      })()) as typeof query;
    const own = vi.fn(async () => ({}));
    for await (const _ of claudeQuery(
      run,
      "test",
      { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [own] }] } },
      new AbortController().signal,
    )) {
    }
    expect(before).toEqual([{}, {}]);
    expect(after).toMatchObject([deny, deny]);
    expect(own).toHaveBeenCalledTimes(1);
    // The guard that matches every tool has no tool pattern.
    expect(hooks?.at(-1)?.matcher).toBeUndefined();
  });

  it("denies a hook that started before the final result but resolves after it", async () => {
    const decision = Promise.withResolvers<Record<string, never>>();
    let response: Promise<unknown> | undefined;
    const run = (({ options }) =>
      (async function* () {
        response = options.hooks?.PreToolUse?.[0]?.hooks[0]?.(...hookInput("Write"));
        yield finalResult;
        decision.resolve({});
        expect(await response).toMatchObject(deny);
      })()) as typeof query;
    for await (const _ of claudeQuery(
      run,
      "main",
      { hooks: { PreToolUse: [{ hooks: [() => decision.promise] }] } },
      new AbortController().signal,
    )) {
    }
    expect(response).toBeDefined();
  });

  it("kills Claude Code at post-final hook activity and passes on only a mirror failure", async () => {
    const { child, signals } = fakeProcess();
    let continued = false;
    const mirrorError = { type: "system", subtype: "mirror_error" } as unknown as SDKMessage;
    const run = (({ prompt, options }) =>
      (async function* () {
        options?.spawnClaudeCodeProcess?.({} as never);
        await promptOf(prompt).next();
        yield working;
        yield finalResult;
        yield { type: "system", subtype: "session_state_changed", state: "idle" } as SDKMessage;
        yield mirrorError;
        // A Stop or SessionEnd hook starts after the result.
        yield { type: "system", subtype: "hook_started", hook_name: "Stop" } as SDKMessage;
        continued = true;
        yield { type: "system", subtype: "task_progress" } as unknown as SDKMessage;
      })()) as typeof query;
    const seen: SDKMessage[] = [];
    for await (const message of claudeQuery(
      run,
      "test",
      { spawnClaudeCodeProcess: () => child as never },
      new AbortController().signal,
      { exitMs: 1_000 },
    ))
      seen.push(message);
    expect(seen).toEqual([working, finalResult, mirrorError]);
    expect(continued).toBe(false);
    expect(signals).toEqual(["SIGKILL"]);
  });

  it("does not consume a final response claim for an empty resumed turn", async () => {
    const claimFinalResponse = vi.fn(() => true);
    const run = (() =>
      (async function* () {
        yield { type: "result", subtype: "success", result: "" } as SDKMessage;
      })()) as typeof query;
    for await (const _ of claudeQuery(run, "main", {}, new AbortController().signal, {
      claimFinalResponse,
    })) {
    }
    expect(claimFinalResponse).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "claims at stdout receipt before SDK delivery (allowed: %s)",
    async (allowed) => {
      const { Readable } = await import("node:stream");
      const { child } = fakeProcess();
      const controller = new AbortController();
      const result = { type: "result", subtype: "success", result: "claimed" } as SDKMessage;
      const claimFinalResponse = vi.fn(() => allowed && !controller.signal.aborted);
      const spawned = Object.assign(child, {
        stdout: Readable.from([`${JSON.stringify(result)}\n`]),
      });
      const run = (({ options }) =>
        Object.assign(
          (async function* () {
            const process = options.spawnClaudeCodeProcess?.({} as never);
            if (!process) throw new Error("Expected spawned process");
            for await (const _ of process.stdout) {
              // The SDK has consumed stdout but has not yielded the result to the harness.
              expect(claimFinalResponse).toHaveBeenCalledOnce();
              controller.abort(new Error("cancel before SDK delivery"));
            }
            yield result;
          })(),
          { interrupt: async () => {} },
        )) as typeof query;
      const seen: SDKMessage[] = [];
      for await (const message of claudeQuery(
        run,
        "main",
        {
          spawnClaudeCodeProcess: () => spawned as never,
        },
        controller.signal,
        { exitMs: 10, claimFinalResponse },
      ))
        seen.push(message);
      expect(seen).toEqual([result]);
      expect(claimFinalResponse).toHaveBeenCalledOnce();
      expect(isClaudeFinalResult(result)).toBe(allowed);
    },
  );

  it.each(["before", "after"])(
    "records whether cancellation arrived %s result receipt",
    async (when) => {
      const { child } = fakeProcess();
      const controller = new AbortController();
      const result = { type: "result", subtype: "success", result: "done" } as SDKMessage;
      const run = (({ options }) =>
        Object.assign(
          (async function* () {
            options.spawnClaudeCodeProcess?.({} as never);
            if (when === "before") controller.abort(new Error("cancel"));
            yield result;
            if (when === "after") controller.abort(new Error("cancel"));
          })(),
          { interrupt: async () => {} },
        )) as typeof query;
      const seen: SDKMessage[] = [];
      for await (const message of claudeQuery(
        run,
        "main",
        { spawnClaudeCodeProcess: () => child as never },
        controller.signal,
        { exitMs: 10 },
      ))
        seen.push(message);
      // The stream ends only after the process is stopped.
      expect(child.signalCode).toBe("SIGKILL");
      expect(seen).toEqual([result]);
      expect(isClaudeFinalResult(result)).toBe(when === "after");
    },
  );

  it.each([
    ["never exits", "ends"],
    ["kill denied", "ends"],
    ["never exits", "stalls"],
    ["kill denied", "stalls"],
  ])(
    "fails the stream after the result when cleanup fails (%s) and the stream %s",
    async (mode, stream) => {
      const { child, signals } = fakeProcess();
      child.kill = (signal: string) => {
        signals.push(signal);
        if (mode === "kill denied") throw Object.assign(new Error("denied"), { code: "EPERM" });
        return true;
      };
      const run = (({ options }) =>
        (async function* () {
          options.spawnClaudeCodeProcess?.({} as never);
          yield finalResult;
          // Neither EOF nor a stuck SDK stream proves the process exited.
          if (stream === "stalls") await new Promise(() => {});
        })()) as typeof query;
      const seen: SDKMessage[] = [];
      await expect(
        (async () => {
          for await (const message of claudeQuery(
            run,
            "main",
            { spawnClaudeCodeProcess: () => child as never },
            new AbortController().signal,
            { exitMs: 10 },
          ))
            seen.push(message);
        })(),
      ).rejects.toMatchObject({ name: "ExecutionCleanupError", hostUnsafe: true });
      // The result arrives first, but the stream fails instead of ending, so no Attempt completes.
      expect(seen).toEqual([finalResult]);
      expect(signals).toEqual(["SIGKILL"]);
    },
  );

  it("refuses an uninspectable local launch and releases live input", async () => {
    const prepare = vi.spyOn(ClaudeProcessTree, "prepare").mockRejectedValue(new Error("EPERM"));
    const live = new ClaudeLiveInput();
    const run = (({ options }) => {
      options.spawnClaudeCodeProcess?.({} as never);
      throw new Error("must not launch without inventory");
    }) as typeof query;
    try {
      await expect(
        (async () => {
          for await (const _ of claudeQuery(run, "main", {}, new AbortController().signal, {
            input: live,
          })) {
          }
        })(),
      ).rejects.toMatchObject({ name: "ExecutionCleanupError", hostUnsafe: false });
      const unbind = live.bind(async () => "rejected");
      unbind();
    } finally {
      prepare.mockRestore();
    }
  });

  it.skipIf(!processTreeAvailable).each([
    ["stays running", "group"],
    ["exits first", "group"],
    ["stays running", "detached"],
    ["exits first", "detached"],
    ["exits first", "double fork"],
    ["exits first", "unmarked double fork"],
  ])(
    "stops tools before the stream ends, or fails it, when Claude Code %s (%s)",
    async (lifetime, tool) => {
      if (process.platform === "win32") return;
      const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
      const dir = await mkdtemp(join(tmpdir(), "claude-code-exit-"));
      // Ignores the SDK's stop, and leaves a command's descendant running that edits the worktree.
      const script = join(dir, "claude.mjs");
      await writeFile(
        script,
        `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const dir = ${JSON.stringify(dir)};
writeFileSync(dir + "/pid", String(process.pid));
process.on("SIGTERM", () => {});
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let users = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request")
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  if (message.type !== "user" || users++ > 0) return;
  const payload = 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(dir + "/tool-pid") + ', String(process.pid)); setTimeout(() => writeFileSync(' + JSON.stringify(dir + "/late") + ', "late"), 1200);';
  const launch = ${JSON.stringify(tool)}.includes("double fork")
    ? 'import { spawn } from "node:child_process"; const child = spawn(process.execPath, ["--input-type=module", "-e", ' + JSON.stringify(payload) + '], { detached: true, stdio: "ignore", ' + (${JSON.stringify(tool)} === "unmarked double fork" ? 'env: {}' : '') + ' }); child.unref();'
    : payload;
  const child = spawn("sh", ["-c", 'exec "$@"', "claude-tool", process.execPath, "--input-type=module", "-e", launch], { stdio: "ignore", detached: ${JSON.stringify(tool)} !== "group" });
  writeFileSync(dir + "/launcher-pid", String(child.pid));
  child.unref();
  send({ type: "system", subtype: "init", session_id: "s" });
  send({ type: "result", subtype: "success", result: "done", session_id: "s" });
  ${lifetime === "exits first" ? "process.exit(0);" : ""}
});
setInterval(() => {}, 1000);
`,
      );
      let pid = 0;
      const kill = vi.spyOn(process, "kill");
      try {
        const results: string[] = [];
        let cleanupFailed = false;
        try {
          for await (const message of claudeQuery(
            sdkQuery,
            "main",
            { pathToClaudeCodeExecutable: script, env: { ...process.env } },
            new AbortController().signal,
            { exitMs: 300 },
          ))
            if (message.type === "result") results.push(message.subtype);
          // The stream ends only after process-tree cleanup. A bare PID cannot prove the
          // original process is gone: a loaded host may already have reused that number.
        } catch (error) {
          expect(error).toMatchObject({ name: "ExecutionCleanupError" });
          // Inventory failures before launch cannot establish post-result cleanup behavior.
          expect(await readFile(join(dir, "pid"), "utf8")).toMatch(/^\d+$/u);
          cleanupFailed = true;
        }
        // Without confirmed cleanup the stream fails, so the result never completes an Attempt.
        expect(results).toEqual(cleanupFailed ? expect.any(Array) : ["success"]);
        // A reaped leader's process-group number can already belong to another invocation.
        expect(kill.mock.calls.some(([target, signal]) => target < 0 && signal === "SIGKILL")).toBe(
          false,
        );
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        // A marker-cleared double fork can escape between inventory scans.
        if (!cleanupFailed && tool !== "unmarked double fork")
          await expect(readFile(join(dir, "late"), "utf8")).rejects.toThrow();
      } finally {
        kill.mockRestore();
        pid ||= Number(await readFile(join(dir, "pid"), "utf8").catch(() => "0"));
        // These test processes have bounded lifetimes. Reap them before removing their files.
        for (const name of ["pid", "launcher-pid", "tool-pid"]) {
          const owned = Number(await readFile(join(dir, name), "utf8").catch(() => "0"));
          try {
            if (owned) process.kill(owned, "SIGKILL");
          } catch {}
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
