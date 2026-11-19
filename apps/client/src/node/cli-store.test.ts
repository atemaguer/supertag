import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { hostLine } from "../model/gateway";
import {
  CLI_STORE_ERROR,
  cliStore,
  configRoot,
  desktopStore,
  loadCliGateways,
  parseCliStore,
  saveWithCli,
  tlsOf,
} from "./cli-store";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "supertag-cli-store-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it("finds the stores where the CLI looks", () => {
  expect(configRoot({ HOME: "/home/a" }, "darwin")).toBe("/home/a/Library/Application Support");
  expect(configRoot({ HOME: "/home/a", XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe("/xdg");
  // A relative XDG_CONFIG_HOME is ignored, as the CLI ignores it.
  expect(configRoot({ HOME: "/home/a", XDG_CONFIG_HOME: "rel" }, "linux")).toBe("/home/a/.config");
  expect(cliStore({ HOME: "/h" }, "linux")).toBe("/h/.config/supertag/gateways.json");
  expect(desktopStore({ HOME: "/h" }, "linux")).toBe(
    "/h/.config/ai.supertag.desktop/gateways.json",
  );
});

it("reads the CLI's store format, with optional TLS files", () => {
  const gateways = parseCliStore(
    JSON.stringify({
      version: 1,
      gateways: [
        { name: "work", url: "https://g.example.com", token: "t1", server_ca_file: "/ca.pem" },
        {
          name: "mtls",
          url: "wss://g.example.com/supertag",
          token: "t2",
          server_ca_file: "",
          client_cert_file: "/c.pem",
          client_key_file: "/k.pem",
        },
      ],
    }),
  );
  expect(gateways).toEqual([
    { name: "work", url: "https://g.example.com", token: "t1", serverCaFile: "/ca.pem" },
    {
      name: "mtls",
      url: "wss://g.example.com/supertag",
      token: "t2",
      clientCertFile: "/c.pem",
      clientKeyFile: "/k.pem",
    },
  ]);
  expect(() => parseCliStore(JSON.stringify({ version: 2, gateways: [] }))).toThrow();
  expect(() => parseCliStore("{")).toThrow();
  expect(() => parseCliStore(JSON.stringify({ version: 1, gateways: [{ url: 1 }] }))).toThrow();
});

it("reads only a private store in a private directory", async () => {
  const directory = path.join(root, "supertag");
  const file = path.join(directory, "gateways.json");
  expect(await loadCliGateways(file)).toEqual([]);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(
    file,
    JSON.stringify({ version: 1, gateways: [{ name: "a", url: "https://a.example", token: "t" }] }),
    { mode: 0o600 },
  );
  expect(await loadCliGateways(file)).toHaveLength(1);
  await chmod(file, 0o644);
  await expect(loadCliGateways(file)).rejects.toBe(CLI_STORE_ERROR);
  await chmod(file, 0o600);
  await chmod(directory, 0o755);
  await expect(loadCliGateways(file)).rejects.toBe(CLI_STORE_ERROR);
});

it("reads TLS files and names the one it could not read", async () => {
  const ca = path.join(root, "ca.pem");
  await writeFile(ca, "CA");
  expect((await tlsOf({ serverCaFile: ca })).ca?.toString()).toBe("CA");
  await expect(tlsOf({ serverCaFile: path.join(root, "missing.pem") })).rejects.toMatch(
    /certificate authority file .*missing\.pem/u,
  );
  await expect(tlsOf({ clientCertFile: ca })).rejects.toMatch(/both the client certificate/u);
});

it("saves with `supertag connect`, the credential only in its environment", async () => {
  const cli = path.join(root, "fake-supertag");
  const record = path.join(root, "connect.txt");
  await writeFile(
    cli,
    `#!/bin/sh\nprintf '%s\\n' "$*" "$SUPERTAG_OPERATOR_TOKEN" > "${record}"\n[ "$3" = "--name" ] || exit 1\n`,
    { mode: 0o755 },
  );
  await saveWithCli(cli, {
    name: "work",
    url: "https://g.example.com",
    token: "stak_secret",
    serverCaFile: "/ca.pem",
  });
  const { readFile } = await import("node:fs/promises");
  const [args, token] = (await readFile(record, "utf8")).trim().split("\n");
  expect(args).toBe("connect https://g.example.com --name work --server-ca-file /ca.pem");
  expect(args).not.toContain("stak_secret");
  expect(token).toBe("stak_secret");
  const failing = path.join(root, "failing-supertag");
  await writeFile(failing, "#!/bin/sh\necho 'Error: could not reach the Gateway' >&2\nexit 1\n", {
    mode: 0o755,
  });
  await expect(
    saveWithCli(failing, { name: "x", url: "https://x.example", token: "t" }),
  ).rejects.toBe("could not reach the Gateway");
});

it("shows Worker Hosts by phase in one line", () => {
  expect(hostLine({ unreachable: 1, ready: 2 })).toBe("2 ready, 1 unreachable");
  expect(hostLine({})).toBe("no Worker Hosts");
});
