import { expect, it } from "vitest";
import { spawnOwnedProcess } from "../packages/runtime/sdk/src/process-supervision.ts";

it.skipIf(process.platform === "win32")(
  "streams split UTF-8 codepoints without corruption and preserves channels",
  async () => {
    const handle = await spawnOwnedProcess({
      spec: {
        command: process.execPath,
        args: [
          "-e",
          "const b=Buffer.from('hello 🌍');process.stdout.write(b.subarray(0,8));setTimeout(()=>{process.stdout.write(b.subarray(8));process.stderr.write('problem')},20)",
        ],
        streamOutput: true,
      },
      cwd: process.cwd(),
      environment: {},
      maximumOutput: 100,
      record: async () => {},
    });
    try {
      const chunks = [];
      for await (const chunk of handle.output ?? []) chunks.push(chunk);
      expect(
        chunks
          .filter((c) => c.stream === "stdout")
          .map((c) => c.text)
          .join(""),
      ).toBe("hello 🌍");
      expect(
        chunks
          .filter((c) => c.stream === "stderr")
          .map((c) => c.text)
          .join(""),
      ).toBe("problem");
      expect((await handle.wait()).exitCode).toBe(0);
    } finally {
      await handle.stop();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "blocks an unconsumed output stream's producer instead of failing it, and still stops it",
  async () => {
    const handle = await spawnOwnedProcess({
      spec: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('x'.repeat(20_000_000),()=>process.stderr.write('wrote'))",
        ],
        streamOutput: true,
      },
      cwd: process.cwd(),
      environment: {},
      maximumOutput: 100,
      record: async () => {},
    });
    const waited = handle.wait();
    void waited.catch(() => {});
    try {
      // Backpressure holds the child on its pipe: it neither finishes nor fails.
      const early = await Promise.race([
        waited.then(
          () => "settled",
          () => "settled",
        ),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
      ]);
      expect(early).toBe("blocked");
      expect(() => process.kill(-(handle.pid as number), 0)).not.toThrow();
      handle.kill();
      await expect(waited).rejects.toThrow(/Process terminated/);
      expect(() => process.kill(-(handle.pid as number), 0)).toThrow();
    } finally {
      await handle.stop();
    }
  },
  10_000,
);
