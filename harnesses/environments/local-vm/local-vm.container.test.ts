import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  containerDockerfile,
  containerSandboxProvider,
  EGRESS_RELAY_PROGRAM,
  nativePlatform,
  type SandboxOwner,
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
const BUILD_MS = 20 * 60_000;

function owner(): SandboxOwner {
  return {
    hostId: "local-vm-test",
    hostGeneration: 1n,
    taskId: randomUUID(),
    attemptId: randomUUID(),
    allocationId: randomUUID(),
  };
}

function ownedContainers(): string[] {
  const listed = spawnSync(
    runtime,
    ["ps", "-aq", "--no-trunc", "--filter", "label=supertag.local-vm=1"],
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
    runFlags: ["--memory", options.memory],
  });

  beforeAll(async () => {
    // The first allocation builds the base image; the cases after it reuse it.
    const first = owner();
    const workspace = await provider.allocate(first, 60_000, AbortSignal.timeout(BUILD_MS));
    await provider.stop(first, workspace.sandboxId);
  }, BUILD_MS);

  it("runs Task processes as an unprivileged user with no capabilities and no network", async () => {
    const who = owner();
    const workspace = await provider.allocate(who, 60_000, AbortSignal.timeout(60_000));
    try {
      const run = (script: string) =>
        workspace.run(["sh", "-c", script], 30_000, AbortSignal.timeout(30_000));
      expect((await run("id -u")).stdout.trim()).toBe("1000");
      // No capability in any set a Task process could use.
      const sets = (await run("grep -E '^Cap(Inh|Prm|Eff|Amb)' /proc/self/status")).stdout;
      expect(sets.trim().split("\n")).toHaveLength(4);
      for (const line of sets.trim().split("\n")) expect(line).toMatch(/\s0{16}$/u);
      expect((await run("grep NoNewPrivs /proc/self/status")).stdout).toMatch(/1/u);
      expect((await run("ls /sys/class/net")).stdout.trim()).toBe("lo");
      expect((await run("uname -m")).stdout.trim()).toBe(
        nativePlatform() === "linux/arm64" ? "aarch64" : "x86_64",
      );
      for (const tool of ["git", "python3", "node", "rg", "curl", "ps"])
        expect((await run(`command -v ${tool}`)).exitCode, tool).toBe(0);
      expect((await run("command -v sudo")).exitCode).not.toBe(0);
      // Root, for the seal and Capture, holds exactly CHOWN, DAC_OVERRIDE, DAC_READ_SEARCH,
      // FOWNER, and KILL, never a privileged container's full set.
      const privileged = await workspace.runPrivileged?.(
        ["sh", "-c", "id -u; grep CapEff /proc/self/status"],
        30_000,
        AbortSignal.timeout(30_000),
      );
      expect(privileged?.stdout).toMatch(/^0\nCapEff:\s+000000000000002f\n$/u);
    } finally {
      await provider.stop(who, workspace.sandboxId);
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
        ["sh", "-c", "pkill python3; pgrep -u 0 -f 'relay ready' >/dev/null && echo alive"],
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

  for (const check of sandboxProviderConformance(
    async () => ({
      session: createLocalVmWorkspaceSession(options),
      async lose() {
        for (const id of ownedContainers()) spawnSync(runtime, ["rm", "-f", id]);
      },
    }),
    { commands: true, snapshots: true, isolated: true, timeoutMs: 120_000 },
  ))
    it(`local-vm conformance: ${check.name}`, check.run, check.timeoutMs);
});

it("pins the base image to a digest", () => {
  expect(BASE_DOCKERFILE.split("\n")[0]).toMatch(/@sha256:/u);
});
