import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { runClaudeSessionPhase } from "../../../../tests/support/claude-session-live.js";
import {
  FileSessionStateStore,
  minimalProcessEnvironment,
  terminalOutputText,
} from "../../sdk/src/index.js";
import { ClaudeSessionStore, readClaudeTranscripts } from "./src/session-store.js";

const live = process.env["SUPERTAG_CLAUDE_SESSION_LIVE"] === "1" ? it : it.skip;

live(
  "preserves and resumes a real provider compaction boundary",
  async () => {
    if (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"])
      throw new Error("This live test requires subscription auth");
    const directory = await mkdtemp(join(tmpdir(), "supertag-claude-compact-live-"));
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error("Live compaction deadline")),
      120_000,
    );
    try {
      const source = join(directory, "source");
      await mkdir(source);
      await writeFile(join(source, "effects.log"), "executed\n");
      const nonce = randomUUID();
      const store = new FileSessionStateStore(join(directory, "states"));
      const first = await runClaudeSessionPhase({
        directory,
        source,
        runtime: join(directory, "worker-a"),
        phase: "pre-compact",
        sessionStateStore: store,
        prompt: `Remember this exact private conversation nonce ${nonce}. Do not write it to any file. Read effects.log. Reply READY. Do not spawn helpers.`,
      });
      expect(first.events.at(-1), JSON.stringify(first.events.at(-1))).toMatchObject({
        type: "execution.completed",
      });
      const state = first.events.findLast((event) => event.type === "session.updated");
      if (state?.type !== "session.updated") throw new Error("No native state before compaction");
      const saved = await store.load(state.sessionState);
      if (!saved || typeof saved.data["claudeSessionId"] !== "string")
        throw new Error("Missing native archive");
      const nativeId = saved.data["claudeSessionId"];
      await rm(join(directory, "worker-a"), { recursive: true, force: true });
      const mirror = new ClaudeSessionStore(async (_id, transcripts) => {
        await store.save({ ...saved, data: { ...saved.data, transcripts } });
      }, readClaudeTranscripts(saved.data["transcripts"]));
      const compactDirectory = join(directory, "compact-runtime");
      await mkdir(compactDirectory);
      let observedCompactBoundary = false;
      // Slash commands are provider controls, not SuperTag Tasks. Execute the actual SDK
      // compact command against the saved native Session, then resume through the Worker.
      for await (const event of query({
        prompt:
          "/compact Preserve the exact private conversation nonce and the fact that effects.log must not be appended again.",
        options: {
          cwd: compactDirectory,
          model: "haiku",
          resume: nativeId,
          abortController: controller,
          sessionStore: mirror,
          sessionStoreFlush: "eager",
          settingSources: [],
          tools: [],
          permissionMode: "dontAsk",
          env: {
            ...minimalProcessEnvironment(process.env, ["CLAUDE_CODE_OAUTH_TOKEN"]),
            CLAUDE_CONFIG_DIR: join(compactDirectory, ".claude-config"),
            CLAUDE_SECURESTORAGE_CONFIG_DIR:
              process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] ??
              process.env["CLAUDE_CONFIG_DIR"] ??
              "",
          },
        },
      })) {
        if (event.type === "system" && event.subtype === "compact_boundary")
          observedCompactBoundary = true;
        if (event.type === "system" && event.subtype === "mirror_error")
          throw new Error("Native compaction mirror failed");
      }
      await mirror.flush();
      const compacted = await store.load(state.sessionState);
      const entries =
        readClaudeTranscripts(compacted?.data["transcripts"])?.flatMap(
          (record) => record.entries,
        ) ?? [];
      expect(observedCompactBoundary).toBe(true);
      expect(entries.some((entry) => entry["subtype"] === "compact_boundary")).toBe(true);
      expect(JSON.stringify(entries)).toContain(nonce);
      await rm(compactDirectory, { recursive: true, force: true });
      const resumed = await runClaudeSessionPhase({
        directory,
        source,
        runtime: join(directory, "worker-b"),
        phase: "post-compact",
        sessionStateStore: new FileSessionStateStore(join(directory, "states")),
        priorState: state.sessionState,
        prompt:
          "Recall the exact private conversation nonce from before compaction. Read effects.log but do not modify it. Do not spawn helpers.",
      });
      expect(resumed.events.at(-1), JSON.stringify(resumed.events.at(-1))).toMatchObject({
        type: "execution.completed",
      });
      expect(terminalOutputText(resumed.events)).toContain(nonce);
      const finalState = resumed.events.findLast((event) => event.type === "session.updated");
      if (finalState?.type !== "session.updated") throw new Error("Missing resumed state");
      expect((await store.load(finalState.sessionState))?.data["claudeSessionId"]).toBe(nativeId);
    } finally {
      clearTimeout(deadline);
      await rm(directory, { recursive: true, force: true });
    }
  },
  240_000,
);
