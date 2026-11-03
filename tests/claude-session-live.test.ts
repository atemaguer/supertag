import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  FileSessionStateStore,
  type StoredHarnessSessionState,
  terminalOutputText,
} from "../packages/runtime/sdk/src/index.js";
import { runClaudeSessionPhase } from "./support/claude-session-live.js";

const live = process.env["SUPERTAG_CLAUDE_SESSION_LIVE"] === "1" ? it : it.skip;

live(
  "resumes real Claude native state after deleting the original runtime, without replaying history or tools",
  async () => {
    if (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"])
      throw new Error("This live test requires subscription auth, not API billing credentials");
    const directory = await mkdtemp(join(tmpdir(), "supertag-claude-session-live-"));
    try {
      const source = join(directory, "source");
      const runtime = join(directory, "worker-a");
      const stateDirectory = join(directory, "sessions");
      await mkdir(source);
      await writeFile(join(source, "effects.log"), "");
      const nonce = randomUUID();
      const first = await runClaudeSessionPhase({
        directory,
        source,
        runtime,
        phase: "first",
        sessionStateStore: new FileSessionStateStore(stateDirectory),
        prompt: `Remember this private conversation nonce: ${nonce}. Never write the nonce to any file. Append exactly ONE line 'executed' to effects.log using a tool once. Do not repeat the append. Reply INITIAL_DONE. Do not spawn helpers.`,
      });
      expect(first.events.at(-1), JSON.stringify(first.events.at(-1))).toMatchObject({
        type: "execution.completed",
      });
      const state = first.events.findLast((event) => event.type === "session.updated");
      if (state?.type !== "session.updated") throw new Error("Native session was not persisted");
      const stored = await new FileSessionStateStore(stateDirectory).load(state.sessionState);
      expect(stored?.data["transcripts"]).toBeDefined();
      const nativeId = stored?.data["claudeSessionId"];
      const artifact = first.events.find((event) => event.type === "artifact.created");
      if (artifact?.type !== "artifact.created")
        throw new Error("Missing tool side effect evidence");
      const effects = Buffer.from(await first.artifacts.get(artifact.artifact)).toString("utf8");
      expect(effects).toBe("executed\n");
      await rm(runtime, { recursive: true, force: true });
      expect(await readdir(directory)).not.toContain("worker-a");
      await writeFile(join(source, "effects.log"), effects);
      const second = await runClaudeSessionPhase({
        directory,
        source,
        runtime: join(directory, "worker-b"),
        phase: "second",
        sessionStateStore: new FileSessionStateStore(stateDirectory),
        priorState: state.sessionState,
        prompt:
          "Return the exact private conversation nonce from our previous turn. Do not append to effects.log again. Read effects.log to verify it still contains exactly one executed line. Do not spawn helpers.",
      });
      expect(second.events.at(-1), JSON.stringify(second.events.at(-1))).toMatchObject({
        type: "execution.completed",
      });
      expect(terminalOutputText(second.events)).toContain(nonce);
      const secondState = second.events.findLast((event) => event.type === "session.updated");
      if (secondState?.type !== "session.updated") throw new Error("Resumed session not persisted");
      expect(
        (await new FileSessionStateStore(stateDirectory).load(secondState.sessionState))?.data[
          "claudeSessionId"
        ],
      ).toBe(nativeId);
      const finalArtifact = second.events.find((event) => event.type === "artifact.created");
      if (finalArtifact?.type !== "artifact.created")
        throw new Error("Missing resumed side effect evidence");
      expect(Buffer.from(await second.artifacts.get(finalArtifact.artifact)).toString("utf8")).toBe(
        "executed\n",
      );
      console.log(
        JSON.stringify({
          scenario: "claude-local-native-session",
          nativeId,
          firstEntries: JSON.stringify(stored?.data).length,
          historyReplayed: 0,
          originalRuntimeRemoved: true,
          toolEffects: 1,
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  300_000,
);

live(
  "retains a partial native Claude archive on cancellation without publishing a resume point",
  async () => {
    if (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"])
      throw new Error("This live test requires subscription auth");
    const directory = await mkdtemp(join(tmpdir(), "supertag-claude-interrupt-live-"));
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error("Live test timeout")), 60_000);
    try {
      const source = join(directory, "source");
      await mkdir(source);
      await writeFile(join(source, "effects.log"), "");
      const store = new FileSessionStateStore(join(directory, "sessions"));
      let partial: StoredHarnessSessionState | undefined;
      let cancelledDuringTool = false;
      const result = await runClaudeSessionPhase({
        directory,
        source,
        runtime: join(directory, "runtime"),
        phase: "interrupted",
        signal: controller.signal,
        sessionStateStore: {
          load: (ref) => store.load(ref),
          save: async (state) => {
            await store.save(state);
            partial = state;
            if (!cancelledDuringTool && JSON.stringify(state.data).includes('"tool_use"')) {
              cancelledDuringTool = true;
              setTimeout(() => controller.abort(new Error("Intentional live interruption")), 250);
            }
          },
        },
        prompt:
          "Run Bash command sleep 30. Then append exactly one executed line to effects.log. Do not finish before that command returns. Do not spawn helpers.",
      });
      expect(cancelledDuringTool).toBe(true);
      expect(result.events.at(-1)).toMatchObject({ type: "execution.failed" });
      expect(result.events.some((event) => event.type === "session.updated")).toBe(false);
      expect(partial).toBeDefined();
      if (!partial) throw new Error("No partial archive persisted");
      const reopened = await new FileSessionStateStore(join(directory, "sessions")).load(
        partial.ref,
      );
      expect(JSON.stringify(reopened?.data)).toContain('"tool_use"');
      expect(reopened?.data["claudeSessionId"]).toBeTruthy();
    } finally {
      clearTimeout(deadline);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

live(
  "fails closed when a real Claude transcript mirror cannot persist tool records",
  async () => {
    if (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"])
      throw new Error("This live test requires subscription auth");
    const directory = await mkdtemp(join(tmpdir(), "supertag-claude-mirror-failure-live-"));
    try {
      const source = join(directory, "source");
      await mkdir(source);
      await writeFile(join(source, "effects.log"), "executed\n");
      const store = new FileSessionStateStore(join(directory, "sessions"));
      let rejectedWrites = 0;
      const result = await runClaudeSessionPhase({
        directory,
        source,
        runtime: join(directory, "runtime"),
        phase: "mirror-failure",
        sessionStateStore: {
          load: (ref) => store.load(ref),
          save: async (state) => {
            if (JSON.stringify(state.data).includes('"tool_use"')) {
              rejectedWrites++;
              throw new Error("Injected Session storage outage");
            }
            await store.save(state);
          },
        },
        prompt:
          "Read effects.log with a tool and report its content. Do not modify files. Do not spawn helpers.",
      });
      expect(rejectedWrites).toBeGreaterThan(0);
      expect(result.events.at(-1)).toMatchObject({ type: "execution.failed" });
      expect(result.events.some((event) => event.type === "session.updated")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  150_000,
);

live(
  "persists real Claude local subagent transcripts with the manager Session",
  async () => {
    if (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"])
      throw new Error("This live test requires subscription auth");
    const directory = await mkdtemp(join(tmpdir(), "supertag-claude-child-live-"));
    try {
      const source = join(directory, "source");
      await mkdir(source);
      await writeFile(join(source, "effects.log"), "executed\n");
      const nonce = randomUUID();
      const store = new FileSessionStateStore(join(directory, "sessions"));
      const result = await runClaudeSessionPhase({
        directory,
        source,
        runtime: join(directory, "runtime"),
        phase: "child",
        sessionStateStore: store,
        prompt: `Use the Agent tool exactly once to spawn the supertag-local helper. Give that helper the private marker ${nonce} and ask it to read effects.log and return its contents together with the marker. Wait for the helper result and report it. Do not write the marker to files.`,
      });
      expect(result.events.at(-1), JSON.stringify(result.events.at(-1))).toMatchObject({
        type: "execution.completed",
      });
      const final = result.events.findLast((event) => event.type === "session.updated");
      if (final?.type !== "session.updated") throw new Error("No native state saved");
      const archive = await store.load(final.sessionState);
      const transcripts = archive?.data["transcripts"] as
        | { subpath?: string; entries: unknown[] }[]
        | undefined;
      expect(transcripts?.some((record) => record.subpath?.startsWith("subagents/"))).toBe(true);
      const child = transcripts?.find((record) => record.subpath?.startsWith("subagents/"));
      expect(JSON.stringify(child?.entries)).toContain(nonce);
      expect(terminalOutputText(result.events)).toContain(nonce);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  150_000,
);
