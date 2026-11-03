import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const bounded = (operation, ms, label) => {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out; outcome is uncertain`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
const closeClient = async (client) => {
  try {
    await bounded(Promise.resolve(client.close()), 5000, "Modal client close");
  } catch {
    /* Resource cleanup is tracked separately. */
  }
};

// The public package pins the SDK used by its bundled app-server. A PATH CLI may differ.
export async function installedCodexVersion(
  manifestPath = createRequire(import.meta.url).resolve("supertag-ai/package.json"),
) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = manifest.dependencies?.["@openai/codex-sdk"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Installed supertag-ai must pin an exact Codex SDK version");
  return version;
}

export async function startModal(
  state,
  { build, codexVersion, token, mcpToken, save, createClient },
) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(codexVersion))
    throw new Error("Expected exact Codex version");
  const client = createClient ? await createClient() : new (await import("modal")).ModalClient();
  let sandbox;
  try {
    const app = await client.apps.fromName("supertag-conformance", { createIfMissing: true });
    const image = await client.images
      .fromRegistry("node:24-bookworm-slim")
      .dockerfileCommands([
        `RUN npm install --global @openai/codex@${codexVersion}`,
        "RUN groupadd --gid 10001 workload && useradd --uid 10001 --gid 10001 --no-create-home workload && mkdir -p /app /data /state",
      ])
      .build(app);
    // Images are content-addressed and may be shared by other runs; keep the cache image.
    state.modalImageId = image.imageId;
    await save(state);
    sandbox = await client.sandboxes.create(app, image, {
      command: ["sleep", "infinity"],
      encryptedPorts: [8787],
      timeoutMs: 1200000,
      tags: { purpose: "supertag-shared-organization" },
    });
    state.modalSandboxId = sandbox.sandboxId;
    try {
      await save(state);
    } catch (error) {
      try {
        await bounded(sandbox.terminate({ wait: true }), 30000, "Unregistered sandbox cleanup");
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Could not persist or terminate Modal sandbox ${sandbox.sandboxId}; it remains bounded by its 20 minute lifetime`,
        );
      }
      throw error;
    }
    for (const name of ["supertag-ai.tgz", "execution-service.mjs", "mcp-fixture.cjs"])
      await sandbox.filesystem.writeBytes(await readFile(join(build, name)), `/app/${name}`);
    const install = await sandbox.exec(["npm", "install", "--omit=dev", "/app/supertag-ai.tgz"], {
      workdir: "/app",
      timeoutMs: 180000,
    });
    const [code] = await Promise.all([
      install.wait(),
      install.stdout.readText(),
      install.stderr.readText(),
    ]);
    if (code !== 0) throw new Error("Installing the public package in Modal failed");
    await sandbox.exec(
      ["sh", "-c", "exec node /app/execution-service.mjs >/state/execution-service.log 2>&1"],
      {
        env: {
          SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: token,
          ...(mcpToken ? { SUPERTAG_EXAMPLE_MCP_TOKEN: mcpToken } : {}),
        },
      },
    );
    state.executionUrl = (await sandbox.tunnels())[8787].url;
    if (!state.executionUrl.startsWith("https://"))
      throw new Error("Modal execution requires HTTPS");
    await save(state);
  } finally {
    sandbox?.detach();
    await closeClient(client);
  }
}

export async function executeInSandbox(state, source, { createClient } = {}) {
  const args = [
    "env",
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "node",
    "--input-type=module",
    "-e",
    source,
  ];
  if (state.provider !== "modal") {
    if (!/^supertag-shared-org-[a-z0-9-]+$/.test(state.containerName ?? ""))
      throw new Error("Invalid example container name");
    return (
      await run("docker", ["exec", "--user", "10001:10001", state.containerName, ...args], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  }
  const client = createClient ? await createClient() : new (await import("modal")).ModalClient();
  let sandbox;
  try {
    sandbox = await bounded(
      client.sandboxes.fromId(state.modalSandboxId),
      5000,
      "Modal sandbox lookup",
    );
    const process = await bounded(
      sandbox.exec(["runuser", "-u", "workload", "--", ...args], { timeoutMs: 30000 }),
      5000,
      "Verifier start",
    );
    const [code, stdout] = await bounded(
      Promise.all([process.wait(), process.stdout.readText(), process.stderr.readText()]),
      35000,
      "Verifier completion",
    );
    if (code !== 0) throw new Error("Sandbox command failed");
    return stdout;
  } finally {
    sandbox?.detach();
    await closeClient(client);
  }
}

export async function stopModal(state, { createClient } = {}) {
  if (!state.modalSandboxId || state.modalTerminated) return;
  const client = createClient ? await createClient() : new (await import("modal")).ModalClient();
  let sandbox;
  try {
    sandbox = await bounded(
      client.sandboxes.fromId(state.modalSandboxId),
      5000,
      "Modal sandbox lookup",
    );
    const evidence = join(state.stateDirectory, "hosted-evidence");
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    for (const name of ["csv-summary.mjs", "review.md"]) {
      try {
        await writeFile(
          join(evidence, name),
          await bounded(
            sandbox.filesystem.readBytes(`/data/workspace/${name}`),
            3000,
            "Evidence capture",
          ),
          { mode: 0o600 },
        );
      } catch {
        /* Missing or expired output is not evidence of successful completion. */
      }
    }
    if (state.mcp) {
      try {
        await writeFile(
          join(evidence, "mcp-calls.jsonl"),
          await bounded(
            sandbox.filesystem.readText("/state/example-mcp/calls.jsonl"),
            3000,
            "MCP evidence capture",
          ),
          { mode: 0o600 },
        );
      } catch {
        state.mcpEvidenceUnavailable = true;
      }
    }
    await bounded(sandbox.terminate({ wait: true }), 30000, "Modal sandbox termination");
    state.modalTerminated = new Date().toISOString();
  } finally {
    sandbox?.detach();
    await closeClient(client);
  }
}

// Read through the provider's operator channel, outside the workload's writable files.
export async function readMcpEvidence(state, { createClient } = {}) {
  let text;
  if (state.provider === "modal") {
    const client = createClient ? await createClient() : new (await import("modal")).ModalClient();
    let sandbox;
    try {
      sandbox = await bounded(
        client.sandboxes.fromId(state.modalSandboxId),
        5000,
        "Modal sandbox lookup",
      );
      text = await bounded(
        sandbox.filesystem.readText("/state/example-mcp/calls.jsonl"),
        5000,
        "MCP evidence read",
      );
    } finally {
      sandbox?.detach();
      await closeClient(client);
    }
  } else {
    text = (
      await run(
        "docker",
        ["exec", "--user", "0:0", state.containerName, "cat", "/state/example-mcp/calls.jsonl"],
        { timeout: 10000 },
      )
    ).stdout;
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
