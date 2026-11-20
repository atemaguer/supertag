/**
 * Screen tests: the terminal UI against an in-memory Gateway, in OpenTUI's test renderer.
 * Run with `bun test` in apps/tui.
 */
import { afterEach, expect, test } from "bun:test";
import { FakeGateway } from "./fake-gateway";
import { render, reset, type Setup, setup, TAGS } from "./harness";

let current: Setup | undefined;
afterEach(() => {
  reset(current);
  current = undefined;
});

test("lists the lead first and shows its conversation's Markdown", async () => {
  const fake = new FakeGateway(TAGS);
  fake.addTurn(
    "lead",
    "What changed?",
    "## Summary\n\nThe **cache** keys on `width`.\n\n- one\n- two",
  );
  current = setup(fake);
  const screen = await render(current, { width: 100, height: 30 });
  const frame = await screen.waitFor("The cache keys on width");
  const rail = frame.split("\n").map((line) => line.slice(0, 30));
  const leadRow = rail.findIndex((line) => line.includes("lead"));
  const engineerRow = rail.findIndex((line) => line.includes("engineer"));
  expect(leadRow).toBeGreaterThan(-1);
  expect(leadRow).toBeLessThan(engineerRow);
  expect(frame).toContain("★lead");
  expect(frame).toContain("What changed?");
  expect(frame).toContain("Summary");
  expect(frame).not.toContain("**cache**");
  await screen.close();
});

test("sends a message, shows it at once, then the reply and its delivery", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("hello there");
  await screen.press("RETURN");
  await screen.waitFor("Process requests: hello there");
  expect(current.fake.sent.map((sent) => sent.text)).toEqual(["hello there"]);
  expect(screen.frame()).toContain("Seen");
  await screen.close();
});

test("keeps a message that was not delivered, retries it with its operation, or edits it", async () => {
  const fake = new FakeGateway(TAGS);
  fake.refuseSends = "the Gateway is restarting";
  current = setup(fake);
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("try me");
  await screen.press("RETURN");
  await screen.waitFor("! Not delivered");
  expect(screen.frame()).toContain("Ctrl-R retry");
  fake.refuseSends = undefined;
  await screen.press("r", { ctrl: true });
  await screen.waitFor("Process requests: try me");
  expect(fake.sent).toHaveLength(1);

  fake.refuseSends = "still down";
  await screen.type("second");
  await screen.press("RETURN");
  await screen.waitFor("! Not delivered");
  await screen.press("x", { ctrl: true });
  await screen.waitFor(/second\s*│/u);
  expect(screen.frame()).not.toContain("! Not delivered");
  await screen.close();
});

test("streams the text a running turn writes, then its result", async () => {
  const fake = new FakeGateway(TAGS);
  fake.autoReply = false;
  current = setup(fake);
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("write it");
  await screen.press("RETURN");
  await screen.waitFor("write it");
  const taskId = fake.turnsOf("lead").at(-1)?.taskId as string;
  fake.writing("lead", taskId, "Working on **part one**");
  await screen.waitFor("Working on part one");
  fake.finish("lead", taskId, "All done: `ok`");
  await screen.waitFor("All done: ok");
  expect(screen.frame()).not.toContain("Working on part one");
  await screen.close();
});

test("Alt-digits switch Tags and keep each Tag's draft", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("draft for lead");
  await screen.press("2", { meta: true });
  await screen.waitFor("Message engineer");
  expect(screen.frame()).not.toContain("draft for lead");
  await screen.press("1", { meta: true });
  await screen.waitFor("draft for lead");
  await screen.close();
});

test("the palette finds a Tag by name and opens it", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.press("k", { ctrl: true });
  await screen.waitFor("Search Tags, conversations, settings");
  await screen.type("revi");
  await screen.press("RETURN");
  await screen.waitFor("Message reviewer");
  await screen.close();
});

test("/help from the composer opens Keyboard shortcuts, which lists the keys", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("/hel");
  await screen.waitFor("Every command and key");
  await screen.press("RETURN");
  await screen.waitFor("Fold the Tag list to initials");
  await screen.press("ESCAPE");
  await screen.close();
});

test("text from the Gateway shows escape sequences as text", async () => {
  const fake = new FakeGateway(TAGS);
  fake.addTurn("lead", "colour?", "red \u001b[31mALERT\u001b[0m done");
  current = setup(fake);
  const screen = await render(current);
  const frame = await screen.waitFor("ALERT");
  expect(frame).toContain("^[");
  await screen.close();
});

test("a launch paints the cached conversation before it connects", async () => {
  const fake = new FakeGateway(TAGS);
  fake.addTurn("lead", "cached question", "the cached answer");
  current = setup(fake);
  const first = await render(current);
  await first.waitFor("the cached answer");
  // The conversation cache writes after a short delay.
  await new Promise((resolve) => setTimeout(resolve, 700));
  await first.close();
  const root = current.root;
  reset();
  const offline = setup(new FakeGateway(TAGS), { root, connect: false });
  current = offline;
  const second = await render(offline);
  const frame = await second.waitFor("the cached answer");
  expect(frame).toContain("connecting…");
  await second.close();
});

test("a reply in another Tag's conversation notifies; the open one does not", async () => {
  const fake = new FakeGateway(TAGS);
  fake.addTurn("engineer", "earlier", "an earlier reply");
  current = setup(fake);
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.settle(10);
  expect(current.alerts).toEqual([]);
  const turn = fake.addTurn("engineer", "and now?", "a new reply from engineer");
  fake.changed("engineer", turn);
  for (let i = 0; i < 50 && current.alerts.length === 0; i++) await screen.settle(1);
  expect(current.alerts.map((alert) => alert.tagId)).toEqual(["engineer"]);
  await screen.close();
});

test("Ctrl-B folds the Tag list to initials, Tab and j move in it", async () => {
  current = setup();
  const screen = await render(current, { width: 80, height: 24 });
  await screen.waitFor("Message lead");
  await screen.press("b", { ctrl: true });
  const folded = await screen.waitFor("★LE");
  expect(folded).not.toContain("Tags");
  await screen.press("b", { ctrl: true });
  await screen.press("TAB");
  await screen.press("j");
  await screen.waitFor("Message engineer");
  await screen.close();
});

test("← on an empty message moves to the Tag list, and → back to the composer", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.press("ARROW_LEFT");
  // The list has the keyboard: j moves it from the Tag that was in front.
  await screen.press("j");
  await screen.waitFor("Message engineer");
  await screen.press("ARROW_RIGHT");
  await screen.type("jk");
  const frame = await screen.waitFor("jk");
  expect(frame).toContain("Message engineer");
  expect(frame).not.toContain("Message reviewer");
  await screen.close();
});

test("← with text before the cursor moves the cursor; at the start it moves to the Tag list", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("ab");
  await screen.press("ARROW_LEFT");
  await screen.type("X");
  await screen.waitFor("aXb");
  // The cursor is after X: two ← reach the start.
  await screen.press("ARROW_LEFT");
  await screen.press("ARROW_LEFT");
  await screen.type("Y");
  await screen.waitFor("YaXb");
  // After Y: one ← to the start, and the next moves to the list.
  await screen.press("ARROW_LEFT");
  await screen.press("ARROW_LEFT");
  await screen.press("j");
  await screen.waitFor("Message engineer");
  await screen.press("ARROW_RIGHT");
  await screen.type("QQ");
  await screen.waitFor("QQ");
  // The draft was kept as it was.
  await screen.press("k", { meta: true });
  const frame = await screen.waitFor("YaXb");
  expect(frame).not.toContain("YaXbj");
  await screen.close();
});

test("→ at the end of the text stays in the composer", async () => {
  current = setup();
  const screen = await render(current);
  await screen.waitFor("Message lead");
  await screen.type("ab");
  await screen.press("ARROW_RIGHT");
  await screen.type("c");
  await screen.waitFor("abc");
  await screen.type("j");
  await screen.waitFor("abcj");
  await screen.close();
});
