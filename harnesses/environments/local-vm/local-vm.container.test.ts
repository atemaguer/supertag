import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_DROP_THEN_EXEC,
  CODEX_HOME,
  containerDockerfile,
  containerSandboxProvider,
  EGRESS_RELAY_PROGRAM,
  nativePlatform,
  type SandboxOwner,
  type SandboxWorkspaceSession,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { sandboxProviderConformance } from "@supertag/worker-sdk/internal/rust-workspace-provider/conformance";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE_DOCKERFILE, createLocalVmWorkspaceSession, localVmOptions } from "./src/index.js";

// The local-vm provider against real containers on this machine's runtime, with the base image
// it builds itself. Building the image needs the network once; set SUPERTAG_TEST_LOCAL_VM=1 to
// run these, and SUPERTAG_TEST_REQUIRE_CONTAINER=1 to fail where no runtime answers.
const runtime = process.env["SUPERTAG_TEST_CONTAINER_RUNTIME"] ?? "docker";
const wanted = process.env["SUPERTAG_TEST_LOCAL_VM"] === "1";
const answers =
  wanted && spawnSync(runtime, ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
if (wanted && !answers && process.env["SUPERTAG_TEST_REQUIRE_CONTAINER"] === "1")
  throw new Error(`${runtime} is required for the local-vm provider`);
const options = { ...localVmOptions({}), runtime };
// local-vm refuses Podman; its CI leg runs the suite anyway, to show when Podman reaches parity.
const testing = { allowPodman: runtime === "podman" };
const BUILD_MS = 20 * 60_000;

function owner(): SandboxOwner {
  return {
    hostId: HOST,
    hostGeneration: 1n,
    taskId: randomUUID(),
    attemptId: randomUUID(),
    allocationId: randomUUID(),
  };
}

/** This run's own host: another run on the same runtime, at the same time, has another. */
const HOST = `local-vm-test-${randomUUID().slice(0, 8)}`;

/** This file's containers of `host`: another run on the same runtime keeps its own. */
function ownedContainers(host = HOST): string[] {
  const listed = spawnSync(
    runtime,
    [
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      "label=supertag.local-vm=1",
      "--filter",
      `label=supertag.hostId=${host}`,
    ],
    { encoding: "utf8" },
  );
  return listed.stdout.split("\n").filter(Boolean);
}

describe.skipIf(!answers)("local-vm provider", () => {
  const provider = containerSandboxProvider({
    name: "local-vm",
    label: "supertag.local-vm",
    runtime,
    image: options.image,
    user: options.user,
    buildImages: true,
    dependencyCaches: true,
    runFlags: ["--memory", options.memory],
    // Image builds report their progress, and a failed build its output, in the test log.
    log: (line) => console.error(line),
  });

  beforeAll(async () => {
    // The first allocation builds the base image; the cases after it reuse it.
    const first = owner();
    const workspace = await provider.allocate(first, 60_000, AbortSignal.timeout(BUILD_MS));
    await provider.stop(first, workspace.sandboxId);
  }, BUILD_MS);

  /**
   * No capability in any set a Task process could use. The sets are reported before the
   * assertion, so a runtime that hands the Workspace user capabilities shows which.
   */
  async function expectNoCapabilities(
    run: (script: string) => Promise<{ stdout: string }>,
    path: string,
  ): Promise<void> {
    const sets = (await run("grep -E '^Cap(Inh|Prm|Eff|Amb)' /proc/self/status")).stdout.trim();
    console.error(`Task capability sets on ${runtime}, ${path}:\n${sets}`);
    expect(sets.split("\n"), sets).toHaveLength(4);
    for (const line of sets.split("\n")) expect(line, sets).toMatch(/\s0{16}$/u);
  }

  it("runs Task processes as an unprivileged user with no capabilities and no network", async () => {
    const who = owner();
    const workspace = await provider.allocate(who, 60_000, AbortSignal.timeout(60_000));
    try {
      const run = (script: string) =>
        workspace.run(["sh", "-c", script], 30_000, AbortSignal.timeout(30_000));
      expect((await run("id -u")).stdout.trim()).toBe("1000");
      // What the runtime itself gives its user, before the drop: reported only, to show a
      // runtime's behaviour (rootless Podman's) in CI.
      const raw = spawnSync(
        runtime,
        ["exec", workspace.sandboxId, "grep", "-E", "^Cap(Inh|Prm|Eff|Amb)", "/proc/self/status"],
        { encoding: "utf8" },
      );
      console.error(`Runtime exec capability sets on ${runtime}, before the drop:\n${raw.stdout}`);
      await expectNoCapabilities(run, "through the exec server");
      expect((await run("grep NoNewPrivs /proc/self/status")).stdout).toMatch(/1/u);
      expect((await run("ls /sys/class/net")).stdout.trim()).toBe("lo");
      expect((await run("uname -m")).stdout.trim()).toBe(
        nativePlatform() === "linux/arm64" ? "aarch64" : "x86_64",
      );
      for (const tool of ["git", "python3", "node", "rg", "curl", "ps"])
        expect((await run(`command -v ${tool}`)).exitCode, tool).toBe(0);
      expect((await run("command -v sudo")).exitCode).not.toBe(0);
      // Node 22 with npm 10 or later: Debian's npm 9 never exits after an install through a proxy.
      expect((await run("node --version")).stdout).toMatch(/^v22\./u);
      expect((await run("npm --version")).stdout).toMatch(/^(1[0-9]|[2-9][0-9])\./u);
      // Root, for the seal and Capture, holds exactly CHOWN, DAC_OVERRIDE, DAC_READ_SEARCH,
      // FOWNER, and KILL, never a privileged container's full set.
      const privileged = await workspace.runPrivileged?.(
        ["sh", "-c", "id -u; grep CapEff /proc/self/status"],
        30_000,
        AbortSignal.timeout(30_000),
      );
      expect(privileged?.stdout).toMatch(/^0\nCapEff:\s+000000000000002f\n$/u);
      // The drop that starts every Task command empties even root's sets.
      const dropped = await workspace.runPrivileged?.(
        [
          "python3",
          "-I",
          "-S",
          "-c",
          CAPABILITY_DROP_THEN_EXEC,
          "grep",
          "-E",
          "^Cap(Inh|Prm|Eff|Amb)",
          "/proc/self/status",
        ],
        30_000,
        AbortSignal.timeout(30_000),
      );
      const rootSets = dropped?.stdout.trim() ?? "";
      expect(rootSets.split("\n"), rootSets).toHaveLength(4);
      for (const line of rootSets.split("\n")) expect(line, rootSets).toMatch(/\s0{16}$/u);
    } finally {
      await provider.stop(who, workspace.sandboxId);
    }
  }, 120_000);

  it("starts a Task command with no capabilities without the exec server too", async () => {
    // Without the server, each command is its own runtime exec, run as the container's user.
    const direct = containerSandboxProvider({
      name: "local-vm",
      label: "supertag.local-vm",
      runtime,
      image: options.image,
      user: options.user,
      buildImages: true,
      runFlags: ["--memory", options.memory],
      execServer: false,
    });
    const who = owner();
    const workspace = await direct.allocate(who, 60_000, AbortSignal.timeout(60_000));
    try {
      const run = (script: string) =>
        workspace.run(["sh", "-c", script], 30_000, AbortSignal.timeout(30_000));
      await expectNoCapabilities(run, "through a runtime exec");
      // A missing command still exits as a runtime exec reports it.
      expect(
        (await workspace.run(["no-such-command"], 30_000, AbortSignal.timeout(30_000))).exitCode,
      ).toBe(127);
    } finally {
      await direct.stop(who, workspace.sandboxId);
    }
  }, 120_000);

  it(
    "builds a devcontainer's layers on the base image and refuses copies from the host",
    async () => {
      const who = owner();
      const environment = {
        dockerfileCommands: ["RUN echo marked > /home/user/marker", "USER user"],
        user: "user",
        setupCommands: [],
      };
      expect(() =>
        containerDockerfile(
          { ...environment, dockerfileCommands: ["COPY / /host", "USER user"] },
          "base",
        ),
      ).toThrow(/copy/u);
      const workspace = await provider.allocate(
        who,
        60_000,
        AbortSignal.timeout(BUILD_MS),
        environment,
      );
      try {
        const marker = await workspace.run(
          ["cat", "/home/user/marker"],
          30_000,
          AbortSignal.timeout(30_000),
        );
        expect(marker.exitCode).toBe(0);
      } finally {
        await provider.stop(who, workspace.sandboxId);
      }
    },
    BUILD_MS,
  );

  it("carries a command's connection to the egress proxy over the relay, with no other network", async () => {
    // The Attempt's egress proxy, on this host's loopback.
    const seen: string[] = [];
    const proxy = createServer((socket) => {
      socket.once("data", (data) => {
        seen.push(data.toString().split("\r\n")[0] ?? "");
        socket.end("HTTP/1.1 200 Connection established\r\n\r\nrelayed");
      });
    }).listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const who = owner();
    const workspace = await provider.allocate(
      who,
      60_000,
      AbortSignal.timeout(60_000),
      undefined,
      undefined,
      {
        proxy: `127.0.0.1:${(proxy.address() as { port: number }).port}`,
        variables: {},
        caPem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
      },
    );
    try {
      expect(workspace.egressRelay).toBe(true);
      const run = (script: string) =>
        workspace.run(["python3", "-c", script], 30_000, AbortSignal.timeout(30_000));
      const relayed = await run(
        [
          "import socket",
          "s = socket.create_connection(('127.0.0.1', 3128), timeout=10)",
          "s.sendall(b'CONNECT pypi.org:443 HTTP/1.1\\r\\n\\r\\n')",
          "data = b''",
          "while chunk := s.recv(4096): data += chunk",
          "print(data.decode())",
        ].join("\n"),
      );
      expect(relayed.stdout).toContain("relayed");
      expect(seen).toEqual(["CONNECT pypi.org:443 HTTP/1.1"]);
      // No name resolves and nothing else leaves the container.
      const dns = await run(
        "import socket\ntry:\n socket.getaddrinfo('example.com', 443)\n print('resolved')\nexcept OSError as e:\n print('dns', e.errno)",
      );
      expect(dns.stdout).toMatch(/^dns /u);
      const direct = await run(
        "import socket\ntry:\n socket.create_connection(('1.1.1.1', 443), timeout=5)\n print('connected')\nexcept OSError:\n print('blocked')",
      );
      expect(direct.stdout.trim()).toBe("blocked");
      // The Task's user cannot stop the relay, which runs as root.
      const kill = await workspace.run(
        [
          "sh",
          "-c",
          "kill -9 $(pgrep -u 0 -f 'relay ready') 2>/dev/null; pgrep -u 0 -f 'relay ready' >/dev/null && echo alive",
        ],
        30_000,
        AbortSignal.timeout(30_000),
      );
      expect(kill.stdout).toContain("alive");
    } finally {
      await provider.stop(who, workspace.sandboxId);
      proxy.close();
    }
  }, 120_000);

  it(
    "refuses an image whose Workspace user can change what root runs",
    async () => {
      const who = owner();
      await expect(
        provider.allocate(who, 60_000, AbortSignal.timeout(BUILD_MS), {
          dockerfileCommands: [
            "USER root",
            "RUN chmod g+w,o+w \"$(python3 -I -S -c 'import os; print(os.__file__)')\"",
            "USER user",
          ],
          user: "user",
          setupCommands: [],
        }),
      ).rejects.toThrow(
        /can change what the sandbox runs as root: \/usr\/lib\/python3[.0-9]*\/os\.py/u,
      );
      expect(ownedContainers()).toEqual([]);
    },
    BUILD_MS,
  );

  it("keeps the relay from a Task that would signal it or take its port", async () => {
    const proxy = createServer((socket) => socket.end()).listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const who = owner();
    const workspace = await provider.allocate(
      who,
      60_000,
      AbortSignal.timeout(60_000),
      undefined,
      undefined,
      {
        proxy: `127.0.0.1:${(proxy.address() as { port: number }).port}`,
        variables: {},
        caPem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
      },
    );
    try {
      const attempt = await workspace.run(
        [
          "python3",
          "-c",
          [
            "import os, signal, socket, subprocess",
            "pids = subprocess.run(['pgrep', '-x', '-u', '0', 'python3.11'], capture_output=True, text=True).stdout.split() or subprocess.run(['pgrep', '-u', '0', 'python3'], capture_output=True, text=True).stdout.split()",
            "assert pids, 'no root relay'",
            "for pid in pids:",
            "    try:",
            "        os.kill(int(pid), signal.SIGKILL)",
            "        print('killed')",
            "    except PermissionError:",
            "        print('denied')",
            "for reuse in (False, True):",
            "    s = socket.socket()",
            "    if reuse: s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)",
            "    try:",
            "        s.bind(('127.0.0.1', 3128))",
            "        print('bound')",
            "    except OSError:",
            "        print('in use')",
          ].join("\n"),
        ],
        30_000,
        AbortSignal.timeout(30_000),
      );
      expect(attempt.stdout).not.toMatch(/killed|bound/u);
      expect(attempt.stdout).toMatch(/denied/u);
      expect(attempt.stdout.match(/in use/gu)).toHaveLength(2);
    } finally {
      await provider.stop(who, workspace.sandboxId);
      proxy.close();
    }
  }, 120_000);

  it("ends the relay in the container when its exec client goes away", async () => {
    const who = owner();
    const workspace = await provider.allocate(who, 60_000, AbortSignal.timeout(60_000));
    try {
      const child = spawn(
        runtime,
        [
          "exec",
          "-i",
          "-u",
          "0",
          workspace.sandboxId,
          "python3",
          "-I",
          "-S",
          "-c",
          EGRESS_RELAY_PROGRAM,
          "3128",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      await new Promise<void>((resolve) =>
        child.stdout.on("data", (data: Buffer) => {
          if (data.toString().includes("relay ready")) resolve();
        }),
      );
      const running = () =>
        spawnSync(runtime, ["exec", workspace.sandboxId, "pgrep", "-u", "0", "-f", "relay ready"], {
          encoding: "utf8",
        }).stdout.trim();
      expect(running()).not.toBe("");
      // As the helper's abort does: the exec client is killed, and the relay sees its input end.
      child.kill("SIGKILL");
      const deadline = Date.now() + 10_000;
      while (running() !== "" && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 200));
      expect(running()).toBe("");
    } finally {
      await provider.stop(who, workspace.sandboxId);
    }
  }, 120_000);

  it("keeps a dependency cache per Workspace and Tag across Task Attempts, and no other", async () => {
    const key = (tag: string) =>
      createHash("sha256").update(`test-host\0repo\0${tag}`).digest("hex");
    const builder = key(`builder-${randomUUID()}`);
    const reviewer = key(`reviewer-${randomUUID()}`);
    const attempt = async (cache: string, script: string) => {
      const who = owner();
      const workspace = await provider.allocate(
        who,
        60_000,
        AbortSignal.timeout(60_000),
        undefined,
        undefined,
        undefined,
        cache,
      );
      try {
        expect(workspace.commandEnvironment?.["npm_config_cache"]).toBe("/supertag/cache/npm");
        return await workspace.run(["sh", "-c", script], 30_000, AbortSignal.timeout(30_000));
      } finally {
        await provider.stop(who, workspace.sandboxId);
      }
    };
    const volumes = () =>
      spawnSync(runtime, ["volume", "ls", "-q", "--filter", "label=supertag.local-vm.cache=1"], {
        encoding: "utf8",
      })
        .stdout.split("\n")
        .filter(Boolean);
    const before = new Set(volumes());
    try {
      // The Workspace user owns the cache, and what one Task Attempt downloads, the next finds.
      const first = await attempt(
        builder,
        "mkdir -p /supertag/cache/npm && echo cached > /supertag/cache/npm/package && stat -c %u /supertag/cache",
      );
      expect(first.stdout.trim()).toBe("1000");
      expect((await attempt(builder, "cat /supertag/cache/npm/package")).stdout.trim()).toBe(
        "cached",
      );
      // Another Tag on the same Workspace starts from an empty cache.
      const other = await attempt(reviewer, "ls -A /supertag/cache");
      expect(other.stdout.trim()).toBe("");
    } finally {
      const made = volumes().filter((name) => !before.has(name));
      if (made.length) spawnSync(runtime, ["volume", "rm", ...made]);
    }
  }, 180_000);

  it("serves operations from one exec server that a seal or the Task may stop, then starts another", async () => {
    const who = owner();
    const workspace = await provider.allocate(who, 60_000, AbortSignal.timeout(60_000));
    const run = (script: string) =>
      workspace.run(["sh", "-c", script], 30_000, AbortSignal.timeout(30_000));
    const servers = () =>
      spawnSync(runtime, ["exec", workspace.sandboxId, "pgrep", "-c", "-f", "op.*spawn"], {
        encoding: "utf8",
      }).stdout.trim();
    try {
      // No server runs until the first operation, so the process record never includes it.
      expect(servers()).toBe("0");
      expect((await run("echo first")).stdout).toBe("first\n");
      expect(servers()).toBe("1");
      // A seal stops every process the record lacks, the server among them, as root.
      await workspace.runPrivileged?.(
        ["pkill", "-9", "-f", "op.*spawn"],
        30_000,
        AbortSignal.timeout(30_000),
      );
      expect((await run("echo after-seal")).stdout).toBe("after-seal\n");
      // The Task may stop it too: that operation ends without a result, and the next is served.
      const killed = await run("pkill -9 -f 'op.*spawn'; sleep 5; echo unreachable");
      expect(killed.stdout).not.toContain("unreachable");
      expect((await run("echo again")).stdout).toBe("again\n");
      expect(servers()).toBe("1");
    } finally {
      await provider.stop(who, workspace.sandboxId);
    }
  }, 120_000);

  it(
    "serves an operation far faster than an exec of its own",
    async () => {
      const measure = async (execServer: boolean) => {
        const timed = containerSandboxProvider({
          name: "local-vm",
          label: "supertag.local-vm",
          runtime,
          image: options.image,
          user: options.user,
          buildImages: true,
          execServer,
        });
        const who = owner();
        const workspace = await timed.allocate(who, 60_000, AbortSignal.timeout(BUILD_MS));
        try {
          await workspace.run(["true"], 10_000, AbortSignal.timeout(10_000));
          const started = performance.now();
          for (let index = 0; index < 20; index += 1)
            await workspace.run(["true"], 10_000, AbortSignal.timeout(10_000));
          return (performance.now() - started) / 20;
        } finally {
          await timed.stop(who, workspace.sandboxId);
        }
      };
      const own = await measure(false);
      const served = await measure(true);
      console.log(
        `per operation: ${own.toFixed(1)} ms with an exec each, ${served.toFixed(1)} ms served`,
      );
      expect(served).toBeLessThan(own / 2);
    },
    BUILD_MS,
  );

  it(
    "refuses an image with a setuid program its Workspace user can run",
    async () => {
      const who = owner();
      await expect(
        provider.allocate(who, 60_000, AbortSignal.timeout(BUILD_MS), {
          dockerfileCommands: [
            "USER root",
            "RUN cp /bin/sh /usr/local/bin/rootsh && chmod 4755 /usr/local/bin/rootsh",
            "USER user",
          ],
          user: "user",
          setupCommands: [],
        }),
      ).rejects.toThrow(/setuid or setgid programs its user can run.*\/usr\/local\/bin\/rootsh/u);
      expect(ownedContainers()).toEqual([]);
    },
    BUILD_MS,
  );

  it(
    "refuses a Workspace user that is root",
    async () => {
      const who = owner();
      await expect(
        provider.allocate(who, 60_000, AbortSignal.timeout(BUILD_MS), {
          dockerfileCommands: ["USER root"],
          user: "root",
          setupCommands: [],
        }),
      ).rejects.toThrow(/root/u);
      await provider.stop(who);
      expect(ownedContainers()).toEqual([]);
    },
    BUILD_MS,
  );

  it(
    "keeps every Codex configuration layer out of Codex's exec-server, whatever the Task plants",
    async () => {
      const session = createLocalVmWorkspaceSession(options, () => {}, testing);
      const who = owner();
      const source = await mkdtemp(join(tmpdir(), "supertag-codex-layers-"));
      try {
        // The repository itself carries a project config with an MCP server; Codex must leave an
        // untrusted project's layer unread.
        const git = (...args: string[]) => {
          const result = spawnSync("git", args, { cwd: source, encoding: "utf8" });
          if (result.status !== 0) throw new Error(result.stderr);
          return result.stdout.trim();
        };
        git("init", "-q", "--template=");
        await mkdir(join(source, ".codex"));
        await writeFile(
          join(source, ".codex", "config.toml"),
          '[mcp_servers.project_planted]\nurl = "http://127.0.0.1:9/project"\n',
        );
        git("add", ".");
        git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "-qm",
          "planted",
        );
        const startCommit = git("rev-parse", "HEAD");
        git("update-ref", "refs/heads/supertag-deliveries/codex", startCommit);
        git("bundle", "create", "source.bundle", "refs/heads/supertag-deliveries/codex");
        const bytes = await readFile(join(source, "source.bundle"));
        await session.allocate(
          {
            owner: who,
            timeoutMs: 120_000,
            allowedActions: ["files:read", "files:write", "commands:execute"],
            codexVersion: CODEX_TEST_VERSION,
            environment: {
              // A devcontainer-style image: the operator's own base, plus Codex.
              image: CODEX_TEST_IMAGE,
              dockerfileCommands: [
                "USER root",
                "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 1000 user && find / -xdev -type f -perm /6000 -exec chmod u-s,g-s {} +",
                INSTALL_CODEX,
                "USER user",
              ],
              user: "user",
              // As a Task could: plant a user config, and try the read-only CODEX_HOME and the
              // system layer too.
              setupCommands: [
                'mkdir -p "$HOME/.codex" && printf \'[mcp_servers.planted]\\nurl = "http://127.0.0.1:9/mcp"\\n\' > "$HOME/.codex/config.toml"',
                `printf x > ${CODEX_HOME}/config.toml 2>/dev/null || true`,
                "mkdir -p /etc/codex 2>/dev/null && printf x > /etc/codex/config.toml 2>/dev/null || true",
              ],
            },
          },
          AbortSignal.timeout(BUILD_MS),
        );
        await session.stage(
          {
            startCommit,
            bundle: {
              sha256: createHash("sha256").update(bytes).digest("hex"),
              byteLength: BigInt(bytes.length),
            },
          },
          bytes,
        );
        const server = await session.startStdioServer({ kind: "codexExecServer" });
        try {
          const rpc = jsonRpc(server);
          const initialized = await rpc.call("initialize", { clientName: "supertag-test" });
          rpc.notify("initialized", {});
          const cwd = initialized.environmentInfo.cwd as string;
          const read = await rpc.call("environmentConfig/read", {
            cwd,
            // What Codex reads from an executor: MCP servers (0.163), hooks (later releases),
            // and anything else that could add tools or commands.
            configPaths: [["mcp_servers"], ["hooks"], ["skills"], ["plugins"], ["features"]],
            requirementsPaths: [["mcp_servers"], ["hooks"]],
          });
          // No layer at all: not the planted user config, not the repository's untrusted project
          // config, and nothing in CODEX_HOME or /etc/codex.
          expect(read.config.layers).toEqual([]);
          expect(read.requirements.layers).toEqual([]);
          expect(read.codexHomeDir).toBe(`file://${CODEX_HOME}`);
          // Commands inherit the exec-server's environment: the read-only CODEX_HOME, nothing
          // from the Worker Host.
          await rpc.call("process/start", {
            processId: "env",
            argv: ["/bin/sh", "-c", "env"],
            cwd,
            envPolicy: {
              inherit: "all",
              ignoreDefaultExcludes: true,
              exclude: [],
              set: {},
              includeOnly: [],
            },
            env: {},
            tty: false,
            pipeStdin: false,
            arg0: null,
          });
          const output = await rpc.output("env");
          expect(output).toContain(`CODEX_HOME=${CODEX_HOME}\n`);
          expect(output).not.toMatch(/SUPERTAG|CODEX_API_KEY|OPENAI_API_KEY/u);
        } finally {
          await session.stopStdioServer(server);
        }
        await session.stop({ owner: who });
      } finally {
        await session.stop({ owner: who }).catch(() => undefined);
        await rm(source, { recursive: true, force: true });
      }
    },
    BUILD_MS,
  );

  for (const check of sandboxProviderConformance(
    async ({ hostId }) => ({
      session: createLocalVmWorkspaceSession(options, () => {}, testing),
      async lose() {
        for (const id of ownedContainers(hostId)) spawnSync(runtime, ["rm", "-f", id]);
      },
    }),
    { commands: true, snapshots: true, isolated: true, timeoutMs: 120_000 },
  ))
    it(`local-vm conformance: ${check.name}`, check.run, check.timeoutMs);
});

/** The pinned Codex the exec-server test installs; any version the host matches would do. */
const CODEX_TEST_VERSION = "0.163.0";
const CODEX_TEST_IMAGE =
  "python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72";
/** Installs `codex` from npm's Linux package for this machine, checked against its integrity. */
const INSTALL_CODEX = `RUN python3 -c 'import base64, hashlib, io, platform, tarfile, urllib.request; arch, triple, integrity = {"aarch64": ("arm64", "aarch64", "IH2/R+4OarjGvsAf1ll3fdyLwrPgYLl3uzp6u9CyD9sj2Lw+ViDSe3QBZVHdcHJs0eIiZFg6Wprcuy4CRZaUGw=="), "x86_64": ("x64", "x86_64", "uwRaOsrYogLQhcxAM/GoeWrw0QIWEMRo7c9gM8sKAviVkZQHlu9kRLJ5PkufbV+ABGjyZgIwiFdJ0LCJ0N6e8w==")}[platform.machine()]; data = urllib.request.urlopen("https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_TEST_VERSION}-linux-" + arch + ".tgz").read(); assert base64.b64encode(hashlib.sha512(data).digest()).decode() == integrity; binary = tarfile.open(fileobj=io.BytesIO(data)).extractfile("package/vendor/" + triple + "-unknown-linux-musl/bin/codex").read(); open("/usr/local/bin/codex", "wb").write(binary)' && chmod 755 /usr/local/bin/codex`;

/** Newline-delimited JSON-RPC over a stdio server's input and output. */
function jsonRpc(server: Awaited<ReturnType<SandboxWorkspaceSession["startStdioServer"]>>) {
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  const outputs = new Map<string, string>();
  const closed = new Map<string, () => void>();
  let next = 1;
  let buffered = "";
  void (async () => {
    for await (const chunk of server.output ?? []) {
      if (chunk.stream !== "stdout") continue;
      buffered += chunk.text;
      let end = buffered.indexOf("\n");
      while (end >= 0) {
        const message = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        end = buffered.indexOf("\n");
        if (typeof message.id === "number") pending.get(message.id)?.(message);
        else if (message.method === "process/output")
          outputs.set(
            message.params.processId,
            (outputs.get(message.params.processId) ?? "") +
              Buffer.from(message.params.chunk, "base64").toString(),
          );
        else if (message.method === "process/closed") closed.get(message.params.processId)?.();
      }
    }
  })();
  const send = (message: object) =>
    server.write?.(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  return {
    // biome-ignore lint/suspicious/noExplicitAny: the exec-server's JSON results are untyped
    async call(method: string, params: object): Promise<any> {
      const id = next++;
      const answered = new Promise<{ result?: unknown; error?: unknown }>((resolve) =>
        pending.set(id, resolve),
      );
      await send({ id, method, params });
      const message = await answered;
      if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
      return message.result;
    },
    notify(method: string, params: object) {
      void send({ method, params });
    },
    async output(processId: string): Promise<string> {
      await new Promise<void>((resolve) => closed.set(processId, resolve));
      return outputs.get(processId) ?? "";
    },
  };
}

it("pins the base image to a digest", () => {
  expect(BASE_DOCKERFILE.split("\n")[0]).toMatch(/@sha256:/u);
});
