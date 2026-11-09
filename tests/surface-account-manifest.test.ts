import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import type { SurfaceVerifier } from "../apps/cli/src/manifest-apply.ts";
import {
  getSurfaceAccountResource,
  listSurfaceAccountResources,
} from "../apps/cli/src/operator-resources.ts";
import { applyManifests } from "../apps/cli/src/resources.ts";
import { DrizzleStore } from "../packages/store/src/index.ts";
import type { VerifiedSurfaceAccount } from "../packages/surfaces/sdk/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { getResource, listResources } from "./support/resources.ts";

const BOT = "xoxb-acme-bot-value";
const SIGNING = "acme-signing-value";

/** An HTTP-events Slack account: verification calls auth.test, and no socket starts. */
const account = (
  name = "acme-slack",
  secrets = "    botToken: { env: ACME_BOT }\n    signingSecret: { file: signing.txt }\n",
) => `apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: ${name}
spec:
  provider: slack
  configuration:
    transport: http
  secrets:
${secrets}`;

const tag = (locations: string) => `apiVersion: supertag/v1
kind: Tag
metadata:
  name: builder
spec:
  roles: []
  locations: ${locations}
`;

describe("SurfaceAccount manifests", () => {
  const token = "test-administrative-token";
  const startRuntime = (options: { readonly verifySurface?: SurfaceVerifier } = {}) =>
    startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: token,
      surfaceRefreshIntervalMs: 3_600_000,
      ...options,
    });
  let directory: string;
  let databasePath: string;
  let serverState: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let client: ControlPlaneClient;
  let output: string[];
  let errors: string[];
  let slackCalls: { method: string; token: string | undefined }[];
  let slackTeam: { team: string; team_id: string };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-surface-account-manifest-"));
    serverState = join(directory, "server");
    databasePath = join(serverState, "supertag.db");
    await migrateSqlite(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", serverState);
    runtime = await startRuntime();
    output = [];
    errors = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    // Only the provider is fake; Control Plane requests use the real network stack.
    slackCalls = [];
    slackTeam = { team: "Acme", team_id: "T123" };
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://slack.com/api/")) return realFetch(input, init);
      const bearer = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length);
      slackCalls.push({ method: url.slice("https://slack.com/api/".length), token: bearer });
      if (bearer === "xoxb-rejected") return Response.json({ ok: false, error: "invalid_auth" });
      return Response.json({ ok: true, ...slackTeam, user_id: "U1", bot_id: "B1" });
    });
    vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "client"));
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", token);
    vi.stubEnv("ACME_BOT", BOT);
    await writeFile(join(directory, "signing.txt"), `${SIGNING}\n`);
    await expect(main(["connect", "control-plane", runtime.url])).resolves.toBe(0);
    client = new ControlPlaneClient({ url: runtime.url, token });
  });

  afterEach(async () => {
    // Nothing the CLI printed, on success or failure, may contain a secret value.
    for (const text of [...output, ...errors]) {
      expect(text).not.toContain(BOT);
      expect(text).not.toContain(SIGNING);
    }
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const write = async (name: string, content: string) => {
    const path = join(directory, name);
    await writeFile(path, content);
    return path;
  };
  const run = async (...args: string[]) => {
    output.length = 0;
    await expect(main(args)).resolves.toBe(0);
    return output.join("");
  };
  const fail = async (...args: string[]) => {
    const error = await main(args).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    errors.push(message);
    return message;
  };
  const vault = async () =>
    JSON.parse(await readFile(join(serverState, "credentials.json"), "utf8")) as Record<
      string,
      unknown
    >;
  const store = async () => {
    const opened = new DrizzleStore({ url: `file:${databasePath}` });
    await opened.connect();
    return opened;
  };

  it("creates an account from env and file references, verifies it with the provider, and keeps values in the vault only", async () => {
    const path = await write("slack.yaml", account());
    expect(await run("apply", "-f", path)).toBe(
      "SurfaceAccount/acme-slack configured; verified slack account Acme (T123)\n",
    );
    expect(slackCalls).toEqual([{ method: "auth.test", token: BOT }]);

    const resource = await getSurfaceAccountResource(client.operator, "acme-slack");
    expect(resource.metadata["name"]).toBe("acme-slack");
    expect(resource.spec).toMatchObject({
      provider: "slack",
      externalAccountId: "T123",
      displayName: "Acme",
      authMethod: "slack-http",
      secrets: { botToken: { env: "ACME_BOT" }, signingSecret: { file: "signing.txt" } },
    });
    expect(JSON.stringify(resource)).not.toContain(BOT);
    // `list surface` reads the same account.
    expect(await run("list", "surface", "--output", "json")).toContain('"name": "acme-slack"');

    // The vault holds the values, exactly as setup would store them.
    expect(JSON.stringify(await vault())).toContain(BOT);
    expect(JSON.stringify(await vault())).toContain(SIGNING);
    // The database holds references and field ownership, never values.
    const database = await store();
    try {
      const stored = await database.findSurfaceAccountByName("acme-slack");
      const management = await database.findResourceManagement("SurfaceAccount", "acme-slack");
      expect(management?.fields["spec.secrets[botToken]"]).toEqual({
        manager: "apply",
        value: { env: "ACME_BOT" },
      });
      expect(management?.fields["spec.secrets[signingSecret]"]).toEqual({
        manager: "apply",
        value: { file: "signing.txt" },
      });
      for (const record of [stored, management]) {
        expect(JSON.stringify(record)).not.toContain(BOT);
        expect(JSON.stringify(record)).not.toContain(SIGNING);
      }
    } finally {
      await database.disconnect();
    }
    expect(await readFile(databasePath)).not.toContain(Buffer.from(BOT));
  });

  it("rejects the removed Connector names like any unknown name", async () => {
    const legacy = account().replace("kind: SurfaceAccount", "kind: ConnectorAccount");
    expect(await fail("apply", "-f", await write("legacy.yaml", legacy))).toMatch(
      /ConnectorAccount/,
    );
    expect(slackCalls).toEqual([]);

    errors.length = 0;
    await expect(main(["setup", "connector", "slack"])).resolves.toBe(1);
    expect(errors.join("")).toContain("Unknown surface: connector");
    expect(await fail("get", "connector")).toContain("Unknown resource kind: connector");
    expect(await fail("get", "connector-accounts")).toContain(
      "Unknown resource kind: connector-accounts",
    );

    const response = await fetch(`${runtime.url}/api/v1/connector-accounts`, {
      headers: { authorization: "Bearer test-administrative-token" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("deprecation")).toBeNull();

    const permissionSet = (permission: string) => `apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: legacy
spec:
  permissions:
${permission}`;
    expect(
      await fail(
        "apply",
        "-f",
        await write(
          "legacy-target.yaml",
          permissionSet(
            "    - target: connector\n      surfaceAccountId: acme-slack\n      scope: channel:C1\n      action: messages:write\n",
          ),
        ),
      ),
    ).toContain("target must be surface, runtime, or mcp");
    expect(
      await fail(
        "apply",
        "-f",
        await write(
          "legacy-field.yaml",
          permissionSet(
            "    - target: surface\n      connectorAccountId: acme-slack\n      scope: channel:C1\n      action: messages:write\n",
          ),
        ),
      ),
    ).toContain("surfaceAccountId");
  });

  it("exports references, never values, and the export applies without changes", async () => {
    await run("apply", "-f", await write("slack.yaml", account()));
    const exported = await run("get", "surface", "acme-slack", "--output", "yaml");
    expect(exported).toBe(
      [
        "apiVersion: supertag/v1",
        "kind: SurfaceAccount",
        "metadata:",
        "  name: acme-slack",
        "spec:",
        "  provider: slack",
        "  displayName: Acme",
        "  configuration:",
        "    transport: http",
        "  secrets:",
        "    botToken:",
        "      env: ACME_BOT",
        "    signingSecret:",
        "      file: signing.txt",
        "",
      ].join("\n"),
    );
    expect(await run("get", "surface", "--output", "yaml")).toBe(exported);
    const exportPath = await write("exported.yaml", exported);
    expect(await run("diff", "-f", exportPath)).toBe(
      [
        "No changes. The Control Plane matches the input.",
        "Plan: 0 to create, 0 to update, 0 to delete, 0 conflicts.",
        "Surface Account secret values are not read by diff. Apply compares them with the stored credentials and verifies and stores any that changed.",
        "",
      ].join("\n"),
    );
    expect(await run("apply", "-f", exportPath)).toBe(
      "SurfaceAccount/acme-slack configured; credentials unchanged\n",
    );
    expect(slackCalls).toHaveLength(1);
  });

  it("skips the provider when nothing changed and verifies and stores a rotated value", async () => {
    const path = await write("slack.yaml", account());
    await run("apply", "-f", path);
    const first = await getSurfaceAccountResource(client.operator, "acme-slack");

    expect(await run("apply", "-f", path)).toBe(
      "SurfaceAccount/acme-slack configured; credentials unchanged\n",
    );
    expect(slackCalls).toHaveLength(1);
    // Nothing was rewritten, so surface runtimes keep running.
    expect(
      (await getSurfaceAccountResource(client.operator, "acme-slack")).metadata.resourceVersion,
    ).toBe(first.metadata.resourceVersion);

    // Rotating the referenced value is detected at apply, verified, and stored.
    vi.stubEnv("ACME_BOT", "xoxb-rotated-value");
    expect(await run("apply", "-f", path)).toBe(
      "SurfaceAccount/acme-slack configured; verified slack account Acme (T123)\n",
    );
    expect(slackCalls.at(-1)).toEqual({ method: "auth.test", token: "xoxb-rotated-value" });
    expect(JSON.stringify(await vault())).toContain("xoxb-rotated-value");
    expect(JSON.stringify(await vault())).not.toContain(BOT);
  });

  it("diffs without reading secrets", async () => {
    const path = await write("slack.yaml", account());
    vi.stubEnv("ACME_BOT", "");
    await rm(join(directory, "signing.txt"));
    expect(await run("diff", "-f", path)).toBe(
      [
        "+ SurfaceAccount acme-slack   slack; apply reads and verifies its secrets",
        "Plan: 1 to create, 0 to update, 0 to delete, 0 conflicts.",
        "Surface Account secret values are not read by diff. Apply compares them with the stored credentials and verifies and stores any that changed.",
        "",
      ].join("\n"),
    );
    expect(slackCalls).toEqual([]);

    vi.stubEnv("ACME_BOT", BOT);
    await writeFile(join(directory, "signing.txt"), SIGNING);
    await run("apply", "-f", path);
    // A changed reference is a field change; the values behind it stay unread.
    vi.stubEnv("ACME_BOT", "");
    const moved = await write(
      "moved.yaml",
      account(
        "acme-slack",
        "    botToken: { env: SLACK_BOT_TOKEN }\n    signingSecret: { file: signing.txt }\n",
      ),
    );
    expect(await run("diff", "-f", moved)).toContain(
      '~ SurfaceAccount acme-slack   spec.secrets.botToken: {"env":"ACME_BOT"} -> {"env":"SLACK_BOT_TOKEN"}\nPlan: 0 to create, 1 to update',
    );
    expect(slackCalls).toHaveLength(1);
  });

  it("refuses literal secret values without echoing them", async () => {
    const literal = await write(
      "literal.yaml",
      account("acme-slack", "    botToken: xoxb-literal-value\n    signingSecret: { env: X }\n"),
    );
    const message = await fail("apply", "-f", literal);
    expect(message).toContain(
      "SurfaceAccount spec.secrets.botToken is a literal value. Manifests hold only references, never secret values: { secretRef: NAME }, { env: VARIABLE }, or { file: PATH }",
    );
    expect(message).not.toContain("xoxb-literal-value");
    expect(await fail("diff", "-f", literal)).toContain("is a literal value");

    const misplaced = await write(
      "misplaced.yaml",
      `apiVersion: supertag/v1
kind: SurfaceAccount
metadata: { name: acme-slack }
spec:
  provider: slack
  configuration: { botToken: xoxb-literal-value }
  secrets: { botToken: { env: A }, appToken: { env: B } }
`,
    );
    const misplacedMessage = await fail("apply", "-f", misplaced);
    expect(misplacedMessage).toContain("spec.configuration.botToken is a secret");
    expect(misplacedMessage).not.toContain("xoxb-literal-value");

    const twoForms = await write(
      "two.yaml",
      account("acme-slack", "    botToken: { env: A, file: b }\n    signingSecret: { env: X }\n"),
    );
    expect(await fail("apply", "-f", twoForms)).toContain(
      "spec.secrets.botToken must be exactly one of",
    );
    expect(slackCalls).toEqual([]);
  });

  it("fails apply with the provider's message and writes nothing when a credential is rejected", async () => {
    vi.stubEnv("ACME_BOT", "xoxb-rejected");
    const path = await write(
      "organization.yaml",
      `${account()}---\n${tag("[{ provider: slack, account: acme-slack, channelId: C0123 }]")}`,
    );
    const message = await fail("apply", "-f", path);
    expect(message).toContain("Nothing was applied.");
    expect(message).toContain(
      "SurfaceAccount/acme-slack: provider verification failed: Slack auth.test failed: invalid_auth",
    );
    expect(message).not.toContain("xoxb-rejected");
    expect((await listSurfaceAccountResources(client.operator)).items).toEqual([]);
    expect((await listResources(client, "tags")).items).toEqual([]);

    // Unset references fail the same way, naming the reference.
    vi.stubEnv("ACME_BOT", "");
    expect(await fail("apply", "-f", path)).toContain(
      "SurfaceAccount/acme-slack: spec.secrets.botToken: environment variable ACME_BOT is not set",
    );
  });

  it("applies a Tag whose location names an account created in the same apply, and plans it in diff", async () => {
    // An existing Tag gains a location on the new account: diff plans it without the account.
    await run("apply", "-f", await write("tag.yaml", tag("[]")));
    const path = await write(
      "organization.yaml",
      `${tag("[{ provider: slack, account: acme-slack, channelId: C0123 }]")}---\n${account()}`,
    );
    expect(await run("diff", "-f", path)).toContain(
      [
        "+ SurfaceAccount acme-slack   slack; apply reads and verifies its secrets",
        "~ Tag builder                 spec.locations: + slack:C0123",
      ].join("\n"),
    );
    expect(await run("apply", "-f", path)).toBe(
      [
        "SurfaceAccount/acme-slack configured; verified slack account Acme (T123)",
        "Tag/builder configured",
        "",
      ].join("\n"),
    );
    const builder = await getResource(client, "tags", "builder");
    // The Tag records the provider account it resolved, so its plan stays stable.
    expect(builder.spec.locations).toEqual([
      expect.objectContaining({ provider: "slack", account: "T123", channelId: "C0123" }),
    ]);
    expect(await run("diff", "-f", path)).toContain("No changes.");
  });

  it("resolves secretRef through the caller's resolver, as supertag.yaml provisioning does", async () => {
    const manifest = {
      apiVersion: "supertag/v1",
      kind: "SurfaceAccount",
      metadata: { name: "acme-slack" },
      spec: {
        provider: "slack",
        displayName: "Acme Engineering",
        configuration: { transport: "socket" },
        secrets: { botToken: { secretRef: "slack-bot" }, appToken: { secretRef: "slack-app" } },
      },
    };
    const builder = {
      apiVersion: "supertag/v1",
      kind: "Tag",
      metadata: { name: "builder" },
      spec: { locations: [{ provider: "slack", account: "acme-slack", channelId: "C0123" }] },
    };
    // `apply -f` has no resolver, so a secretRef needs supertag.yaml or another caller.
    const path = await write("socket.yaml", JSON.stringify(manifest));
    expect(await fail("apply", "-f", path)).toContain(
      "spec.secrets.appToken: secretRef slack-app needs a secret resolver, such as the secrets map in supertag.yaml. With supertag apply -f, use { env: VARIABLE } or { file: PATH }",
    );

    const resolved: string[] = [];
    const resolveSecret = async (name: string) => {
      resolved.push(name);
      if (name === "slack-bot") return "xoxb-from-resolver";
      if (name === "slack-app") return "xapp-from-resolver";
      throw new Error(`no secret named ${name}`);
    };
    const verified: Record<string, string>[] = [];
    const verifySurface = async (
      _manifest: unknown,
      secrets: Readonly<Record<string, string>>,
    ): Promise<VerifiedSurfaceAccount> => {
      verified.push({ ...secrets });
      return {
        provider: "slack",
        externalAccountId: "T777",
        displayName: "Acme Engineering",
        authMethod: "slack-socket-mode",
        configuration: { transport: "socket", botId: "B1", botUserId: "U1" },
        secrets: { ...secrets },
      };
    };
    // Provider verification runs on the Control Plane, which this one fakes.
    await runtime.close();
    runtime = await startRuntime({ verifySurface });
    client = new ControlPlaneClient({ url: runtime.url, token });
    expect(
      await applyManifests(client, [builder, manifest], {
        source: "supertag.yaml provision",
        resolveSecret,
      }),
    ).toBe(
      [
        "SurfaceAccount/acme-slack configured; verified slack account Acme Engineering (T777)",
        "Tag/builder configured",
        "",
      ].join("\n"),
    );
    expect(resolved.toSorted()).toEqual(["slack-app", "slack-bot"]);
    expect(verified).toEqual([{ appToken: "xapp-from-resolver", botToken: "xoxb-from-resolver" }]);
    expect((await getSurfaceAccountResource(client.operator, "acme-slack")).spec).toMatchObject({
      secrets: { appToken: { secretRef: "slack-app" }, botToken: { secretRef: "slack-bot" } },
    });

    // A plan never calls the resolver.
    resolved.length = 0;
    expect(
      await applyManifests(client, [builder, manifest], { command: "diff", resolveSecret }),
    ).toContain("No changes.");
    expect(resolved).toEqual([]);

    // A resolver failure names the reference.
    const missing = {
      ...manifest,
      spec: {
        ...manifest.spec,
        secrets: { ...manifest.spec.secrets, appToken: { secretRef: "nope" } },
      },
    };
    await expect(
      applyManifests(client, [missing], { source: "supertag.yaml provision", resolveSecret }),
    ).rejects.toThrow(
      "Nothing was applied. Invalid manifests:\n  supertag.yaml provision: SurfaceAccount/acme-slack: spec.secrets.appToken: secretRef nope could not be resolved: no secret named nope",
    );
  });

  it("refuses deletion while a Tag location names the account, then retires it and removes its credential", async () => {
    const path = await write(
      "organization.yaml",
      `${account()}---\n${tag("[{ provider: slack, account: acme-slack, channelId: C0123 }]")}`,
    );
    await run("apply", "-f", path);
    expect(await fail("delete", "surface", "acme-slack")).toBe(
      "surface acme-slack is in use by Tag builder (location slack:C0123).",
    );
    expect(await fail("delete", "surface", "acme-slack", "--dry-run")).toContain("is in use");

    await run("apply", "-f", await write("tag.yaml", tag("[]")));
    expect(await run("delete", "surface", "acme-slack", "--dry-run")).toBe(
      [
        "Dry run: Surface Account acme-slack would be retired. Nothing was changed.",
        "Would remove with it:",
        "  its stored credential",
        "slack account Acme (T123) stops receiving events. Replies still pending through it fail.",
        "",
      ].join("\n"),
    );
    expect(await run("delete", "surface", "acme-slack")).toBe(
      [
        "Surface Account acme-slack retired. Its history is kept.",
        "Removed with it:",
        "  its stored credential",
        "slack account Acme (T123) stops receiving events. Replies still pending through it fail.",
        "",
      ].join("\n"),
    );
    expect(JSON.stringify(await vault())).not.toContain(BOT);
    expect((await listSurfaceAccountResources(client.operator)).items).toEqual([]);
    expect(await fail("get", "surface", "acme-slack")).toContain("does not exist");

    // Applying the manifest again reconnects the same provider account under the name.
    expect(await run("apply", "-f", await write("slack.yaml", account()))).toContain(
      "verified slack account Acme (T123)",
    );
  });

  it("prunes a Surface Account its set no longer declares", async () => {
    await run(
      "apply",
      "-f",
      await write("set.yaml", `${account()}---\n${tag("[]")}`),
      "--set",
      "team",
    );
    const remaining = await write("remaining.yaml", tag("[]"));
    expect(await run("diff", "-f", remaining, "--set", "team", "--prune")).toContain(
      "- SurfaceAccount acme-slack",
    );
    expect(await run("apply", "-f", remaining, "--set", "team", "--prune")).toBe(
      "Tag/builder configured\nSurfaceAccount/acme-slack deleted\n",
    );
    expect((await listSurfaceAccountResources(client.operator)).items).toEqual([]);
  });

  it("adopts an account set up interactively and refuses to move a name to another account", async () => {
    await client.setupSurface({
      provider: "slack",
      externalAccountId: "T123",
      displayName: "Acme",
      authMethod: "slack-http",
      configuration: { transport: "http" },
      secrets: { botToken: "xoxb-interactive", signingSecret: "interactive-signing" },
    });
    // An interactive account has no references to export.
    expect(await fail("get", "surface", "slack:T123", "--output", "yaml")).toContain(
      "was set up with supertag setup surface, so it has no manifest or secret references to export",
    );
    expect(await run("get", "surface", "--output", "yaml")).toBe("");

    const before = await getSurfaceAccountResource(client.operator, "slack:T123");
    await run("apply", "-f", await write("slack.yaml", account()));
    const adopted = await getSurfaceAccountResource(client.operator, "acme-slack");
    expect(adopted.metadata.id).toBe(before.metadata.id);
    expect(JSON.stringify(await vault())).not.toContain("xoxb-interactive");

    // A second manifest for the same provider account is refused before anything is written.
    expect(await fail("apply", "-f", await write("twin.yaml", account("twin-slack")))).toContain(
      "slack account T123 is already declared as SurfaceAccount acme-slack",
    );
    // Credentials for another workspace cannot move the name.
    slackTeam = { team: "Other", team_id: "T999" };
    vi.stubEnv("ACME_BOT", "xoxb-other-workspace");
    expect(await fail("apply", "-f", await write("slack.yaml", account()))).toContain(
      "acme-slack is slack account T123, but its credentials belong to T999",
    );
  });
});
