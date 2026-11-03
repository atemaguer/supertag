import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveWorkspaceMcpServers, sandboxMcpRefusal } from "./src/workspace-mcp.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function checkout(mcpServers: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-workspace-mcp-"));
  directories.push(directory);
  await writeFile(join(directory, ".mcp.json"), JSON.stringify({ mcpServers }));
  return directory;
}

it("resolves only listed HTTP servers and hashes selected reference configuration", async () => {
  const path = await checkout({
    sentry: {
      type: "http",
      url: "https://sentry.example/mcp",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
      headers: { Authorization: "Bearer ${SUPERTAG_MCP_SENTRY_TOKEN}" },
    },
    unlisted: { command: "sh", args: ["-c", "exit 1"] },
  });
  const first = await resolveWorkspaceMcpServers(path, ["sentry"], {
    SUPERTAG_MCP_SENTRY_TOKEN: "secret-one",
  });
  const second = await resolveWorkspaceMcpServers(path, ["sentry"], {
    SUPERTAG_MCP_SENTRY_TOKEN: "secret-two",
  });
  expect(first.servers).toEqual([
    {
      name: "sentry",
      url: "https://sentry.example/mcp",
      headers: { Authorization: "Bearer secret-one" },
    },
  ]);
  expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(second.digest).toBe(first.digest);
  expect(JSON.stringify(first)).not.toContain("unlisted");
});

it("resolves listed stdio servers, expanding references only in env", async () => {
  const path = await checkout({
    local: {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
      env: { TOKEN: "${SUPERTAG_MCP_DB_TOKEN}" },
    },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This tests a reference in args.
    argument: { command: "node", args: ["--token=${SUPERTAG_MCP_DB_TOKEN}"] },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
    missing: { command: "node", env: { TOKEN: "${SUPERTAG_MCP_ABSENT_TOKEN}" } },
    badArgs: { command: "node", args: "server.js" },
  });
  const first = await resolveWorkspaceMcpServers(path, ["local"], {
    SUPERTAG_MCP_DB_TOKEN: "secret-one",
  });
  const second = await resolveWorkspaceMcpServers(path, ["local"], {
    SUPERTAG_MCP_DB_TOKEN: "secret-two",
  });
  expect(first.servers).toEqual([
    {
      name: "local",
      command: "node",
      args: ["server.js"],
      cwd: path,
      env: { TOKEN: "secret-one" },
    },
  ]);
  // The digest pins the configuration, never the resolved credential.
  expect(second.digest).toBe(first.digest);
  expect(first.digest).not.toContain("secret-one");
  await expect(resolveWorkspaceMcpServers(path, ["argument"], {})).rejects.toThrow(
    /must not reference environment variables; put credentials in env/u,
  );
  await expect(resolveWorkspaceMcpServers(path, ["missing"], {})).rejects.toThrow(/ABSENT_TOKEN/u);
  await expect(resolveWorkspaceMcpServers(path, ["badArgs"], {})).rejects.toThrow(
    /args must be a list of strings/u,
  );
});

it("rejects missing references before use", async () => {
  const path = await checkout({
    remote: {
      type: "http",
      url: "https://example.test/mcp",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
      headers: { Authorization: "${SUPERTAG_MCP_MISSING_TOKEN}" },
    },
    invalid: {
      type: "http",
      url: "https://example.test/mcp",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This tests an invalid literal reference.
      headers: { Authorization: "${BAD-NAME}" },
    },
    literal: {
      type: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "secret" },
    },
  });
  await expect(resolveWorkspaceMcpServers(path, ["remote"], {})).rejects.toThrow(/MISSING_TOKEN/u);
  await expect(resolveWorkspaceMcpServers(path, ["invalid"], {})).rejects.toThrow(
    /must reference environment variables/u,
  );
  await expect(resolveWorkspaceMcpServers(path, ["literal"])).rejects.toThrow(
    /must reference environment variables/u,
  );
  await expect(resolveWorkspaceMcpServers(path, ["absent"])).rejects.toThrow(/not defined/u);
});

it("refuses repository references to Worker variables and resolves only SUPERTAG_MCP_ names", async () => {
  const worker = {
    GITHUB_TOKEN: "github-secret",
    SUPERTAG_AUTH_KEY: "stak_secret",
    OPENAI_API_KEY: "model-secret",
    SUPERTAG_MCP_SENTRY_TOKEN: "sentry-secret",
  };
  const path = await checkout({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
    github: { command: "node", env: { TOKEN: "${GITHUB_TOKEN}" } },
    authKey: {
      type: "http",
      url: "https://example.test/mcp",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
      headers: { Authorization: "Bearer ${SUPERTAG_AUTH_KEY}" },
    },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
    url: { type: "http", url: "https://example.test/${OPENAI_API_KEY}" },
    allowed: {
      command: "node",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
      env: { TOKEN: "${SUPERTAG_MCP_SENTRY_TOKEN}" },
    },
  });
  for (const [server, variable] of [
    ["github", "GITHUB_TOKEN"],
    ["authKey", "SUPERTAG_AUTH_KEY"],
    ["url", "OPENAI_API_KEY"],
  ] as const) {
    const refusal = resolveWorkspaceMcpServers(path, [server], worker);
    await expect(refusal).rejects.toThrow(
      new RegExp(`references \\$\\{${variable}\\}.*only variables named SUPERTAG_MCP_\\*`, "u"),
    );
    // The refusal names the variable and the rule, never a value.
    await expect(refusal).rejects.not.toThrow(/secret/u);
  }
  const allowed = await resolveWorkspaceMcpServers(path, ["allowed"], worker);
  expect(allowed.servers).toEqual([
    expect.objectContaining({ name: "allowed", env: { TOKEN: "sentry-secret" } }),
  ]);
});

it("returns declared definitions for providers: stdio shapes with referenced names, HTTP names only", async () => {
  const path = await checkout({
    docs: {
      type: "http",
      url: "https://docs.example/mcp",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
      headers: { Authorization: "Bearer ${SUPERTAG_MCP_DOCS_TOKEN}" },
    },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
    db: { command: "node", args: ["db.js"], env: { TOKEN: "${SUPERTAG_MCP_DB_TOKEN}" } },
    plain: { command: "node", args: ["plain.js"] },
  });
  const resolved = await resolveWorkspaceMcpServers(path, ["plain", "docs", "db"], {
    SUPERTAG_MCP_DOCS_TOKEN: "docs-secret",
    SUPERTAG_MCP_DB_TOKEN: "db-secret",
  });
  expect(resolved.definitions).toEqual([
    {
      name: "db",
      transport: "stdio",
      command: "node",
      args: ["db.js"],
      env: { TOKEN: "SUPERTAG_MCP_DB_TOKEN" },
    },
    { name: "docs", transport: "http" },
    { name: "plain", transport: "stdio", command: "node", args: ["plain.js"], env: {} },
  ]);
  expect(JSON.stringify(resolved.definitions)).not.toMatch(/secret|docs\.example/u);
  expect(sandboxMcpRefusal("e2b", resolved.definitions)).toBe(
    "Workspace MCP server db references host credential SUPERTAG_MCP_DB_TOKEN in its env, but e2b runs Workspace stdio servers inside the Task's sandbox, where the Task could read it. Run this Workspace on local-execution, or serve db over HTTP so its credential stays on the Worker Host",
  );
  expect(
    sandboxMcpRefusal(
      "e2b",
      resolved.definitions.filter((definition) => definition.name !== "db"),
    ),
  ).toBeUndefined();
});
