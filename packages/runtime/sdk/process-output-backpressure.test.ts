import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProcessOutputChunk } from "./src/index.js";
import { ProcessOutputBuffer, spawnOwnedProcess } from "./src/process-supervision.js";

const chunk = (text: string, stream: "stdout" | "stderr" = "stdout"): ProcessOutputChunk => ({
  stream,
  text,
});

describe("ProcessOutputBuffer backpressure", () => {
  it("asks the producer to pause at the high-water mark, once", () => {
    const pause = vi.fn();
    const buffer = new ProcessOutputBuffer({
      highWaterBytes: 100,
      lowWaterBytes: 20,
      maximumBytes: 1000,
      pause,
    });
    expect(buffer.push(chunk("a".repeat(60)))).toBe(true);
    expect(pause).not.toHaveBeenCalled();
    expect(buffer.push(chunk("b".repeat(40)))).toBe(false);
    expect(buffer.paused).toBe(true);
    expect(buffer.push(chunk("c".repeat(40)))).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
    expect(buffer.bufferedBytes).toBe(140);
  });

  it("resumes the producer only after the consumer drains to the low-water mark", async () => {
    const resume = vi.fn();
    const buffer = new ProcessOutputBuffer({
      highWaterBytes: 100,
      lowWaterBytes: 20,
      maximumBytes: 1000,
      resume,
    });
    for (let index = 0; index < 6; index++) buffer.push(chunk(String(index).repeat(20)));
    let drained = false;
    void buffer.drained().then(() => {
      drained = true;
    });
    const iterator = buffer[Symbol.asyncIterator]();
    for (let consumed = 1; consumed <= 4; consumed++) {
      await iterator.next();
      await Promise.resolve();
      // 120 bytes buffered; resume at <= 20, which the fifth read reaches.
      expect(resume).not.toHaveBeenCalled();
      expect(drained).toBe(false);
    }
    await iterator.next();
    await Promise.resolve();
    expect(resume).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
    expect(buffer.paused).toBe(false);
    expect(buffer.push(chunk("x"))).toBe(true);
    await expect(buffer.drained()).resolves.toBeUndefined();
  });

  it("still enforces a hard cap for producers that cannot pause", () => {
    const buffer = new ProcessOutputBuffer({ highWaterBytes: 100, lowWaterBytes: 20 });
    expect(buffer.maximumBytes).toBe(800);
    for (let index = 0; index < 8; index++) buffer.push(chunk("x".repeat(100)));
    expect(() => buffer.push(chunk("y"))).toThrow(
      "Process output exceeded its 800-byte hard limit of unconsumed output: the producer could not pause at the 100-byte high-water mark",
    );
  });

  it("defaults to 1 MiB high water, 256 KiB low water, and an 8 MiB hard cap", () => {
    const buffer = new ProcessOutputBuffer();
    expect([buffer.highWaterBytes, buffer.lowWaterBytes, buffer.maximumBytes]).toEqual([
      1024 * 1024,
      256 * 1024,
      8 * 1024 * 1024,
    ]);
    expect(() => new ProcessOutputBuffer({ highWaterBytes: 10, lowWaterBytes: 10 })).toThrow(
      "low < high < maximum",
    );
  });

  it("preserves order across streams and delivers everything buffered after close", async () => {
    const buffer = new ProcessOutputBuffer({ highWaterBytes: 8, lowWaterBytes: 2 });
    const sent = Array.from({ length: 20 }, (_, index) =>
      chunk(`${index};`, index % 3 ? "stdout" : "stderr"),
    );
    for (const item of sent) buffer.push(item);
    buffer.close();
    const received = [];
    for await (const item of buffer) received.push(item);
    expect(received).toEqual(sent);
  });

  it("delivers buffered output before a close error, and settles drained() on close", async () => {
    const buffer = new ProcessOutputBuffer({ highWaterBytes: 4, lowWaterBytes: 1 });
    buffer.push(chunk("ab"));
    buffer.push(chunk("cd"));
    const drained = buffer.drained();
    buffer.close(new Error("process failed"));
    await expect(drained).resolves.toBeUndefined();
    const received: string[] = [];
    await expect(async () => {
      for await (const item of buffer) received.push(item.text);
    }).rejects.toThrow("process failed");
    expect(received).toEqual(["ab", "cd"]);
  });

  it("releases a paused producer when its consumer stops reading", async () => {
    const resume = vi.fn();
    const buffer = new ProcessOutputBuffer({ highWaterBytes: 4, lowWaterBytes: 1, resume });
    buffer.push(chunk("abcd"));
    buffer.push(chunk("efgh"));
    const drained = buffer.drained();
    for await (const _ of buffer) break;
    await expect(drained).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalledOnce();
    expect(buffer.push(chunk("x".repeat(100)))).toBe(true);
    expect(buffer.bufferedBytes).toBe(0);
  });
});

const MiB = 1024 * 1024;
// Deterministic, position-dependent content, so loss or reordering changes the text.
const GENERATE =
  "const generate=(tag,bytes)=>{let s='';for(let i=0;s.length<bytes;i++)s+=tag+i.toString(36).padStart(7,'0')+'\\n';return s.slice(0,bytes)};";
function expected(tag: string, bytes: number): string {
  let text = "";
  for (let index = 0; text.length < bytes; index++)
    text += `${tag}${index.toString(36).padStart(7, "0")}\n`;
  return text.slice(0, bytes);
}
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("local process output backpressure", () => {
  it("completes a child that writes far more than the cap to a slow consumer, losing nothing", async () => {
    const bytes = 20 * MiB;
    const script = `${GENERATE}process.stdout.write(generate('o',${bytes}));process.stderr.write(generate('e',${bytes}));`;
    const handle = await spawnOwnedProcess({
      spec: { command: process.execPath, args: ["-e", script], streamOutput: true },
      cwd: process.cwd(),
      environment: {},
      maximumOutput: 1000,
      record: async () => {},
    });
    const output = handle.output as ProcessOutputBuffer;
    expect(output).toBeInstanceOf(ProcessOutputBuffer);
    const received = { stdout: [] as string[], stderr: [] as string[] };
    let paused = false;
    let peak = 0;
    let sinceDelay = 0;
    try {
      for await (const item of output) {
        received[item.stream].push(item.text);
        paused ||= output.paused;
        peak = Math.max(peak, output.bufferedBytes + item.text.length);
        sinceDelay += item.text.length;
        // About 40 MiB/s: far slower than the child can write.
        if (sinceDelay >= 512 * 1024) {
          sinceDelay = 0;
          await delay(12);
        }
      }
      const result = await handle.wait();
      expect(result.exitCode).toBe(0);
      const stdout = received.stdout.join("");
      const stderr = received.stderr.join("");
      expect(stdout.length).toBe(bytes);
      expect(stderr.length).toBe(bytes);
      expect(stdout === expected("o", bytes)).toBe(true);
      expect(stderr === expected("e", bytes)).toBe(true);
      // Tail buffers still hold the end of each stream.
      expect(result.stdout).toBe(stdout.slice(-1000));
      expect(result.stderr).toBe(stderr.slice(-1000));
      expect(paused).toBe(true);
      // Bounded near the high-water mark, well below the hard cap.
      expect(peak).toBeLessThan(output.highWaterBytes + 2 * MiB);
    } finally {
      await handle.stop();
    }
  }, 60_000);

  it("regression: a slow consumer of a fast producer no longer fails the process", async () => {
    const bytes = 4 * MiB;
    const handle = await spawnOwnedProcess({
      spec: {
        command: process.execPath,
        args: ["-e", `${GENERATE}process.stdout.write(generate('r',${bytes}));`],
        streamOutput: true,
      },
      cwd: process.cwd(),
      environment: {},
      maximumOutput: 100,
      record: async () => {},
    });
    const parts: string[] = [];
    try {
      let sinceDelay = 0;
      for await (const item of handle.output ?? []) {
        parts.push(item.text);
        sinceDelay += item.text.length;
        if (sinceDelay >= 256 * 1024) {
          sinceDelay = 0;
          await delay(25);
        }
      }
      expect((await handle.wait()).exitCode).toBe(0);
      expect(parts.join("") === expected("r", bytes)).toBe(true);
    } finally {
      await handle.stop();
    }
  }, 30_000);

  it.each(["cancellation", "timeout"] as const)(
    "%s while paused terminates the whole tree and ends the output stream",
    async (mode) => {
      // The root and a background descendant both write without end to the shared pipes.
      const writer = `const b='z'.repeat(65536);const w=()=>{process.stdout.write(b,w)};w();setInterval(()=>process.stderr.write(b),1)`;
      const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'inherit'});${writer}`;
      const abort = new AbortController();
      const handle = await spawnOwnedProcess({
        spec: {
          command: process.execPath,
          args: ["-e", script],
          streamOutput: true,
          ...(mode === "timeout" ? { timeoutMs: 1500 } : {}),
        },
        cwd: process.cwd(),
        environment: {},
        signal: abort.signal,
        maximumOutput: 100,
        record: async () => {},
      });
      const output = handle.output as ProcessOutputBuffer;
      const waited = handle.wait();
      void waited.catch(() => {});
      try {
        const until = Date.now() + 5000;
        while (!output.paused && Date.now() < until) await delay(10);
        expect(output.paused).toBe(true);
        // Unconsumed output stays bounded while paused instead of failing the process.
        await delay(300);
        expect(output.bufferedBytes).toBeLessThan(output.maximumBytes);
        expect(groupAlive(handle.pid as number)).toBe(true);
        if (mode === "cancellation") abort.abort(new Error("cancelled while paused"));
        await expect(waited).rejects.toThrow(
          mode === "cancellation" ? "cancelled while paused" : "execution limit",
        );
        expect(groupAlive(handle.pid as number)).toBe(false);
        // The consumer receives what was buffered, then the failure; nothing hangs.
        await expect(async () => {
          for await (const _ of output) {
          }
        }).rejects.toThrow(mode === "cancellation" ? "cancelled while paused" : "execution limit");
      } finally {
        await handle.stop();
      }
    },
    20_000,
  );
});
