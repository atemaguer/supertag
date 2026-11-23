import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { FUSES } from "./fuses";
import { menuTemplate } from "./menu";
import { cacheDirectory, configDirectory, gatewayStore } from "./paths";
import { appFile, appResponse, contentSecurityPolicy } from "./protocol";
import { badgeCount, Notifications, notificationRequest, webUrl } from "./shell";

it("keeps the saved Gateways where the CLI reads them", () => {
  expect(gatewayStore({ HOME: "/Users/ada" }, "darwin")).toBe(
    "/Users/ada/Library/Application Support/ai.supertag.desktop/gateways.json",
  );
  // macOS ignores XDG_CONFIG_HOME, as the CLI does.
  expect(configDirectory({ HOME: "/Users/ada", XDG_CONFIG_HOME: "/x" }, "darwin")).toBe(
    "/Users/ada/Library/Application Support/ai.supertag.desktop",
  );
  expect(gatewayStore({ HOME: "/home/ada" }, "linux")).toBe(
    "/home/ada/.config/ai.supertag.desktop/gateways.json",
  );
  expect(configDirectory({ HOME: "/home/ada", XDG_CONFIG_HOME: "/cfg" }, "linux")).toBe(
    "/cfg/ai.supertag.desktop",
  );
  // A relative XDG_CONFIG_HOME is ignored.
  expect(configDirectory({ HOME: "/home/ada", XDG_CONFIG_HOME: "cfg" }, "linux")).toBe(
    "/home/ada/.config/ai.supertag.desktop",
  );
  expect(() => configDirectory({}, "darwin")).toThrow();
  expect(cacheDirectory({ HOME: "/Users/ada" }, "darwin")).toBe(
    "/Users/ada/Library/Application Support/ai.supertag.desktop/cache",
  );
  expect(cacheDirectory({ HOME: "/home/ada" }, "linux")).toBe(
    "/home/ada/.local/share/ai.supertag.desktop/cache",
  );
});

let root: string;
let outside: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "supertag-renderer-"));
  outside = await mkdtemp(path.join(tmpdir(), "supertag-outside-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), "<!doctype html>");
  await writeFile(path.join(root, "assets", "index.js"), "export {}");
  await writeFile(path.join(outside, "secret"), "secret");
  await symlink(path.join(outside, "secret"), path.join(root, "assets", "link.js"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

it("serves only the built renderer from app://supertag/, with the CSP", async () => {
  expect(appFile(root, "app://supertag/")).toBe(path.join(root, "index.html"));
  expect(appFile(root, "app://supertag/assets/index.js?v=1")).toBe(
    path.join(root, "assets", "index.js"),
  );
  // The URL parser resolves dot segments first, so they never leave the root.
  expect(appFile(root, "app://supertag/%2e%2e/%2e%2e/index.html")).toBe(
    path.join(root, "index.html"),
  );
  for (const url of [
    "app://other/index.html",
    "https://supertag/index.html",
    "app://supertag/assets/..%2f..%2fsecret",
    "app://supertag/.env",
    "app://supertag/assets%5c..%5cindex.html",
    "app://supertag/%00",
    "app://supertag/%E0%A4%A",
  ]) {
    expect(appFile(root, url), url).toBeUndefined();
  }

  const index = await appResponse(root, { url: "app://supertag/index.html", method: "GET" });
  expect(index.status).toBe(200);
  expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(index.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
  expect(await index.text()).toBe("<!doctype html>");
  const script = await appResponse(root, { url: "app://supertag/assets/index.js", method: "GET" });
  expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  // A link out of the renderer, a missing file, a directory, or a write is refused.
  for (const url of ["assets/link.js", "missing.js", "assets"]) {
    const response = await appResponse(root, { url: `app://supertag/${url}`, method: "GET" });
    expect(response.status, url).toBe(404);
  }
  expect((await appResponse(root, { url: "app://supertag/", method: "POST" })).status).toBe(405);
});

it("lets the page connect only to itself, and in development to the Vite server", () => {
  const production = contentSecurityPolicy();
  expect(production).toContain("default-src 'self'");
  expect(production).toContain("script-src 'self';");
  expect(production).toContain("connect-src 'self'");
  expect(production).not.toContain("unsafe-eval");
  expect(production).not.toMatch(/script-src[^;]*unsafe-inline/);
  for (const directive of ["object-src 'none'", "frame-src 'none'", "base-uri 'none'"]) {
    expect(production).toContain(directive);
  }
  const development = contentSecurityPolicy("http://127.0.0.1:1420");
  expect(development).toContain("connect-src 'self' http://127.0.0.1:1420 ws://127.0.0.1:1420");
});

it("opens only web links and checks what the window sends", () => {
  expect(webUrl("https://ci.example.com/runs/7")).toBe("https://ci.example.com/runs/7");
  expect(webUrl("http://localhost:8080/x")).toBe("http://localhost:8080/x");
  for (const url of ["javascript:alert(1)", "file:///etc/hosts", "mailto:a@b.c", "", 7, null]) {
    expect(webUrl(url)).toBeUndefined();
  }
  expect(badgeCount(3)).toBe(3);
  expect(badgeCount(0)).toBe(0);
  for (const count of [-1, 1.5, Number.NaN, "3"]) expect(badgeCount(count)).toBeUndefined();
  const request = { key: "reply:moss", tagId: "moss", title: "Moss", body: "Done." };
  expect(notificationRequest(request)).toEqual(request);
  expect(notificationRequest({ ...request, body: 7 })).toBeUndefined();
  expect(notificationRequest({ ...request, title: "" })).toBeUndefined();
  expect(notificationRequest({ ...request, body: "x".repeat(5000) })?.body).toHaveLength(2048);
});

it("replaces a notification with a newer one of the same key, and routes its click", () => {
  const created: { close: ReturnType<typeof vi.fn>; listeners: Map<string, () => void> }[] = [];
  const clicked = vi.fn();
  const notifications = new Notifications({
    supported: () => true,
    clicked,
    create() {
      const listeners = new Map<string, () => void>();
      const entry = {
        close: vi.fn(() => listeners.get("close")?.()),
        listeners,
        on: (name: string, listener: () => void) => listeners.set(name, listener),
        show: vi.fn(),
      };
      created.push(entry);
      return entry as never;
    },
  });
  const request = { key: "reply:moss", tagId: "moss", title: "Moss", body: "Done." };
  notifications.show(request);
  notifications.show({ ...request, body: "2 new messages" });
  expect(created[0]?.close).toHaveBeenCalledOnce();
  expect(notifications.size).toBe(1);
  created[1]?.listeners.get("click")?.();
  expect(clicked).toHaveBeenCalledWith("moss");
  created[1]?.listeners.get("close")?.();
  expect(notifications.size).toBe(0);
});

it("builds the menu with edit shortcuts, and developer tools only in development", () => {
  const roles = (mac: boolean, development: boolean) =>
    JSON.stringify(menuTemplate({ mac, development }));
  expect(roles(true, false)).toContain('"copy"');
  expect(roles(true, false)).toContain('"paste"');
  expect(roles(true, false)).not.toContain("toggleDevTools");
  expect(roles(false, false)).not.toContain("toggleDevTools");
  expect(roles(true, true)).toContain("toggleDevTools");
});

it("offers Check for Updates… in the app menu on macOS and in File elsewhere", () => {
  const check = vi.fn();
  for (const mac of [true, false]) {
    const [first] = menuTemplate({ mac, development: false, onCheckForUpdates: check });
    expect(first?.role).toBe(mac ? "appMenu" : "fileMenu");
    const items = first?.submenu as { label?: string; click?: () => void }[];
    const item = items.find((entry) => entry.label === "Check for Updates…");
    item?.click?.();
  }
  expect(check).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(menuTemplate({ mac: true, development: true }))).not.toContain(
    "Check for Updates",
  );
});

it("offers Settings… with its shortcut in the app menu on macOS and in File elsewhere", () => {
  const open = vi.fn();
  for (const mac of [true, false]) {
    const [first] = menuTemplate({ mac, development: false, onSettings: open });
    const items = first?.submenu as { label?: string; accelerator?: string; click?: () => void }[];
    const item = items.find((entry) => entry.label === "Settings…");
    expect(item?.accelerator).toBe("CmdOrCtrl+,");
    item?.click?.();
  }
  expect(open).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(menuTemplate({ mac: true, development: false }))).not.toContain("Settings");
});

it("points the Mac app's updater at published GitHub Releases only", async () => {
  const { APP_UPDATE_YML } = await import("../electron-builder.config");
  expect(APP_UPDATE_YML.split("\n")).toEqual([
    "provider: github",
    "owner: atemaguer",
    "repo: supertag",
    "releaseType: release",
    "updaterCacheDirName: supertag-desktop-updater",
    "",
  ]);
});

it("packages Electron without its Node escape hatches", () => {
  expect(FUSES).toMatchObject({
    strictlyRequireAllFuses: true,
    0: false, // RunAsNode
    1: true, // EnableCookieEncryption
    2: false, // EnableNodeOptionsEnvironmentVariable
    3: false, // EnableNodeCliInspectArguments
    4: true, // EnableEmbeddedAsarIntegrityValidation
    5: true, // OnlyLoadAppFromAsar
  });
});
