import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLocalAdminToken } from "../apps/cli/src/control-plane-client.ts";
import {
  type ControlPlaneRuntimeHandle,
  startControlPlaneRuntime,
} from "../apps/cli/src/control-plane-runtime.ts";
import { detectHarnesses, probeHarnessSignIn } from "../apps/cli/src/harnesses.ts";
import { main } from "../apps/cli/src/index.ts";
import { detectRepository, initHelp, initialize, workspaceNameFor } from "../apps/cli/src/init.ts";
import { harnessCredentialsFromEnvFile } from "../apps/cli/src/local-process.ts";
import { controlPlaneSlot, hostSlot, runningProcess } from "../apps/cli/src/local-state.ts";
import { loadServicesFile } from "../apps/cli/src/supertag-yaml.ts";
import { bringDown, type UpOptions, type UpResult } from "../apps/cli/src/up.ts";
import { migrateSqlite } from "./support/database.ts";
import {
  api,
  CLI,
  fakeHarness,
  git,
  repository,
  TIMEOUT,
  useServicesContext,
  writeServices,
} from "./support/services.ts";

vi.mock("../apps/cli/src/harnesses.ts", async (original) => ({
  ...(await original<typeof import("../apps/cli/src/harnesses.ts")>()),
  probeHarnessSignIn: vi.fn(async () => true),
}));

// Under a busy full-suite run these tests can exceed vitest's 5-second default timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const context = useServicesContext();
const printed = () => context.printed();
beforeEach(() => vi.mocked(probeHarnessSignIn).mockReset().mockResolvedValue(true));

describe("supertag init", () => {
  it("finishes the sandbox explanation in help", () => {
    expect(initHelp()).toContain("prints how to turn the sandbox back on.");
  });
  const scripted = (...answers: string[]) => {
    const input = new PassThrough();
    input.end(answers.map((answer) => `${answer}\n`).join(""));
    const shown: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => shown.push(String(chunk)));
    return { input, output: stream, shown };
  };

  /** A Control Plane in this process for `up control-plane`; bringing up everything is recorded. */
  const inProcess = () => {
    let runtime: ControlPlaneRuntimeHandle | undefined;
    const calls: UpOptions[] = [];
    const start = async (options: UpOptions): Promise<UpResult> => {
      calls.push(options);
      const file = await loadServicesFile();
      if (runtime === undefined) {
        const database = join(context.directory, "in-process.db");
        await migrateSqlite(database);
        runtime = await startControlPlaneRuntime({
          host: "127.0.0.1",
          port: 0,
          databaseUrl: `file:${database}`,
          adminToken: await ensureLocalAdminToken(),
          coordinationOperatorCredentials: [],
          workletTransport: "remote",
          stateDirectory: join(context.directory, "in-process"),
          reply: async () => {},
        });
        const opened = runtime;
        context.cleanups.push(() => opened.close());
        vi.stubEnv("SUPERTAG_CONTROL_PLANE", runtime.url);
        vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", await ensureLocalAdminToken());
      }
      return {
        file,
        services: [
          {
            service: "control-plane",
            kind: "control-plane",
            action: "started",
            status: {
              pid: 1,
              mode: "background",
              state: "ready",
              startedAt: "",
              configuration: "",
              url: runtime.url,
            },
          },
        ],
      };
    };
    return { start, calls };
  };

  it("refuses readiness and writes nothing when the bundled harness cannot sign in", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    vi.mocked(probeHarnessSignIn).mockResolvedValue(false);
    const start = vi.fn();
    await expect(initialize({ cwd: root, yes: true, start })).rejects.toThrow(
      /cli_auth_credentials_store/,
    );
    expect(start).not.toHaveBeenCalled();
    expect(printed()).not.toContain("SuperTag is ready");
    await expect(stat(join(context.state, "supertag.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("probes only credentials the background Worker Host receives from env_file", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    await mkdir(context.state, { recursive: true });
    await writeFile(
      join(context.state, ".env"),
      "CODEX_API_KEY=from-file\nUNRELATED_SECRET=hidden\n",
    );
    await initialize({ cwd: root, yes: true, start: inProcess().start });
    const environment = vi.mocked(probeHarnessSignIn).mock.calls[0]?.[2];
    expect(environment?.["CODEX_API_KEY"]).toBe("from-file");
    expect(environment?.["UNRELATED_SECRET"]).toBeUndefined();
  });

  it("gives the Worker Host CURSOR_API_KEY from env_file", () => {
    expect(
      harnessCredentialsFromEnvFile({ CURSOR_API_KEY: "from-file", UNRELATED_SECRET: "x" }, {}),
    ).toEqual({ CURSOR_API_KEY: "from-file" });
    expect(
      harnessCredentialsFromEnvFile({ CURSOR_API_KEY: "from-file" }, { CURSOR_API_KEY: "shell" }),
    ).toEqual({});
  });

  it("probes the service unit environment when an existing host restarts as a unit", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    await initialize({ cwd: root, yes: true, start: inProcess().start });
    const path = join(context.state, "supertag.yaml");
    const yaml = await readFile(path, "utf8");
    await writeFile(path, yaml.replace("type: host", "type: host\n    restart: unless-stopped"));
    await writeFile(join(context.state, ".env"), "CODEX_API_KEY=service-file\n");
    vi.stubEnv("CODEX_API_KEY", "shell-only");
    vi.stubEnv("ANTHROPIC_API_KEY", "shell-only");
    vi.mocked(probeHarnessSignIn).mockClear();
    await initialize({ cwd: root, yes: true, start: inProcess().start });
    expect(vi.mocked(probeHarnessSignIn).mock.calls[0]?.[2]?.["CODEX_API_KEY"]).toBe(
      "service-file",
    );
    expect(vi.mocked(probeHarnessSignIn).mock.calls[0]?.[2]?.["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("checks an existing setup again without changing its configuration on failure", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    await initialize({ cwd: root, yes: true, start: inProcess().start });
    const path = join(context.state, "supertag.yaml");
    const previous = await readFile(path, "utf8");
    context.output.length = 0;
    vi.mocked(probeHarnessSignIn).mockResolvedValue(false);
    const start = vi.fn();
    await expect(initialize({ cwd: root, yes: true, start })).rejects.toThrow(
      /No selected harness/,
    );
    expect(start).not.toHaveBeenCalled();
    expect(printed()).not.toContain("SuperTag is ready");
    expect(await readFile(path, "utf8")).toBe(previous);
  });

  it("labels both sign-in states and allows a working selected harness", async () => {
    await fakeHarness(context, "claude", "codex");
    const root = await repository(context, "app");
    vi.mocked(probeHarnessSignIn).mockImplementation(async (harness) => harness === "codex");
    const answers = scripted(...Array<string>(12).fill(""));
    await initialize({
      cwd: root,
      interactive: true,
      input: answers.input,
      output: answers.output,
      start: inProcess().start,
    });
    const output = answers.shown.join("") + printed();
    expect(output).toContain("claude-code (claude), not signed in");
    expect(output).toContain("codex (codex), signed in");
    expect(output).toContain("run claude and use /login");
    expect(output.match(/run claude and use \/login/g)).toHaveLength(1);
    expect(output).toContain("Choose numbers separated by commas [2]:");
    expect((await loadServicesFile()).services[1]).toMatchObject({ harnesses: ["codex"] });
    expect(output).toContain("SuperTag is ready");
  });

  it("prints unsigned harness guidance once when no selection can sign in", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    vi.mocked(probeHarnessSignIn).mockResolvedValue(false);
    const answers = scripted(...Array<string>(12).fill(""));
    const error = await initialize({ cwd: root, interactive: true, ...answers }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("No selected harness could complete the sign-in check");
    expect(
      (answers.shown.join("") + printed() + String(error)).match(
        /cli_auth_credentials_store="file"' login, or set/g,
      ),
    ).toHaveLength(1);
  });

  const occupiedPort = async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    context.cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No port");
    return address.port;
  };

  it("re-asks for an occupied port before the database question", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    const port = await occupiedPort();
    vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
    const fake = inProcess();
    const answers = scripted(String(port), "0", "", "", "", "", "", "");
    expect(
      (await initialize({ cwd: root, interactive: true, ...answers, start: fake.start })).state,
    ).toBe("ready");
    const prompts = answers.shown.join("");
    expect(prompts).toContain(`Port ${port} on 127.0.0.1 is in use`);
    expect(prompts.indexOf("is in use")).toBeLessThan(prompts.indexOf("Database ("));
    expect(prompts).not.toContain("supertag.yaml");
    expect(fake.calls).toHaveLength(2);
    expect((await stat(join(context.state, "supertag.yaml"))).mode & 0o777).toBe(0o600);
  });

  it("--yes recovers a partial setup by saving the next free port", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    const port = await occupiedPort();
    vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
    await writeServices(
      context,
      `services:\n  control-plane:\n    type: control-plane\n    ports: ["${port}"]\n`,
    );
    const fake = inProcess();
    const result = await initialize({ cwd: root, yes: true, start: fake.start });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.answers.port).toBeGreaterThan(port);
    expect((await loadServicesFile()).services[0]).toMatchObject({
      ports: { port: result.answers.port },
    });
    expect(printed()).toContain(`Port ${port} is in use; using ${result.answers.port}`);
  });

  it("preserves existing YAML when an environment port is occupied", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    const port = await occupiedPort();
    vi.stubEnv("SUPERTAG_GATEWAY_PORT", String(port));
    const original = 'services:\n  control-plane:\n    type: control-plane\n    ports: ["0"]\n';
    const path = await writeServices(context, original);
    const fake = inProcess();
    await expect(initialize({ cwd: root, yes: true, start: fake.start })).rejects.toThrow(
      /Unset SUPERTAG_GATEWAY_PORT or choose a free port/,
    );
    expect(fake.calls).toHaveLength(0);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("checks for a harness first and changes nothing when none is installed", async () => {
    const root = await repository(context, "app");
    await expect(initialize({ cwd: root, yes: true })).rejects.toThrow(
      /No harness is available[\s\S]*npm install -g @anthropic-ai\/claude-code[\s\S]*npm install -g @openai\/codex[\s\S]*Cursor {7}Add CURSOR_API_KEY[\s\S]*npm install -g opencode-ai[\s\S]*Then run supertag init again\./,
    );
    // Even before it checks for a terminal.
    await expect(initialize({ cwd: root, interactive: false })).rejects.toThrow(
      /No harness is available/,
    );
    await expect(main(["init", "--yes"])).rejects.toThrow(/No harness is available/);
    await expect(stat(context.state)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([".git"]);
  });

  it("stops under --yes when OpenCode is the only harness, asking for a model", async () => {
    await fakeHarness(context, "opencode");
    const root = await repository(context, "app");
    await expect(initialize({ cwd: root, yes: true })).rejects.toThrow(
      /OpenCode is the only harness on this machine, and it needs a model\. Run supertag init in a terminal, without --yes, to enter one as provider\/model/,
    );
    await expect(stat(context.state)).rejects.toMatchObject({ code: "ENOENT" });
    // With a terminal it asks for the model.
    const fake = inProcess();
    const answers = scripted("", "", "1", "openai/some-model", "", "", "", "", "", "");
    await initialize({
      cwd: root,
      interactive: true,
      input: answers.input,
      output: answers.output,
      start: fake.start,
      hostname: "studio",
    });
    expect(answers.shown.join("")).toContain("OpenCode model, as provider/model: ");
    expect((await loadServicesFile()).services[1]).toMatchObject({
      name: "studio",
      harnesses: ["opencode"],
      models: { opencode: ["openai/some-model"] },
    });
  });

  it("needs --yes without a terminal once a harness is installed", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    await expect(initialize({ cwd: root, interactive: false })).rejects.toThrow(
      /needs a terminal[\s\S]*--yes/,
    );
    await expect(stat(context.state)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it(
    "--yes writes the services file, brings up both services, creates resources, and binds the host",
    async () => {
      await fakeHarness(context, "codex");
      const root = await repository(context, "shop", "git@github.com:acme/shop.git");
      const result = await initialize({
        cwd: root,
        yes: true,
        up: { cliCommand: CLI },
        hostname: "Studio-Mac.local",
      });
      expect(result.state).toBe("ready");
      if (result.state !== "ready") return;
      expect(result.hostService).toBe("studio-mac");
      const text = printed();
      expect(text).toContain(`Wrote ${join(context.state, "supertag.yaml")}.`);
      expect(text).toMatch(
        /\nStarted the local Control Plane in the background at http:\/\/127\.0\.0\.1:\d+ \(process \d+\)\.\n\+ Workspace shop\n/,
      );
      expect(text).toMatch(
        /\nStarted host service studio-mac in the background \(process \d+\)\.\nWorker Host studio-mac connected; Workers registered: local-codex\.\nBound Worker Host studio-mac to Tag lead\.\n/,
      );
      // Each service is reported once, without up's full report.
      expect(text.match(/local Control Plane (in|already)/g)).toHaveLength(1);
      expect(text).not.toContain("left alone");
      expect(text).toContain(
        '--outcome "Search returns results in under 200 ms. Done when the benchmark passes."',
      );
      expect(text).not.toContain("Replace each <...>");
      expect(text).not.toContain("Control Plane ready at");
      expect(text).not.toContain("Follow its logs");
      expect(text).toContain("+ Workspace shop");
      expect(text).toContain("+ Permission Set local-tools");
      expect(text).toContain("+ Role Lead");
      expect(text).toContain("+ Tag lead");
      expect(text).toContain("Host service studio-mac: Enrolled as Worker Host studio-mac");
      expect(text).toContain("Bound Worker Host studio-mac to Tag lead.");
      expect(text).toMatch(/Worker Host studio-mac connected; Workers registered: local-codex\./);
      expect(text).toContain("supertag create objective --owner lead --workspace shop --outcome");
      expect(text).toContain("add restart: unless-stopped to both services");
      expect(text).not.toContain(await ensureLocalAdminToken());

      // supertag.yaml names the host after the machine; nothing is written in the repository.
      const written = await readFile(join(context.state, "supertag.yaml"), "utf8");
      expect(written).not.toContain("yaml-language-server");
      expect(written).toMatch(
        /services:\n {2}control-plane:\n {4}type: control-plane\n {4}ports: \["0"\]\n {2}studio-mac:\n {4}type: host\n {4}harnesses: \[codex\]\n {4}workspaces:\n {6}shop: /u,
      );
      expect(await readdir(root)).toEqual([".git"]);

      expect((await api("/api/v1/workspaces/shop")).spec).toMatchObject({
        source: "git@github.com:acme/shop.git",
        ref: "main",
        delivery: "branch",
      });
      expect((await api("/api/v1/tags/lead")).spec).toMatchObject({
        roles: ["Lead"],
        workerHosts: ["studio-mac"],
      });
      expect((await api("/api/v1/worker-hosts/studio-mac")).status).toMatchObject({
        connectionStatus: "connected",
        workspaces: ["shop"],
      });

      // Init's starter fields have their own owner, and a changed value explains adoption.
      const roleManifest = join(context.directory, "role.yaml");
      await writeFile(
        roleManifest,
        "apiVersion: supertag/v1\nkind: Role\nmetadata:\n  name: Lead\nspec:\n  purpose: Ship changes.\n",
      );
      context.output.length = 0;
      expect(await main(["diff", "-f", roleManifest, "--set", "team"])).toBe(0);
      expect(printed()).toContain("spec.purpose owned by init");
      expect(printed()).toContain("supertag apply -f FILE --set NAME --force-conflicts");
      context.output.length = 0;

      // A manifest change to the Tag survives a rerun, which leaves both services alone.
      await writeFile(
        join(context.directory, "tag.yaml"),
        "apiVersion: supertag/v1\nkind: Tag\nmetadata:\n  name: lead\nspec:\n  roles: [Lead]\n  runsOn: [harness:codex]\n",
      );
      expect(await main(["apply", "-f", join(context.directory, "tag.yaml")])).toBe(0);
      const controlPlanePid = (await runningProcess(controlPlaneSlot())).pid;
      const hostPid = (await runningProcess(hostSlot("studio-mac"))).pid;
      context.output.length = 0;
      await initialize({ cwd: root, yes: true, up: { cliCommand: CLI }, hostname: "other" });
      expect(printed()).toContain("SuperTag is already set up on this machine:");
      expect(printed()).toMatch(
        /Host service studio-mac: codex; \d+ Task Attempts per harness at once \(from this machine\); Workspaces shop/u,
      );
      expect(printed()).not.toContain("+ ");
      expect(printed()).not.toContain("Wrote ");
      expect(printed()).toMatch(
        /\nThe local Control Plane already runs in the background at http:\/\/127\.0\.0\.1:\d+ \(process \d+\)\.\nHost service studio-mac already runs in the background \(process \d+\)\.\n/,
      );
      expect(printed().match(/local Control Plane (in|already)/g)).toHaveLength(1);
      expect((await runningProcess(controlPlaneSlot())).pid).toBe(controlPlanePid);
      expect((await runningProcess(hostSlot("studio-mac"))).pid).toBe(hostPid);
      expect((await api("/api/v1/tags/lead")).spec).toMatchObject({
        runsOn: ["harness:codex"],
        workerHosts: ["studio-mac"],
      });

      // In another repository, init adds a Workspace to the same host service and restarts it.
      const docs = await repository(context, "docs");
      context.output.length = 0;
      await initialize({ cwd: docs, yes: true, up: { cliCommand: CLI } });
      expect(printed()).toContain("+ Workspace docs");
      expect(printed()).toContain(
        "Host service studio-mac: workspaces changed, so SuperTag restarts it.",
      );
      expect(printed()).toMatch(
        /\nRestarted host service studio-mac in the background \(process \d+\)\.\n/,
      );
      expect((await runningProcess(controlPlaneSlot())).pid).toBe(controlPlanePid);
      const host = (await loadServicesFile()).services[1];
      expect(host).toMatchObject({ name: "studio-mac", workspaces: { shop: root, docs } });
      expect(await readdir(docs)).toEqual([".git"]);
      expect((await api("/api/v1/worker-hosts/studio-mac")).status).toMatchObject({
        workspaces: expect.arrayContaining(["docs", "shop"]),
      });
      await bringDown({ write: () => {} });
    },
    TIMEOUT,
  );

  it("asks each question with its default, and reruns change only what is chosen", async () => {
    // The environment overrides the file; without it, the file's port is the default.
    vi.stubEnv("SUPERTAG_GATEWAY_PORT", undefined);
    await fakeHarness(context, "claude", "codex", "opencode");
    const root = await repository(context, "web", "https://github.com/acme/web.git");
    const fake = inProcess();
    // Port; default database; codex and opencode; an invalid then a valid model; allow OpenCode
    // to run commands unsandboxed; this directory; Workspace name; pull-request delivery; Tag
    // builder; read only.
    const answers = scripted(
      "4555",
      "",
      "2,3",
      "some-model",
      "anthropic/some-model",
      "",
      "",
      "site",
      "3",
      "builder",
      "1",
    );
    await initialize({
      cwd: root,
      interactive: true,
      input: answers.input,
      output: answers.output,
      start: fake.start,
      hostname: "laptop",
    });
    const shown = answers.shown.join("");
    expect(shown).toContain("Port [3434]: ");
    expect(shown).toContain("Harnesses this machine serves");
    expect(shown).toContain("1) claude-code (claude)");
    expect(shown).toContain("Choose numbers separated by commas [1,2]: ");
    expect(shown).toContain("Enter the model OpenCode should use as provider/model");
    expect(shown).toContain("Allow opencode to run commands without a sandbox? [Y/n]: ");
    expect(shown).toContain(`Directory to work in [${root}]: `);
    expect(shown).toContain("Workspace name [web]: ");
    expect(shown).toContain("3) pull-request: open a draft pull request on GitHub for each Task");
    expect(shown).toContain("Name [lead]: ");
    expect(shown).toContain("3) Edit files, run commands, and open pull requests");
    expect(await readFile(join(context.state, "supertag.yaml"), "utf8")).toContain(
      'ports: ["4555"]\n',
    );
    expect((await loadServicesFile()).services[1]).toMatchObject({
      name: "laptop",
      harnesses: ["codex", "opencode"],
      allowUnsandboxedCommands: ["opencode"],
      models: { opencode: ["anthropic/some-model"] },
      workspaces: { site: root },
    });
    // The Control Plane comes up first, then everything.
    expect(fake.calls.map((call) => call.names)).toEqual([["control-plane"], undefined]);
    expect((await api("/api/v1/workspaces/site")).spec).toMatchObject({
      delivery: "pull-request",
    });
    expect((await api("/api/v1/permission-sets/local-tools")).spec).toMatchObject({
      permissions: [],
    });
    expect(printed()).toContain("Opening pull requests also needs a GitHub surface");
    expect(printed()).toContain("--owner builder --workspace site --outcome");

    // Exit changes nothing.
    const before = await readFile(join(context.state, "supertag.yaml"), "utf8");
    const exit = scripted("3");
    await expect(
      initialize({
        cwd: root,
        interactive: true,
        input: exit.input,
        output: exit.output,
        start: fake.start,
      }),
    ).resolves.toEqual({ state: "exited" });
    expect(exit.shown.join("")).toContain("1) Keep it, and make sure everything is running");
    expect(await readFile(join(context.state, "supertag.yaml"), "utf8")).toBe(before);
    expect(fake.calls).toHaveLength(2);

    // Change: the current answers are the defaults; only the access changes.
    context.output.length = 0;
    const change = scripted("2", "", "", "", "", "", "", "", "", "builder", "2");
    await initialize({
      cwd: root,
      interactive: true,
      input: change.input,
      output: change.output,
      start: fake.start,
    });
    expect(change.shown.join("")).toContain("Port [4555]: ");
    expect(change.shown.join("")).toContain(
      "OpenCode model, as provider/model [anthropic/some-model]: ",
    );
    expect(printed()).toContain("~ Permission Set local-tools");
    expect(printed()).not.toContain("+ Tag");
    expect((await api("/api/v1/permission-sets/local-tools")).spec).toMatchObject({
      permissions: expect.arrayContaining([
        expect.objectContaining({ target: "runtime", action: "files:write" }),
        expect.objectContaining({ target: "runtime", action: "commands:execute" }),
      ]),
    });
    expect(await readFile(join(context.state, "supertag.yaml"), "utf8")).toBe(before);
  });

  it("explains unsandboxed harnesses and writes allow-unsandboxed-commands", async () => {
    await fakeHarness(context, "claude", "codex");
    const root = await repository(context, "app");
    // --yes opts in for Claude Code and says how to undo it.
    await initialize({ cwd: root, yes: true, start: inProcess().start, hostname: "laptop" });
    expect(printed()).toContain(
      "  Allowed claude-code to run commands without a sandbox (allow-unsandboxed-commands in supertag.yaml); remove it there and run supertag up to undo.\n",
    );
    const written = await readFile(join(context.state, "supertag.yaml"), "utf8");
    expect(written).toContain(
      "    harnesses: [claude-code, codex]\n    allow-unsandboxed-commands: [claude-code]\n",
    );
    expect((await loadServicesFile()).services[1]).toMatchObject({
      harnesses: ["claude-code", "codex"],
      allowUnsandboxedCommands: ["claude-code"],
    });

    // Interactively it explains the trade-off and asks; answering no removes the field.
    const change = scripted("2", "", "", "", "n", "", "", "", "", "");
    await initialize({
      cwd: root,
      interactive: true,
      input: change.input,
      output: change.output,
      start: inProcess().start,
    });
    const shown = change.shown.join("");
    expect(printed()).toContain(
      "claude-code runs commands as you, without a sandbox, so give its Tags only trusted work. Codex sandboxes its commands.\n",
    );
    expect(shown).toContain("Allow claude-code to run commands without a sandbox? [Y/n]: ");
    expect(printed()).toContain(
      "  Tasks that run commands will not run on claude-code. To allow it later, add it to allow-unsandboxed-commands in supertag.yaml.\n",
    );
    expect(await readFile(join(context.state, "supertag.yaml"), "utf8")).not.toContain(
      "allow-unsandboxed-commands",
    );
    expect((await loadServicesFile()).services[1]).toMatchObject({ allowUnsandboxedCommands: [] });

    // Accepting the default writes it again.
    const accept = scripted("2", "", "", "", "", "", "", "", "", "");
    await initialize({
      cwd: root,
      interactive: true,
      input: accept.input,
      output: accept.output,
      start: inProcess().start,
    });
    expect((await loadServicesFile()).services[1]).toMatchObject({
      allowUnsandboxedCommands: ["claude-code"],
    });
  });

  it("refuses to replace a shared Control Plane setup", async () => {
    await fakeHarness(context, "codex");
    const root = await repository(context, "app");
    await writeServices(
      context,
      "services:\n  laptop:\n    type: host\n    control-plane: https://supertag.example.com\n    harnesses: [codex]\n",
    );
    await expect(initialize({ cwd: root, yes: true })).rejects.toThrow(
      /connects host service laptop to a shared Control Plane at https:\/\/supertag\.example\.com/,
    );
  });

  it("detects the repository and harness sign-in", async () => {
    const root = await repository(
      context,
      "checkout",
      "https://user:secret@github.com/Acme/Web.App.git",
    );
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    await expect(detectRepository(root)).resolves.toEqual({
      root,
      name: "web-app",
      source: "https://github.com/Acme/Web.App.git",
      ref: "develop",
      hasCommits: true,
    });
    expect(workspaceNameFor("git@github.com:acme/api.git", "/x/y")).toBe("api");
    await expect(detectRepository(context.directory)).rejects.toThrow("inside a git repository");
    await fakeHarness(context, "codex", "cursor-agent", "opencode", "agent");
    await writeFile(join(context.bin, "claude"), "not executable", { mode: 0o644 });
    await expect(detectHarnesses()).resolves.toEqual(["codex", "cursor", "opencode"]);
  });
});
