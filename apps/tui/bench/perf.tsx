/**
 * The performance budgets, on the real screen tree against the in-memory Gateway, in OpenTUI's
 * test renderer (native layout and cell diffing, no terminal write):
 *   keystroke: 30 Tags, 20 Objectives, 15 inbox items, 3 Teams, the lead's conversation of 300
 *     Markdown turns; one key → committed frame.
 *     Budget p95 ≤ 8 ms at 250×70.
 *   streaming: the running turn's follow pushes pages of 32 text updates; the longest the event
 *     loop is blocked while a page lands and draws. Budget ≤ 16 ms. Keys typed between pages
 *     arrive in order.
 *   first frame: from rendering the tree to the first frame showing the latest reply.
 *   memory: RSS after the 300-turn conversation rendered. Budget ≤ 250 MB.
 * Exits 1 when a budget is missed.
 *   bun bench/perf.tsx [--json]
 */
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { InboxItemKind } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import { App } from "../src/app";
import { FakeGateway, type FakeTag } from "../test/fake-gateway";
import { reset, setup } from "../test/harness";

const reply = (i: number) =>
  `## Plan ${i}\n\nI read the **failing test** and found the cause:\n\n` +
  "- the cache keys on `width` only\n- the rail rebuilds on every frame\n- a third point with a [link](https://example.com)\n\n" +
  "```ts\nfunction view(model: Model): string {\n  return render(model);\n}\n```\n\n" +
  `That is all for step ${i}.`;

function gateway(turns: number) {
  const tags: FakeTag[] = Array.from({ length: 30 }, (_, i) => ({
    tagId: i === 0 ? "lead" : `tag-${String(i).padStart(2, "0")}`,
    lead: i === 0,
  }));
  const fake = new FakeGateway(tags);
  const start = Date.now() - turns * 60_000;
  for (let i = 0; i < turns; i++) {
    fake.addTurn(
      "lead",
      `Please look at step ${i} of the plan and tell me what breaks.`,
      reply(i),
      start + i * 60_000,
    );
  }
  for (let i = 1; i < 30; i++)
    fake.addTurn(tags[i]?.tagId as string, "status?", `All good on ${i}.`);
  fake.objectives = Array.from({ length: 20 }, (_, i) => ({
    objectiveId: `objective-${i}`,
    ownerTagId: tags[i % 30]?.tagId as string,
    outcome: `Ship part ${i} of the plan`,
    budgetLimitMinor: 30_000n,
    budgetCurrency: "USD",
    reportedSpendMinor: BigInt(i * 100),
    startingTaskId: `start-${i}`,
  }));
  fake.inbox = Array.from({ length: 15 }, (_, i) => ({
    key: `question/${i}`,
    kind: i % 2 ? InboxItemKind.APPROVAL : InboxItemKind.QUESTION,
    taskId: `task-q${i}`,
    objectiveId: `objective-${i}`,
    question: `Which branch should part ${i} use?`,
  }));
  fake.teams = Array.from({ length: 3 }, (_, i) => ({
    teamId: `team-${i}`,
    name: `Team ${i}`,
    memberTagIds: tags.slice(0, 5).map((tag) => tag.tagId),
  }));
  return fake;
}

const ms = (ns: number) => ns / 1e6;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
};
const summary = (values: number[]) => ({
  n: values.length,
  mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3),
  p50: +percentile(values, 50).toFixed(3),
  p95: +percentile(values, 95).toFixed(3),
  max: +Math.max(...values).toFixed(3),
});
const quiet = async (work: () => void | Promise<void>) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    await work();
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
};

async function mount(turns: number, width: number, height: number) {
  const given = setup(gateway(turns));
  const began = Bun.nanoseconds();
  const view = await testRender(
    <App controller={given.controller} onQuit={() => {}} notifyLevel="off" onAlert={() => {}} />,
    { width, height, nativeSceneVerify: false },
  );
  for (let i = 0; i < 400; i++) {
    await quiet(() => new Promise((resolve) => setTimeout(resolve, 2)));
    await view.renderOnce();
    if (view.captureCharFrame().includes(`That is all for step ${turns - 1}`)) break;
  }
  const firstFrame = ms(Bun.nanoseconds() - began);
  return { given, view, firstFrame };
}

async function typing(turns: number, width: number, height: number, samples = 300) {
  const { given, view, firstFrame } = await mount(turns, width, height);
  for (let i = 0; i < 20; i++) {
    await quiet(() => view.mockInput.pressKey("a"));
    await view.renderOnce();
  }
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const began = Bun.nanoseconds();
    await quiet(() => view.mockInput.pressKey(i % 2 === 0 ? "b" : "BACKSPACE"));
    await view.renderOnce();
    times.push(ms(Bun.nanoseconds() - began));
  }
  const typed = view.captureCharFrame().includes("aaaa");
  given.controller.close();
  await view.dispose();
  reset(given);
  return { firstFrameMs: +firstFrame.toFixed(1), keystroke: summary(times), typed };
}

/** The longest gap between event-loop turns while `work` runs. */
async function longestStall(work: () => Promise<void>): Promise<number> {
  let last = Bun.nanoseconds();
  let longest = 0;
  let running = true;
  const probe = () => {
    const now = Bun.nanoseconds();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) setImmediate(probe);
  };
  setImmediate(probe);
  await work();
  running = false;
  return ms(longest);
}

async function streaming(turns: number, width: number, height: number, pages = 40) {
  const { given, view } = await mount(turns, width, height);
  const fake = given.fake;
  fake.autoReply = false;
  await quiet(() => view.mockInput.typeText("go"));
  await quiet(() => view.mockInput.pressKey("RETURN"));
  for (let i = 0; i < 50; i++) {
    await quiet(() => new Promise((resolve) => setTimeout(resolve, 2)));
    await view.renderOnce();
  }
  const taskId = fake.turnsOf("lead").at(-1)?.taskId as string;
  const stalls: number[] = [];
  let text = "";
  for (let page = 0; page < pages; page++) {
    stalls.push(
      await longestStall(async () => {
        for (let i = 0; i < 32; i++) {
          text += `page ${page} word ${i} `;
          fake.writing("lead", taskId, text);
        }
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          await view.renderOnce();
        }
      }),
    );
  }
  const streamed = view.captureCharFrame().includes(`page ${pages - 1} word 31`);
  // Keys typed between streamed pages arrive in order.
  const typed = "the quick brown fox";
  for (const [index, character] of [...typed].entries()) {
    fake.writing("lead", taskId, `${text} interleaved ${index}`);
    await quiet(() => view.mockInput.pressKey(character));
    await view.renderOnce();
  }
  await view.renderOnce();
  const keysInOrder = view.captureCharFrame().includes(typed);
  const rssMb = +(process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  given.controller.close();
  await view.dispose();
  reset(given);
  return { pageStall: summary(stalls), streamed, keysInOrder, rssMbAfter: rssMb };
}

const results = {
  runtime: `bun ${Bun.version}`,
  typing300_160x50: await typing(300, 160, 50),
  typing300_250x70: await typing(300, 250, 70),
  streaming300_160x50: await streaming(300, 160, 50),
  streaming300_250x70: await streaming(300, 250, 70),
};
const budgets = {
  "keystroke p95 at 250×70 ≤ 8 ms": results.typing300_250x70.keystroke.p95 <= 8,
  "streamed page blocks input ≤ 16 ms (p95, 250×70)":
    results.streaming300_250x70.pageStall.p95 <= 16,
  "every streamed page drew":
    results.streaming300_160x50.streamed && results.streaming300_250x70.streamed,
  "keys typed during a stream arrive in order":
    results.streaming300_160x50.keysInOrder && results.streaming300_250x70.keysInOrder,
  "RSS after 300 turns ≤ 250 MB": results.streaming300_250x70.rssMbAfter <= 250,
};
console.log(JSON.stringify({ ...results, budgets }, null, 2));
process.exit(Object.values(budgets).every(Boolean) ? 0 : 1);
