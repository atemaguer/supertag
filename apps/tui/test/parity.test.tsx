/**
 * Screen tests for what the Go terminal UI did that daily use relies on: paste, the connection
 * going away and coming back, why connecting failed while the cache shows, the palette's keys,
 * Ctrl-digit, narrow terminals, and long messages. Run with `bun test` in apps/tui.
 */
import { afterEach, expect, test } from "bun:test";
import { FakeGateway } from "./fake-gateway";
import { render, reset, type Setup, setup, TAGS } from "./harness";

let current: Setup | undefined;
afterEach(() => {
  reset(current);
  current = undefined;
});

const lastLine = (frame: string) => frame.trimEnd().split("\n").at(-1) ?? "";

test("pasted lines join with spaces in the composer, and send as one message", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.view.mockInput.pasteBracketedText("first line\nsecond line\r\nthird\n");
  await screen.settle(2);
  await screen.waitFor("first line second line third");
  await screen.press("RETURN");
  await screen.waitFor("Process requests: first line second line third");
  expect(current.fake.sent.map((sent) => sent.text)).toEqual(["first line second line third"]);
  await screen.close();
});

test("the status line says when the Gateway stops answering, and when it answers again", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Local · connected");
  current.fake.watchUnavailable(true);
  await screen.waitFor("not answering, reconnecting…");
  current.fake.watchUnavailable(false);
  await screen.waitFor("Local · connected", 400);
  await screen.close();
});

test("why connecting failed shows in full above the cached screen", async () => {
  current = setup(new FakeGateway(TAGS), { connect: false });
  const why =
    "This app speaks SuperTag protocol 7, but the Gateway at http://127.0.0.1:1 runs SuperTag 0.2.9 (protocol 6). Upgrade the Gateway.";
  current.controller.status = { kind: "failed", problem: why };
  const screen = await render(current, { width: 100, height: 24 });
  const frame = await screen.waitFor("Upgrade the Gateway.");
  expect(frame).toContain("runs SuperTag 0.2.9");
  expect(lastLine(frame)).toContain("Local · not connected ·");
  await screen.close();
});

test("the palette opens a Tag with Alt-N, finds one by its latest message, and Ctrl-K closes it", async () => {
  const fake = new FakeGateway(TAGS);
  fake.addTurn("reviewer", "Check the flaky migration", "Looked at it.");
  current = setup(fake);
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  await screen.waitFor("Search Tags");
  await screen.press("k", { ctrl: true });
  for (let i = 0; i < 50 && screen.frame().includes("Search Tags"); i++) await screen.settle(1);
  expect(screen.frame()).not.toContain("Search Tags");

  await screen.press("k", { ctrl: true });
  await screen.type("Looked at");
  const found = await screen.waitFor("reviewer");
  expect(found).not.toContain("Nothing matches.");
  await screen.press("RETURN");
  await screen.waitFor("Check the flaky migration");

  await screen.press("k", { ctrl: true });
  await screen.waitFor("Search Tags");
  await screen.press("1", { meta: true });
  for (let i = 0; i < 50 && screen.frame().includes("Search Tags"); i++) await screen.settle(1);
  await screen.waitFor("Message lead");
  await screen.close();
});

test("Ctrl-digit opens a Tag where the terminal reports it", async () => {
  const fake = new FakeGateway(TAGS);
  fake.addTurn("engineer", "status?", "Engineer here.");
  current = setup(fake);
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.press("2", { ctrl: true });
  await screen.waitFor("Engineer here.");
  await screen.close();
});

test("a narrow terminal keeps most of its width for the conversation", async () => {
  const fake = new FakeGateway(TAGS);
  fake.addTurn("lead", "hi", "A reply that should stay readable");
  current = setup(fake);
  const screen = await render(current, { width: 50, height: 20 });
  const frame = await screen.waitFor("A reply that");
  const top = frame.split("\n")[0] ?? "";
  // The rail's box ends at its corner; it may take at most 40% of 50 columns.
  expect(top.indexOf("┐")).toBeLessThan(20);
  await screen.close();
});

test("a very long message and a wide code block keep the composer and status line on screen", async () => {
  const fake = new FakeGateway(TAGS);
  const wide = `const x = ${Array.from({ length: 80 }, (_, i) => `v${i}`).join(" + ")};`;
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  fake.addTurn(
    "lead",
    `${long} 日本語 👍🏽 done`,
    `Here:\n\n\`\`\`ts\n${wide}\n\`\`\`\n\n${"Line of text. ".repeat(300)}\n\nThe end 🎉`,
  );
  current = setup(fake);
  const screen = await render(current, { width: 80, height: 24 });
  const frame = await screen.waitFor("The end");
  expect(frame).toContain("Message lead");
  expect(lastLine(frame)).toContain("Local · connected");
  for (const line of frame.split("\n")) expect([...line].length).toBeLessThanOrEqual(80);
  await screen.close();
});

test("another message can be sent while one waits, and Ctrl-R sends both again in order", async () => {
  const fake = new FakeGateway(TAGS);
  fake.refuseSends = "the Gateway is restarting";
  current = setup(fake);
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("first");
  await screen.press("RETURN");
  await screen.waitFor("! Not delivered");
  await screen.type("second");
  await screen.press("RETURN");
  await screen.waitFor(/second[\s\S]*! Not delivered/u);
  // The composer took it: it is empty again.
  expect(screen.frame()).toContain("Message lead");
  fake.refuseSends = undefined;
  await screen.press("r", { ctrl: true });
  await screen.waitFor("Process requests: second");
  expect(fake.sent.map((sent) => sent.text)).toEqual(["first", "second"]);
  await screen.close();
});
