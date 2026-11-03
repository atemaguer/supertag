import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTaskAttemptEvents } from "@supertag/worker-sdk";
import { expect, it } from "vitest";
import { cursorLiveAttempt, cursorLiveTool, cursorLiveWorker } from "./cursor-live-setup.js";
import type { CursorRunRequest } from "./src/index.js";

it("delivers the live SuperTag stdio tool to the fake Cursor runner", async () => {
  const directory = await mkdtemp(
    join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "cursor-live-setup-"),
  );
  try {
    const script = join(directory, "supertag-mcp.cjs");
    const tool = cursorLiveTool(script);
    let request: CursorRunRequest | undefined;
    const worker = cursorLiveWorker({
      directory,
      tool,
      runner: async function* (input) {
        request = input;
        yield { type: "output.message", text: "Ready", final: true };
      },
    });
    const events = await collectTaskAttemptEvents(
      worker.execute(cursorLiveAttempt({ id: "cursor-live-setup", prompt: "Call probe", tool })),
    );
    expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("execution.completed");
    expect(request?.toolInputs).toEqual([tool]);
    expect(request?.mcpServers).toMatchObject({
      supertag: { type: "stdio", command: process.execPath, args: [script] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
