/**
 * The slash popup over the composer, and the one command registry that it, the palette and the
 * Keyboard shortcuts screen read.
 */
import { afterEach, expect, test } from "bun:test";
import { shortcutKeys } from "../src/app";
import { availableCommands, COMMANDS } from "../src/commands";
import { render, reset, type Setup, setup } from "./harness";

let current: Setup | undefined;
afterEach(() => {
  reset(current);
  current = undefined;
});

/** The composer's line: what is typed in it, between its borders. */
function composer(frame: string): string {
  const lines = frame.split("\n");
  const at = lines.findLastIndex((line) => line.includes("╭") || line.includes("┌"));
  return lines[at + 1] ?? "";
}

test("/ lists every command above the composer, and typing narrows them", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("/");
  let frame = await screen.waitFor("/goal <outcome>");
  for (const entry of availableCommands({ tag: true }))
    if (entry.slash) expect(frame).toContain(`/${entry.slash.name}`);
  // The `/` stays in the composer.
  expect(composer(frame)).toContain("/");
  await screen.type("sch");
  frame = await screen.waitFor("/schedules");
  expect(frame).not.toContain("/memory");
  expect(frame).not.toContain("/goal <outcome>");
  await screen.type("x");
  await screen.waitFor("No matching commands");
  await screen.close();
});

test("↑ and ↓ choose a command and Enter runs it, leaving the composer empty", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("/");
  await screen.waitFor("/goal <outcome>");
  // Sorted by name: /activity, /fold, /gateways, … ; ↑ from the first wraps to the last, /work.
  await screen.press("ARROW_DOWN");
  await screen.press("ARROW_DOWN");
  await screen.press("ARROW_UP");
  await screen.press("ARROW_UP");
  await screen.press("ARROW_UP");
  await screen.press("RETURN");
  await screen.waitFor("Work Sessions");
  expect(current.fake.sent).toEqual([]);
  await screen.press("ESCAPE");
  await screen.waitFor("Message lead");
  expect(composer(screen.frame())).toContain("Message lead · / for commands");
  await screen.close();
});

test("Tab completes the name; a command that takes an argument waits for it", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("/sch");
  await screen.waitFor("/schedules");
  await screen.press("TAB");
  // Tab stayed in the composer, and the keys did not move to the Tag list.
  for (let i = 0; i < 50 && !composer(screen.frame()).includes("/schedules"); i++)
    await screen.settle(1);
  let frame = screen.frame();
  expect(composer(frame)).toContain("/schedules");
  await screen.press("RETURN");
  await screen.waitFor("Schedules · lead");
  await screen.press("ESCAPE");

  await screen.type("/go");
  await screen.waitFor("/goal <outcome>");
  await screen.press("TAB");
  frame = await screen.waitFor("/goal <outcome> · An Objective the Tag owns");
  expect(composer(frame)).toContain("/goal");
  await screen.type("Ship it");
  await screen.press("RETURN");
  await screen.waitFor("Process requests: /goal Ship it");
  expect(current.fake.sent.map((sent) => sent.text)).toEqual(["/goal Ship it"]);
  await screen.close();
});

test("Esc closes the commands and keeps the text; a command no one has is sent", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("/me");
  await screen.waitFor("/memory");
  await screen.press("ESCAPE");
  for (let i = 0; i < 50 && screen.frame().includes("/memory"); i++) await screen.settle(1);
  let frame = screen.frame();
  expect(frame).not.toContain("/memory");
  expect(composer(frame)).toContain("/me");
  // Typing again opens them again.
  await screen.type("m");
  await screen.waitFor("/memory");
  await screen.press("ESCAPE");
  await screen.press("BACKSPACE");
  await screen.waitFor("/memory");
  await screen.press("ESCAPE");
  for (let i = 0; i < 50 && screen.frame().includes("/memory"); i++) await screen.settle(1);
  await screen.press("RETURN");
  await screen.waitFor("Process requests: /me");
  expect(current.fake.sent.map((sent) => sent.text)).toEqual(["/me"]);
  // Ctrl-C over the commands drops the text, and does not quit.
  await screen.type("/he");
  await screen.waitFor("/help");
  await screen.press("c", { ctrl: true });
  frame = await screen.waitFor("Message lead · / for commands");
  expect(frame).not.toContain("/help");
  await screen.close();
});

test("a / later in a message, or a path, is plain text", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("fix /etc/hosts");
  await screen.settle();
  expect(screen.frame()).not.toContain("/goal <outcome>");
  await screen.press("RETURN");
  await screen.waitFor("Process requests: fix /etc/hosts");
  await screen.type("/usr/bin/env");
  await screen.settle();
  expect(screen.frame()).not.toContain("No matching commands");
  await screen.press("RETURN");
  await screen.waitFor("Process requests: /usr/bin/env");
  // A command that takes no argument, given one, is a message too.
  await screen.type("/help me with this");
  await screen.press("RETURN");
  await screen.waitFor("Process requests: /help me with this");
  expect(current.fake.sent.map((sent) => sent.text)).toEqual([
    "fix /etc/hosts",
    "/usr/bin/env",
    "/help me with this",
  ]);
  await screen.close();
});

test("a command typed in full and sent runs, as from the popup", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  // Keys that land together: the name and Enter before the popup's next render.
  await screen.inAct(async () => {
    await screen.view.mockInput.typeText("/help");
    screen.view.mockInput.pressEnter();
  });
  await screen.waitFor("Every command and key");
  await screen.press("ESCAPE");
  await screen.type("/new");
  await screen.press("ESCAPE");
  await screen.press("RETURN");
  await screen.waitFor("New Tag");
  expect(current.fake.sent).toEqual([]);
  await screen.close();
});

test("the palette and Keyboard shortcuts list the registry's commands", async () => {
  current = setup();
  const screen = await render(current, { width: 120, height: 50 });
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  const palette = await screen.waitFor("Search Tags");
  for (const entry of availableCommands({ tag: true })) {
    if (entry.palette === false) expect(palette).not.toContain(entry.title);
    else expect(palette).toContain(entry.title);
  }
  await screen.type("keyboard");
  await screen.press("RETURN");
  const help = await screen.waitFor("Every command and key");
  for (const entry of COMMANDS) {
    expect(help).toContain(shortcutKeys(entry));
    expect(help).toContain(entry.description);
  }
  await screen.close();
});
