/**
 * The terminal UI's logic that needs no renderer, under vitest on Node: arguments, text
 * filtering, notifications' bytes, and preferences.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { availableCommands, COMMANDS, slashHead, slashMatches, slashQuery } from "./commands";
import { cliPath, notifyLevel, parseArguments } from "./launch";
import { alertLevel, notificationBytes } from "./notify";
import { loadPreferences, RAIL, savePreferences } from "./preferences";
import { clip, initials, safe, shortTime } from "./text";

it("parses the entry contract's arguments", () => {
  expect(parseArguments(["--version"])).toEqual({ kind: "version" });
  expect(parseArguments(["--headless-check"])).toEqual({ kind: "headless-check" });
  expect(parseArguments([])).toEqual({ kind: "run", launch: {} });
  expect(parseArguments(["--gateway", "local", "--state-directory", "/s"])).toEqual({
    kind: "run",
    launch: { gateway: "local", stateDirectory: "/s" },
  });
  expect(parseArguments(["--gateway=https://g.example.com"])).toEqual({
    kind: "run",
    launch: { gateway: "https://g.example.com" },
  });
  expect(parseArguments(["--gateway"]).kind).toBe("error");
  expect(parseArguments(["--version", "extra"]).kind).toBe("error");
  expect(parseArguments(["-h"]).kind).toBe("help");
});

it("finds the CLI from SUPERTAG_CLI, else beside the binary, else PATH", () => {
  expect(cliPath({ SUPERTAG_CLI: "/opt/supertag" })).toBe("/opt/supertag");
  expect(cliPath({}, "/nonexistent/dir/supertag-tui")).toBe("supertag");
  expect(notifyLevel({ SUPERTAG_TUI_NOTIFY: "questions" })).toBe("questions");
  expect(notifyLevel({ SUPERTAG_TUI_NOTIFY: "loud" })).toBe("all");
});

it("shows escape sequences in Gateway text as text", () => {
  expect(safe("a\u001b[31mred\u0007\tb\nc")).toBe("a^[[31mred\tb\nc");
  expect(clip("one\ntwo three", 8)).toBe("one two…");
  expect(initials("lead-bot")).toBe("LE");
  const noon = new Date(2026, 10, 19, 12, 0).getTime();
  expect(shortTime(new Date(2026, 10, 19, 9, 5).getTime(), noon)).toBe("09:05");
  expect(shortTime(new Date(2026, 10, 18, 9, 5).getTime(), noon)).toBe("Yday");
});

it("writes OSC 9, wrapped for tmux, with nothing from the Tag that could end it", () => {
  const alert = { title: "lead", body: "done\u0007\u001b]0;pwned" };
  expect(notificationBytes(alert, "all", {})).toBe("\u001b]9;lead: done  ]0;pwned\u0007");
  expect(notificationBytes(alert, "all", { TMUX: "/tmp/tmux,1,0" })).toBe(
    "\u001bPtmux;\u001b\u001b]9;lead: done  ]0;pwned\u0007\u001b\\",
  );
  expect(notificationBytes(alert, "bell", {})).toBe("\u0007");
  expect(notificationBytes(alert, "off", {})).toBe("");
  expect(alertLevel("bell")).toBe("all");
});

it("keeps preferences owner-only and ignores a bad file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "supertag-tui-preferences-"));
  try {
    const file = path.join(root, "supertag", "tui.json");
    expect(loadPreferences(file).railWidth).toBe(RAIL.initial);
    savePreferences(file, {
      lastGateway: "local",
      scopes: { local: { gateway: "local /s", principal: "operator:local" } },
      railWidth: 40,
      railFolded: true,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toMatch(/token/u);
    const loaded = loadPreferences(file);
    expect(loaded).toEqual({
      lastGateway: "local",
      scopes: { local: { gateway: "local /s", principal: "operator:local" } },
      railWidth: 40,
      railFolded: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("opens commands only for a / at the start, with no space or second / after it", () => {
  expect(slashQuery("/")).toBe("");
  expect(slashQuery("/go")).toBe("go");
  expect(slashQuery("/goal ship")).toBeUndefined();
  expect(slashQuery("/usr/bin")).toBeUndefined();
  expect(slashQuery("fix /etc/hosts")).toBeUndefined();
  expect(slashHead("/goal  Ship it ")).toEqual({ name: "goal", argument: "Ship it" });
  expect(slashHead("/usr/bin")).toBeUndefined();
});

it("ranks commands by the start of a name, then within it, then by description", () => {
  const all = availableCommands({ tag: true });
  const names = (query: string) => slashMatches(query, all).map((match) => match.name);
  expect(names("")).toEqual([...names("")].sort());
  expect(names("ne")[0]).toBe("new");
  expect(names("ne")).toContain("network");
  // An alias typed shows as itself.
  expect(names("exi")).toEqual(["exit"]);
  expect(names("wake")).toEqual(["schedules"]);
  expect(names("zzz")).toEqual([]);
  expect(availableCommands({ tag: false }).map((entry) => entry.id)).not.toContain("goal");
  expect(new Set(COMMANDS.map((entry) => entry.id)).size).toBe(COMMANDS.length);
});
