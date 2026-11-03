import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../packages/control-plane/src/index.ts";
import { createCodexWorker } from "../../packages/runtime/harnesses/codex/src/index.ts";
import {
  ContextResolverRegistry,
  FileSkillResolver,
  LocalWorklet,
} from "../../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../../packages/store/src/index.ts";
import { migrateSqlite } from "../support/database.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Context Set Skills", () => {
  it("equips only an activated surface with its Worker-allowlisted skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "supertag-skills-e2e-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "supertag.db");
    await migrateSqlite(databasePath);
    const workspace = join(root, "workspace");
    const skill = join(root, "skills/code-review");
    await mkdir(workspace, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(join(workspace, "evidence.txt"), "The Gateway owns ingress and egress.\n");
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: code-review\ndescription: Answer architecture questions with code evidence.\n---\nCite the workspace evidence in the final answer.\n",
    );
    const catalogPath = join(root, "skills.json");
    await writeFile(
      catalogPath,
      JSON.stringify({
        version: 1,
        skills: [{ id: "code-review", version: "1", path: "./skills/code-review" }],
      }),
    );
    const skills = await FileSkillResolver.load({ catalogPath });
    const prompts: string[] = [];
    const runner = vi.fn(async function* ({
      prompt,
      workspace: runWorkspace,
    }: {
      prompt: string;
      workspace: string;
    }) {
      prompts.push(prompt);
      if (!prompt.includes("skills selected by the Tag's Context Sets")) {
        yield {
          type: "output.message" as const,
          text: "No Context Set skill was selected.",
        };
        return;
      }
      const instructions = await readFile(
        join(runWorkspace, ".agents/skills/skill-code-review/SKILL.md"),
        "utf8",
      );
      const evidence = await readFile(join(runWorkspace, "evidence.txt"), "utf8");
      yield {
        type: "output.message" as const,
        text: `${instructions.trim()} Evidence: ${evidence.trim()}`,
      };
    });
    const worker = createCodexWorker({
      workerId: "context-skill-worker",
      profileId: "context-codex",
      profileRevision: "1",
      workspace,
      contextResolvers: new ContextResolverRegistry([
        skills,
        {
          type: "acme.io/runbook",
          versions: [1],
          outputKinds: ["instruction"],
          async resolve(item) {
            const name = item.config["name"];
            if (typeof name !== "string") throw new Error("Runbook name is required");
            return {
              id: `runbook:${name}`,
              kind: "instruction" as const,
              required: item.required,
              content: `Consult the ${name} runbook before answering.`,
              scope: "task" as const,
              priority: 50,
            };
          },
        },
      ]),
      runner,
    });
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    const reply = vi.fn(async () => undefined);
    const controlPlane = new ControlPlane({
      store,
      credentialVault: new FileGatewayCredentialVault(join(root, "secrets.json")),
      worklet: new LocalWorklet("context-skill-worklet", "context-skill-host", [worker]),
      reply,
      dispatch: { pollIntervalMs: 5, retryBaseMs: 5, maxAttempts: 1 },
    });

    await store.connect();
    const account = await store.saveSurfaceAccount({
      provider: "slack",
      externalAccountId: "T123",
      displayName: "Acme",
      authMethod: "slack-socket-mode",
      credentialId: "test/slack",
      status: "connected",
      configuration: { transport: "socket" },
      verifiedAt: "2026-08-03T00:00:00.000Z",
    });
    const tag = await store.createTag({
      name: "engineering",
    });
    await store.bindTagWorkerHost(tag.id, "context-skill-host");
    const equipped = await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: account.id,
      scope: "channel:C-EQUIPPED",
    });
    await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: account.id,
      scope: "channel:C-PLAIN",
    });
    const contextSet = await store.createTagContextSet({ tagId: tag.id, name: "engineering" });
    await store.addTagContextItem({
      contextSetId: contextSet.id,
      itemKey: "skill:code-review",
      type: "supertag/skill",
      version: 1,
      required: true,
      config: { reference: "code-review", version: "1" },
    });
    await store.addTagContextItem({
      contextSetId: contextSet.id,
      itemKey: "runbook:payments",
      type: "acme.io/runbook",
      version: 1,
      required: true,
      config: { name: "payments" },
    });
    await store.activateTagContextSet({
      contextSetId: contextSet.id,
      tagRouteId: equipped.id,
    });
    await store.disconnect();

    try {
      await controlPlane.start();
      await controlPlane.ingestSurfaceEvent(slackInvocation("equipped", "C-EQUIPPED"));
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
      expect(reply.mock.calls[1]?.[1].markdown).toContain("Cite the workspace evidence");
      expect(reply.mock.calls[1]?.[1].markdown).toContain("The Gateway owns ingress and egress");

      await controlPlane.ingestSurfaceEvent(slackInvocation("plain", "C-PLAIN"));
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(4));
      expect(reply.mock.calls[3]?.[1].markdown).toMatch(/^No Context Set skill was selected\./u);
      expect(prompts[0]).toContain("skills selected by the Tag's Context Sets");
      expect(prompts[0]).toContain("Consult the payments runbook before answering.");
      expect(prompts[1]).not.toContain("skills selected by the Tag's Context Sets");
      expect(prompts[1]).not.toContain("Consult the payments runbook before answering.");
    } finally {
      await controlPlane.stop();
    }
  });
});

function slackInvocation(eventId: string, channelId: string) {
  return {
    eventId,
    logicalEventId: eventId,
    provider: "slack" as const,
    externalAccountId: "T123",
    kind: "mention" as const,
    scope: `channel:${channelId}`,
    sessionKey: `slack:T123:${channelId}:thread-1`,
    actor: { id: "U1", displayName: "Alice", kind: "user" as const },
    text: "@SuperTag Explain the architecture.",
    occurredAt: "2026-08-03T00:00:00.000Z",
    callback: {
      provider: "slack" as const,
      mode: "slack_thread" as const,
      threadKey: "thread-1",
      target: { channelId, threadTs: "thread-1" },
    },
    source: { channelId },
    metadata: {},
  };
}
