import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostMcpToolServers, hostMcpValue, MCP_PRESETS } from "../apps/cli/src/host-mcp.ts";
import { runHostService } from "../apps/cli/src/host-service.ts";
import { main } from "../apps/cli/src/index.ts";
import { formatMcpList } from "../apps/cli/src/mcp-command.ts";
import {
  type HostService,
  hostServiceLabels,
  loadServicesFile,
  SupertagYamlError,
} from "../apps/cli/src/supertag-yaml.ts";
import { HostServiceWorklet } from "../apps/cli/src/worker.ts";
import { placeByLabels } from "../packages/control-plane/src/label-placement.ts";
import {
  advertisedWorkerHostLabels,
  mcpServerLabel,
  mcpServerOfLabel,
  volumeCredentialLabel,
} from "../packages/core/src/index.ts";
import { StaticWorker } from "../packages/runtime/sdk/src/index.ts";

let directory: string;
let output: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "host-mcp-"));
  vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "state"));
  vi.stubEnv("HOME", join(directory, "home"));
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function file(text: string): Promise<string> {
  const root = join(directory, "config");
  await mkdir(root, { recursive: true });
  const path = join(root, "supertag.yaml");
  await writeFile(path, text);
  return path;
}

function hostFile(mcp: string, extra = ""): string {
  return `services:
  control-plane:
    type: control-plane
  laptop:
    type: host
    harnesses: [claude-code]
${extra}    mcp:
${mcp
  .trim()
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
secrets:
  sentry-token: { environment: SENTRY_TOKEN }
`;
}

async function host(mcp: string, extra = ""): Promise<HostService> {
  const loaded = await loadServicesFile({ files: [await file(hostFile(mcp, extra))] });
  return loaded.services.find((service) => service.type === "host") as HostService;
}

async function problems(mcp: string, extra = ""): Promise<readonly string[]> {
  try {
    await loadServicesFile({ files: [await file(hostFile(mcp, extra))] });
  } catch (error) {
    if (error instanceof SupertagYamlError) return error.problems;
    throw error;
  }
  return [];
}

describe("host service mcp", () => {
  it("starts a host service Worklet with a configured Volume credential", async () => {
    const loaded = await loadServicesFile({
      files: [
        await file(`services:
  control-plane: { type: control-plane }
  laptop:
    type: host
    harnesses: [codex]
    volume-credentials: { datasets: { environment: DATASET_TOKEN } }
`),
      ],
    });
    const service = loaded.services.find((entry) => entry.type === "host");
    if (!service) throw new Error("missing host service");
    let available = Object.keys(service.volumeCredentials);
    const worklet = new HostServiceWorklet(
      "mapped-worklet",
      "mapped-host",
      [new StaticWorker()],
      { labels: service.labels },
      [],
      undefined,
      async () => available,
    );
    expect((await worklet.describe()).host.labels).toContain(volumeCredentialLabel("datasets"));
    available = [];
    expect(await worklet.hostLabels()).not.toContain(volumeCredentialLabel("datasets"));
  });
  it("fails before the host takes Tasks when an MCP credential is missing", async () => {
    vi.stubEnv("SENTRY_TOKEN", "");
    const files = [
      await file(
        hostFile(
          `sentry: { url: "https://mcp.sentry.dev/mcp", auth: { bearer: { env: SENTRY_TOKEN } } }`,
        ),
      ),
    ];
    const loaded = await loadServicesFile({ files });
    const service = loaded.services.find((entry) => entry.type === "host") as HostService;
    const write = vi.fn();
    await expect(
      runHostService({ file: loaded, service, mode: "foreground", write }),
    ).rejects.toThrow(
      /this host takes no Tasks:\n {2}MCP server sentry auth.bearer reads SENTRY_TOKEN, which is not set/u,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("reads HTTP servers, presets, and every declarative auth form as references", async () => {
    const laptop = await host(`
github: { preset: github }
slack: { preset: slack, auth: { oauth: true } }
ghes: { url: "https://ghes.acme.dev/mcp", auth: { githubApp: { appId: 123456, installationId: "7890123", privateKey: { file: ~/keys/app.pem } } } }
sentry: { type: http, url: "https://mcp.sentry.dev/mcp", auth: { bearer: { env: SENTRY_TOKEN } } }
internal: { url: "https://mcp.acme.dev/mcp", auth: { headers: { X-Api-Key: { secretRef: sentry-token } } } }
acme: { url: "https://acme.dev/mcp", auth: { clientCredentials: { clientId: { env: ACME_ID }, assertionKey: { file: keys/acme.pem }, scope: "read write" } } }
partner: { url: "https://partner.dev/mcp", auth: { clientCredentials: { clientId: supertag, clientSecret: { env: PARTNER_SECRET } } } }
vendor: { url: "https://vendor.dev/mcp", auth: { helper: [/opt/bin/mcp-token, vendor] } }
notion: { url: "https://mcp.notion.com/mcp", auth: { oauth: { refreshToken: { env: NOTION_MCP_REFRESH_TOKEN } } } }
`);
    expect(laptop.mcp).toEqual({
      github: { preset: "github", url: "https://api.githubcopilot.com/mcp/" },
      slack: { preset: "slack", url: "https://mcp.slack.com/mcp", auth: { oauth: true } },
      ghes: {
        url: "https://ghes.acme.dev/mcp",
        auth: {
          githubApp: {
            appId: 123456,
            installationId: 7890123,
            privateKey: { file: join(directory, "home", "keys", "app.pem") },
          },
        },
      },
      sentry: { url: "https://mcp.sentry.dev/mcp", auth: { bearer: { env: "SENTRY_TOKEN" } } },
      internal: {
        url: "https://mcp.acme.dev/mcp",
        auth: { headers: { "X-Api-Key": { secretRef: "sentry-token" } } },
      },
      acme: {
        url: "https://acme.dev/mcp",
        auth: {
          clientCredentials: {
            clientId: { env: "ACME_ID" },
            // Relative files resolve against the file that names them.
            assertionKey: { file: join(directory, "config", "keys", "acme.pem") },
            scope: "read write",
          },
        },
      },
      partner: {
        url: "https://partner.dev/mcp",
        auth: {
          clientCredentials: { clientId: "supertag", clientSecret: { env: "PARTNER_SECRET" } },
        },
      },
      vendor: { url: "https://vendor.dev/mcp", auth: { helper: ["/opt/bin/mcp-token", "vendor"] } },
      notion: {
        url: "https://mcp.notion.com/mcp",
        auth: { oauth: { refreshToken: { env: "NOTION_MCP_REFRESH_TOKEN" } } },
      },
    });
    // A host without mcp provides none.
    const loaded = await loadServicesFile({
      files: [
        await file(
          "services:\n  laptop:\n    type: host\n    control-plane: https://supertag.acme.dev\n    harnesses: [codex]\n",
        ),
      ],
    });
    expect(loaded.services.find((service) => service.type === "host")).toMatchObject({ mcp: {} });
  });

  it("reads stdio servers with env references, and rejects env values", async () => {
    vi.stubEnv("LEAKED", "postgres://app:hunter2@db/app");
    const laptop = await host(`
local-db: { command: [npx, -y, "@acme/db-mcp"], env: { DATABASE_URL: { env: ACME_DB_URL } } }
tool: { type: stdio, command: ~/bin/tool-mcp, env: { KEY: { secretRef: sentry-token } } }
`);
    expect(laptop.mcp).toEqual({
      "local-db": {
        command: ["npx", "-y", "@acme/db-mcp"],
        env: { DATABASE_URL: { env: "ACME_DB_URL" } },
      },
      tool: {
        command: [join(directory, "home", "bin", "tool-mcp")],
        env: { KEY: { secretRef: "sentry-token" } },
      },
    });
    // The Worker's server definitions carry the command, never the environment.
    expect(hostMcpToolServers(laptop.mcp)).toEqual({
      "local-db": { command: "npx", args: ["-y", "@acme/db-mcp"] },
      tool: { command: join(directory, "home", "bin", "tool-mcp"), args: [] },
    });
    // supertag config shows references; supertag mcp list shows only the executable.
    expect(hostMcpValue(laptop.mcp)["local-db"]).toEqual({
      command: ["npx", "-y", "@acme/db-mcp"],
      env: { DATABASE_URL: { env: "ACME_DB_URL" } },
    });
    vi.stubEnv("ACME_DB_URL", "postgres://app:pw@db/app");
    const loaded = await loadServicesFile({
      files: [
        await file(
          hostFile(
            `local-db: { command: [${process.execPath}, "@acme/db-mcp"], env: { DATABASE_URL: { env: ACME_DB_URL } } }`,
          ),
        ),
      ],
    });
    const list = await formatMcpList(loaded, { read: async () => undefined } as never);
    expect(list).toContain(`stdio: ${process.execPath}`);
    expect(list).toMatch(/env\s+ready/u);
    expect(list).not.toContain("@acme/db-mcp");
    expect(list).not.toContain("pw@db");
    const found = await problems(`
literal: { command: [db-mcp], env: { DATABASE_URL: "\${LEAKED}" } }
args: { command: npx, args: [-y, x] }
in-command: { command: [db-mcp, "--url=$\${DATABASE_URL}"] }
empty: { command: [] }
bad-name: { command: [db-mcp], env: { 1BAD: { env: X } } }
`);
    expect(found.join("\n")).not.toContain("hunter2");
    expect(found).toEqual([
      expect.stringMatching(/mcp\.literal\.env\.DATABASE_URL: must be a reference/u),
      expect.stringMatching(/mcp\.args\.args: belongs in command/u),
      expect.stringMatching(/mcp\.in-command\.command: must not reference environment variables/u),
      expect.stringMatching(/mcp\.empty\.command: must list the executable/u),
      expect.stringMatching(/mcp\.bad-name\.env\.1BAD: is not a valid environment variable name/u),
    ]);
  });

  it("rejects credential values and malformed servers with clear errors", async () => {
    vi.stubEnv("LEAKED", "ghp_secretvalue");
    const found = await problems(`
piped: { type: stdio, url: "https://x.dev" }
sse: { type: sse, url: "https://x.dev" }
Bad_Name: { url: "https://x.dev" }
nothing: {}
ftp: { url: "ftp://x.dev" }
userinfo: { url: "https://user:pass@x.dev/mcp" }
notion: { preset: notion }
moved-preset: { preset: github, url: "https://ghes.acme.dev/mcp" }
top-oauth: { url: "https://x.dev", oauth: true }
top-headers: { url: "https://x.dev", headers: { X-Key: abc } }
literal: { url: "https://x.dev", auth: { bearer: "\${LEAKED}" } }
literal-header: { url: "https://x.dev", auth: { headers: { X-Key: plain-value } } }
two: { url: "https://x.dev", auth: { bearer: { env: A }, oauth: true } }
none: { url: "https://x.dev", auth: {} }
unknown-auth: { url: "https://x.dev", auth: { basic: { env: A } } }
bad-env: { url: "https://x.dev", auth: { bearer: { env: "1BAD" } } }
bad-secret: { url: "https://x.dev", auth: { bearer: { secretRef: missing } } }
two-refs: { url: "https://x.dev", auth: { bearer: { env: A, file: /k } } }
app: { url: "https://x.dev", auth: { githubApp: { appId: abc, installationId: 0 } } }
cc: { url: "https://x.dev", auth: { clientCredentials: { clientSecret: { env: S }, assertionKey: { file: /k } } } }
helper: { url: "https://x.dev", auth: { helper: [] } }
oauth: { url: "https://x.dev", auth: { oauth: false } }
`);
    const text = found.join("\n");
    // Values never appear in errors, even when interpolation put one in the file.
    expect(text).not.toContain("ghp_secretvalue");
    expect(text).not.toContain("plain-value");
    expect(found).toEqual([
      expect.stringMatching(/services\.laptop\.mcp\.piped\.url: unknown field for a stdio server/u),
      expect.stringMatching(/services\.laptop\.mcp\.piped\.command: must list the executable/u),
      expect.stringMatching(/services\.laptop\.mcp\.sse\.type: must be http/u),
      expect.stringMatching(
        /services\.laptop\.mcp\.Bad_Name: MCP server names are 1-59 lowercase/u,
      ),
      expect.stringMatching(
        /services\.laptop\.mcp\.nothing: needs a url, .* a preset \(github, slack, linear, teams, or lark\), or a command/u,
      ),
      expect.stringMatching(/services\.laptop\.mcp\.ftp\.url: must be an http\(s\) URL/u),
      expect.stringMatching(
        /services\.laptop\.mcp\.userinfo\.url: must not hold a user name or password/u,
      ),
      expect.stringMatching(
        /services\.laptop\.mcp\.notion\.preset: must be github, slack, linear, teams, or lark$/u,
      ),
      expect.stringMatching(
        /services\.laptop\.mcp\.moved-preset\.url: must not be set with a preset; the github preset uses its official URL and resource mapping\. For another server, drop preset and give url/u,
      ),
      expect.stringMatching(
        /services\.laptop\.mcp\.top-oauth\.oauth: belongs under auth, such as auth: \{ oauth: true \}/u,
      ),
      expect.stringMatching(/services\.laptop\.mcp\.top-headers\.headers: belongs under auth/u),
      expect.stringMatching(
        /services\.laptop\.mcp\.literal\.auth\.bearer: must be a reference: \{ env: VAR \}, \{ file: PATH \}, or \{ secretRef: NAME \}; supertag\.yaml holds references to credentials, never their values/u,
      ),
      expect.stringMatching(
        /services\.laptop\.mcp\.literal-header\.auth\.headers\.X-Key: must be a reference/u,
      ),
      expect.stringMatching(/services\.laptop\.mcp\.two\.auth: must have exactly one of bearer,/u),
      expect.stringMatching(/services\.laptop\.mcp\.none\.auth: must have exactly one of/u),
      expect.stringMatching(/services\.laptop\.mcp\.unknown-auth\.auth\.basic: unknown field/u),
      expect.stringMatching(
        /services\.laptop\.mcp\.bad-env\.auth\.bearer\.env: must be an environment variable name/u,
      ),
      expect.stringMatching(
        /services\.laptop\.mcp\.bad-secret\.auth\.bearer\.secretRef: must name an entry in secrets/u,
      ),
      expect.stringMatching(
        /services\.laptop\.mcp\.two-refs\.auth\.bearer: must have exactly one of env, file, or secretRef/u,
      ),
      expect.stringMatching(
        /mcp\.app\.auth\.githubApp\.appId: must be the GitHub App's numeric ID/u,
      ),
      expect.stringMatching(/mcp\.app\.auth\.githubApp\.installationId: must be the App/u),
      expect.stringMatching(/mcp\.app\.auth\.githubApp\.privateKey: is required/u),
      expect.stringMatching(/mcp\.cc\.auth\.clientCredentials\.clientId: is required/u),
      expect.stringMatching(
        /mcp\.cc\.auth\.clientCredentials: needs exactly one of clientSecret or assertionKey/u,
      ),
      expect.stringMatching(/mcp\.helper\.auth\.helper: must list a command and its arguments/u),
      expect.stringMatching(/mcp\.oauth\.auth\.oauth: must be true, for supertag mcp login, or/u),
    ]);
    // Errors carry the file position.
    expect(found[0]).toMatch(/supertag\.yaml:\d+:\d+: /u);
    expect(await problems("{}", "    labels: [mcp:fake]\n")).toEqual([
      expect.stringMatching(
        /services\.laptop\.labels: labels: mcp: labels come from host service configuration/u,
      ),
    ]);
    expect(await problems("")).toEqual([]);
  });

  it("reads an explicit tokenUrl for clientCredentials and oauth, and rejects unsafe ones", async () => {
    const laptop = await host(`
partner: { url: "https://partner.dev/mcp", auth: { clientCredentials: { clientId: supertag, clientSecret: { env: S }, tokenUrl: "https://login.partner-idp.dev/oauth/token" } } }
notion: { url: "https://mcp.notion.com/mcp", auth: { oauth: { refreshToken: { env: R }, tokenUrl: "https://api.notion.com/v1/oauth/token" } } }
local: { url: "http://127.0.0.1:8080/mcp", auth: { oauth: { refreshToken: { env: R }, tokenUrl: "http://localhost:9000/token" } } }
`);
    expect(laptop.mcp).toMatchObject({
      partner: {
        auth: { clientCredentials: { tokenUrl: "https://login.partner-idp.dev/oauth/token" } },
      },
      notion: { auth: { oauth: { tokenUrl: "https://api.notion.com/v1/oauth/token" } } },
      local: { auth: { oauth: { tokenUrl: "http://localhost:9000/token" } } },
    });
    const found = await problems(`
plain: { url: "https://x.dev/mcp", auth: { clientCredentials: { clientId: a, clientSecret: { env: S }, tokenUrl: "http://idp.x.dev/token" } } }
userinfo: { url: "https://x.dev/mcp", auth: { oauth: { refreshToken: { env: R }, tokenUrl: "https://me:pw@idp.x.dev/token" } } }
notaurl: { url: "https://x.dev/mcp", auth: { oauth: { refreshToken: { env: R }, tokenUrl: 42 } } }
bearer: { url: "https://x.dev/mcp", auth: { bearer: { env: A }, tokenUrl: "https://idp.x.dev/token" } }
`);
    expect(found.join("\n")).not.toContain("me:pw");
    expect(found).toEqual([
      expect.stringMatching(
        /mcp\.plain\.auth\.clientCredentials\.tokenUrl: must be the authorization server's https token endpoint/u,
      ),
      expect.stringMatching(
        /mcp\.userinfo\.auth\.oauth\.tokenUrl: must not hold a user name or password/u,
      ),
      expect.stringMatching(/mcp\.notaurl\.auth\.oauth\.tokenUrl: must be the authorization/u),
      expect.stringMatching(/mcp\.bearer\.auth\.tokenUrl: unknown field/u),
    ]);
  });

  it("shows servers and auth references in supertag config, and the output reads back", async () => {
    const path = await file(
      hostFile(`
github: { preset: github, auth: { bearer: { env: GITHUB_MCP_TOKEN } } }
notion: { url: "https://mcp.notion.com/mcp", auth: { oauth: true } }
`),
    );
    expect(await main(["config", "-f", path])).toBe(0);
    const printed = output.join("");
    expect(printed).toContain(
      [
        "    mcp:",
        "      github:",
        "        preset: github",
        "        auth:",
        "          bearer:",
        "            env: GITHUB_MCP_TOKEN",
        "      notion:",
        "        url: https://mcp.notion.com/mcp",
        "        auth:",
        "          oauth: true",
      ].join("\n"),
    );
    // The printed mcp map reads back as the same servers.
    const block = printed.slice(
      printed.indexOf("    mcp:\n") + 9,
      printed.indexOf("    concurrency:"),
    );
    const shown = block
      .split("\n")
      .map((line) => line.slice(6))
      .join("\n");
    expect(await host(shown)).toMatchObject({
      mcp: {
        github: { preset: "github", auth: { bearer: { env: "GITHUB_MCP_TOKEN" } } },
        notion: { auth: { oauth: true } },
      },
    });
  });

  it("keeps interpolated URL and helper values out of config output", async () => {
    vi.stubEnv("MCP_PATH", "private-path-token");
    vi.stubEnv("MCP_ARG", "private-helper-token");
    const path = await file(
      hostFile(`
custom: { url: "https://mcp.example.com/\${MCP_PATH}", auth: { helper: [/opt/bin/token, "\${MCP_ARG}"] } }
`),
    );
    expect(await main(["config", "-f", path])).toBe(0);
    const printed = output.join("");
    expect(printed).not.toContain("private-path-token");
    expect(printed).not.toContain("private-helper-token");
    expect(printed).toContain("<redacted>");
  });

  it("rejects URL query strings and fragments without echoing their values", async () => {
    vi.stubEnv("MCP_SECRET", "private-query-token");
    const found = await problems(`
query: { url: "https://mcp.example.com/mcp?token=\${MCP_SECRET}" }
fragment: { url: "https://mcp.example.com/mcp#private-fragment-token" }
`);
    expect(found).toHaveLength(2);
    expect(found.join("\n")).toContain("must not contain a query string or fragment");
    expect(found.join("\n")).not.toContain("private-query-token");
    expect(found.join("\n")).not.toContain("private-fragment-token");
  });

  it("does not echo an invalid interpolated secretRef", async () => {
    vi.stubEnv("MCP_SECRET", "private-secret-ref-token");
    const found = await problems(`
custom: { url: "https://mcp.example.com/mcp", auth: { bearer: { secretRef: "\${MCP_SECRET}" } } }
`);
    expect(found.join("\n")).toContain("must name an entry in secrets");
    expect(found.join("\n")).not.toContain("private-secret-ref-token");
  });

  it("advertises each server as an mcp:NAME label that places Tasks", async () => {
    const laptop = await host(
      `
github: { preset: github }
sentry: { url: "https://mcp.sentry.dev/mcp" }
`,
      "    labels: [gpu]\n",
    );
    const labels = hostServiceLabels(laptop);
    expect(labels).toEqual(["gpu", "mcp:github", "mcp:sentry"]);
    expect(mcpServerLabel("sentry")).toBe("mcp:sentry");
    expect(mcpServerOfLabel("mcp:sentry")).toBe("sentry");
    expect(mcpServerOfLabel("gpu")).toBeUndefined();
    // The Worklet descriptor carries them as ordinary labels.
    const advertised = advertisedWorkerHostLabels({ labels: [...labels] });
    expect(advertised).toEqual(expect.arrayContaining(["mcp:github", "mcp:sentry"]));
    const worklet = new HostServiceWorklet("w", "h", [new StaticWorker()], { labels: ["gpu"] }, [
      "github",
      "sentry",
    ]);
    expect((await worklet.describe()).host.labels).toEqual(expect.arrayContaining(labels));
    const hosts = [
      { id: "laptop", enrollmentStatus: "active" as const, labels: advertised },
      { id: "server", enrollmentStatus: "active" as const, labels: ["linux"] },
    ];
    expect(placeByLabels(["laptop", "server"], hosts, ["mcp:sentry"])).toEqual({
      status: "eligible",
      allowedWorkerHostIds: ["laptop"],
    });
    expect(placeByLabels(["laptop", "server"], hosts, ["mcp:notion"])).toEqual({
      status: "unmet",
      missingLabels: ["mcp:notion"],
      requirement: "labels:mcp:notion",
    });
  });

  it("serves its servers to target: mcp grants without auth references", async () => {
    const laptop = await host(`
github: { preset: github }
sentry: { url: "https://mcp.sentry.dev/mcp", auth: { bearer: { env: SENTRY_TOKEN } } }
`);
    expect(hostMcpToolServers(laptop.mcp)).toEqual({
      github: {
        url: "https://api.githubcopilot.com/mcp/",
        resources: MCP_PRESETS.github.resources,
      },
      sentry: { url: "https://mcp.sentry.dev/mcp" },
    });
  });

  it("reserves server names starting with supertag", async () => {
    expect(await problems(`supertag-coordination: { url: "https://x.dev" }`)).toEqual([
      expect.stringContaining("reserved"),
    ]);
  });
});

describe("Linear, Teams, and Lark presets", () => {
  it("fills in the official Linear URL and maps team resources", async () => {
    const service = await host(
      "linear: { preset: linear, auth: { bearer: { env: LINEAR_TOKEN } } }",
    );
    expect(service.mcp.linear).toEqual({
      url: "https://mcp.linear.app/mcp",
      preset: "linear",
      auth: { bearer: { env: "LINEAR_TOKEN" } },
    });
    const servers = hostMcpToolServers(service.mcp);
    expect(Object.keys(servers.linear?.resources?.tools ?? {}).sort()).toEqual([
      "create_issue",
      "list_issues",
    ]);
    expect(hostMcpValue(service.mcp).linear).toEqual({
      preset: "linear",
      auth: { bearer: { env: "LINEAR_TOKEN" } },
    });
  });

  it("builds the Teams URL from the tenant and requires a tenantId", async () => {
    const service = await host(
      "teams: { preset: teams, tenantId: contoso.onmicrosoft.com, auth: { bearer: { env: TEAMS_TOKEN } } }",
    );
    expect(service.mcp.teams).toMatchObject({
      url: "https://agent365.svc.cloud.microsoft/agents/tenants/contoso.onmicrosoft.com/servers/mcp_TeamsServer",
      preset: "teams",
      tenantId: "contoso.onmicrosoft.com",
    });
    expect(
      hostMcpToolServers(service.mcp).teams?.resources?.tools["mcp_graph_teams_postChannelMessage"],
    ).toEqual([
      {
        prefix: "team:",
        separator: "/channel:",
        components: [
          { arguments: ["team_id", "teamId"] },
          { arguments: ["channel_id", "channelId"] },
        ],
      },
    ]);
    expect((await problems("teams: { preset: teams }")).join("\n")).toContain(
      "tenantId: is required for the teams preset",
    );
    expect((await problems("linear: { preset: linear, tenantId: x }")).join("\n")).toContain(
      "belongs only with preset: teams",
    );
  });

  it("runs Lark as a stdio preset with env references and a chat mapping", async () => {
    const service = await host(
      "lark: { preset: lark, env: { APP_ID: { env: LARK_APP_ID }, APP_SECRET: { env: LARK_APP_SECRET } } }",
    );
    const lark = service.mcp.lark as { command: string[]; preset: string; env: object };
    expect(lark.preset).toBe("lark");
    expect(lark.command[0]).toBe(process.execPath);
    expect(lark.command.slice(1).join(" ")).toMatch(
      /lark-mcp\/dist\/cli\.js mcp --tool-name-case snake$/u,
    );
    expect(lark.env).toEqual({
      APP_ID: { env: "LARK_APP_ID" },
      APP_SECRET: { env: "LARK_APP_SECRET" },
    });
    expect(hostMcpToolServers(service.mcp).lark).toMatchObject({
      command: process.execPath,
      resources: { tools: { im_v1_message_create: [{ prefix: "chat:" }] } },
    });
    expect(hostMcpValue(service.mcp).lark).toEqual({
      preset: "lark",
      env: { APP_ID: { env: "LARK_APP_ID" }, APP_SECRET: { env: "LARK_APP_SECRET" } },
    });
    expect((await problems("lark: { preset: lark, command: [x] }")).join("\n")).toContain(
      "must not be set with a preset",
    );
    expect((await problems("x: { preset: notion }")).join("\n")).toContain(
      "must be github, slack, linear, teams, or lark",
    );
  });
});
