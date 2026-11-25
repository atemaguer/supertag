#!/usr/bin/env node
// Whether a Tag's memory helps, per harness: a scripted multi-Session scenario on a throwaway
// local deployment, scored from what later turns saw and said, with the Worker Host's memory
// counters. CONTRIBUTING.md ("Memory eval") describes both modes and the live mode's cost.
//
//   node tests/evals/memory/run.mjs --cli PATH --adapter PATH [--harness H,...] [--json] [--keep]
//   node tests/evals/memory/run.mjs --live --cli PATH --credentials-file FILE --yes-spend [...]
//
// The fixture mode (the default) runs the fixture adapter as each harness and checks the
// plumbing: what one Session taught is in a later Session's context, in the right store; a Work
// Session only proposes, and each store's daily review merges or drops its proposals; two people's
// stores stay apart. The live mode runs the real harnesses and scores their replies. Both need a
// CLI built with `--features test-fixtures`, whose Control Plane clock the eval moves a day ahead
// so the daily reviews run at once.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const HARNESSES = ["claude-code", "codex", "opencode", "cursor"];
/** The live mode's turns per harness, at most: the scenario's, its Work Sessions', the padding
 * each store's review waits for, and the reviews. */
export const LIVE_TURN_CAP = 48;
/** The live mode's limit on each submitted turn's reported tokens. */
export const LIVE_TURN_TOKENS = 400_000;
/** Each store's daily review waits for this many of its turns, and a day after its first. */
const REVIEW_AFTER_TURNS = 10;
const DAY_AND_AN_HOUR_MS = 25 * 60 * 60 * 1000;
/** The second person, a User whose device joined with their invite key. */
const SECOND_PERSON = "bob-eval";

/** The scope the Worker Host names a person's store by. */
export function personScope(principal) {
  return `person-${createHash("sha256").update(principal).digest("hex").slice(0, 32)}`;
}

/**
 * The scenario, in order. A step runs in a Session of its own the operator starts (`session`),
 * in the operator's conversation (`conversation`), in the second person's conversation
 * (`second`), or as an Objective (`objective`), whose Session is shared. In single-player local,
 * the operator's Sessions and conversation share one store, private to the operator; the second
 * person's conversation has a store private to them; an Objective's Sessions share the Tag's
 * shared store. Each store's daily review keeps it. `fixture` is the fixture's script and `live`
 * what a person says; `expect` checks the memory the turn started with (fixture) or its reply
 * (live). `proposals` waits for a Work Session's proposals in a store (`shared`, `operator`, or
 * `second`). `{h}` is the harness.
 */
export const STEPS = [
  {
    id: "teach",
    session: true,
    fixture: [
      "remember merge-style | feedback | Prefer squash merges for pull requests",
      "remember staging-region | project | Staging runs in eu-north-1",
    ],
    live: "Please remember this for future conversations: I prefer squash merges for pull requests, and our staging environment runs in eu-north-1. Save both to your memory now.",
  },
  {
    id: "recall",
    session: true,
    fixture: ["recall"],
    live: "Without searching any repository: which merge style do I prefer, and which region does staging run in? Answer in one line.",
    expect: [
      { check: "a later Session has the preference", has: "squash" },
      { check: "a later Session has the fact", has: "eu-north-1" },
      { check: "the fact loads with the turn", loaded: "eu-north-1", codex: false },
    ],
  },
  {
    id: "correct",
    session: true,
    fixture: [
      "remember merge-style | feedback | Prefer rebase merges; squash only single-commit pull requests",
    ],
    live: "Correction: I now prefer rebase merges, and squash only single-commit pull requests. Update your memory.",
  },
  {
    id: "recall-correction",
    session: true,
    fixture: ["recall"],
    live: "Which merge style do I prefer? Answer in a few words.",
    expect: [
      { check: "the correction is honoured", has: "rebase" },
      { check: "the corrected preference is gone", lacks: "Prefer squash merges" },
    ],
  },
  {
    id: "work",
    session: true,
    fixture: [
      "work {h}-work-child :: remember staging-region | project | Staging moved to us-east-1 on 2026-11-20 ;; remember ci-cache | project | (unverified) The CI cache is flaky",
    ],
    live: "Start a Work Session on yourself whose instruction is: note in your memory that staging moved to us-east-1 on 2026-11-20. Then tell me you started it.",
    proposals: { store: "operator", count: 2 },
  },
  {
    id: "proposed-only",
    session: true,
    fixture: ["recall"],
    live: "Which region does staging run in? Answer in one line.",
    expect: [
      { check: "a Work Session's change waits as a proposal for the review", lacks: "us-east-1" },
    ],
  },
  {
    id: "conversation",
    conversation: true,
    fixture: ["recall"],
    live: "Which merge style do I prefer? Answer in a few words.",
    expect: [{ check: "the operator's conversation shares their Sessions' memory", has: "rebase" }],
  },
  {
    id: "shared-teach",
    objective: true,
    fixture: [
      "remember team-channel | project | The team channel is #releases",
      "work {h}-shared-child :: remember team-channel | project | The team channel moved to #payments-eng ;; remember login-test | project | (unverified) The login test is flaky",
    ],
    live: "Record in your memory that the team channel is #releases. Then start a Work Session on yourself whose instruction is: note in your memory that the team channel moved to #payments-eng. Report the Objective done once the Work Session has reported.",
    expect: [{ check: "a person's memory stays out of shared Sessions", lacks: "rebase" }],
    proposals: { store: "shared", count: 2 },
  },
  {
    id: "person-recall",
    session: true,
    fixture: ["recall"],
    live: "What is the team channel? If you don't know, say unknown.",
    expect: [{ check: "shared memory stays out of a person's Sessions", lacks: "#releases" }],
  },
  {
    id: "second-teach",
    second: true,
    fixture: ["remember editor | user | I edit code in Helix"],
    live: "Please remember for future conversations that I edit code in Helix. Save it to your memory now.",
  },
  {
    id: "second-recall",
    second: true,
    fixture: ["recall"],
    live: "Which editor do I use, and which merge style do I prefer? Say unknown for what you don't know.",
    expect: [
      { check: "the second person's conversation has their memory", has: "Helix" },
      { check: "the operator's memory stays out of the second person's", lacks: "rebase" },
      { check: "shared memory stays out of the second person's", lacks: "#releases" },
    ],
  },
  {
    id: "operator-recall-second",
    session: true,
    fixture: ["recall"],
    live: "Which editor do I use? If you don't know, say unknown.",
    expect: [{ check: "the second person's memory stays out of the operator's", lacks: "Helix" }],
  },
  { id: "review", review: true },
  {
    id: "recall-merged",
    session: true,
    fixture: ["recall"],
    live: "Which region does staging run in? Answer in one line.",
    expect: [
      { check: "the private review fixed the stale fact", has: "us-east-1" },
      { check: "the stale fact is gone", lacks: "eu-north-1" },
      { check: "the unverified proposal was dropped", lacks: "CI cache" },
      // Codex loads only its summary, which its review consolidates: here a private one.
      { check: "the merged fact loads with the turn", loaded: "us-east-1" },
    ],
  },
  {
    id: "shared-recall",
    objective: true,
    fixture: ["recall"],
    live: "From your memory, say which channel is the team channel in one line, then report the Objective done.",
    expect: [
      { check: "the review fixed the stale shared fact", has: "#payments-eng" },
      { check: "the stale shared fact is gone", lacks: "#releases" },
      { check: "the review dropped the unverified proposal", lacks: "login test" },
      { check: "the reviewed fact loads with the turn", loaded: "#payments-eng" },
    ],
  },
  {
    id: "second-recall-after",
    second: true,
    fixture: ["recall"],
    live: "Which editor do I use, and where does staging run? Say unknown for what you don't know.",
    expect: [
      { check: "the second person's review kept their memory", has: "Helix" },
      { check: "their review took nothing from the operator's", lacks: "us-east-1" },
      { check: "the second person's reviewed memory loads with the turn", loaded: "Helix" },
    ],
  },
];

function parse(argv) {
  const options = { harnesses: HARNESSES, live: false, json: false, keep: false, models: {} };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--cli") options.cli = resolve(value());
    else if (arg === "--adapter") options.adapter = resolve(value());
    else if (arg === "--credentials-file") options.credentials = resolve(value());
    else if (arg === "--harness") options.harnesses = value().split(",");
    else if (arg === "--model") {
      // HARNESS=MODEL, the host's model for that harness: OpenCode needs a provider/model.
      const [harness, model] = value().split("=", 2);
      if (!model) throw new Error("--model HARNESS=MODEL");
      options.models[harness] = model;
    } else if (arg === "--live") options.live = true;
    else if (arg === "--yes-spend") options.spend = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`unknown option ${arg}`);
  }
  for (const harness of options.harnesses)
    if (!HARNESSES.includes(harness)) throw new Error(`unknown harness ${harness}`);
  if (!options.cli) throw new Error("--cli PATH: a supertag built with --features test-fixtures");
  if (options.live) {
    // Live turns spend the operator's provider credit: only with their file and their word.
    if (!options.credentials)
      throw new Error("--live needs --credentials-file FILE with the harnesses' provider keys");
    if (!options.spend)
      throw new Error(
        `--live runs up to ${LIVE_TURN_CAP} real turns per harness; add --yes-spend to accept the cost`,
      );
    if (options.harnesses.includes("opencode") && !options.models.opencode)
      throw new Error("OpenCode needs --model opencode=PROVIDER/MODEL");
  } else if (!options.adapter) throw new Error("--adapter PATH: the supertag-fixture-adapter");
  return options;
}

function run(file, args, environment, { timeoutMs = 120_000 } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(file, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(stdout);
      else
        fail(
          new Error(`supertag ${args.slice(0, 3).join(" ")} failed (${code}): ${stderr.trim()}`),
        );
    });
  });
}

async function waitFor(what, deadlineMs, probe) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const FINISHED = ["TASK_STATE_SUCCEEDED", "TASK_STATE_FAILED", "TASK_STATE_CANCELLED"];

class Deployment {
  /**
   * `stateName` names the state directory under the deployment's root. By default it is longer
   * than a socket address holds, so the Worker Host must serve its memory from a short socket
   * elsewhere: every memory read below goes through it.
   */
  constructor(options, { stateName = `state-${"d".repeat(96)}`, prepare } = {}) {
    this.options = options;
    // A real path: the CLI refuses a state directory reached through a link (such as macOS's
    // /var).
    const parent = existsSync("/tmp") ? "/tmp" : tmpdir();
    this.root = mkdtempSync(join(realpathSync(parent), "stmem-"));
    this.state = join(this.root, stateName);
    this.reports = join(this.root, "reports");
    this.offset = join(this.root, "clock-offset");
    const home = join(this.root, "home");
    const temporary = join(this.root, "tmp");
    for (const directory of [this.state, this.reports, home, temporary]) {
      mkdirSync(directory, { recursive: true });
      chmodSync(directory, 0o700);
    }
    prepare?.(this.state);
    writeFileSync(this.offset, "0");
    // Only what the CLI needs: no credentials from this shell, and a home of its own, so no
    // harness finds the operator's own login, configuration, or keychain entries, and the second
    // person's saved Gateway stays in it.
    this.environment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: temporary,
      SUPERTAG_TEST_CLOCK_OFFSET_FILE: this.offset,
    };
    this.turns = new Map();
    this.wait = options.live ? 600_000 : 60_000;
  }

  config() {
    const host = this.options.live
      ? {
          type: "host",
          harnesses: this.options.harnesses,
          models: this.options.models,
          concurrency: 4,
        }
      : {
          type: "host",
          adapter: this.options.adapter,
          "adapter-args": [`--memory-eval=${this.reports}`],
          concurrency: 4,
        };
    return {
      version: 1,
      ...(this.options.live ? { env_file: this.options.credentials } : {}),
      services: {
        "control-plane": { type: "control-plane", ports: ["127.0.0.1:0"] },
        eval: host,
      },
    };
  }

  async start() {
    const file = join(this.root, "supertag.yaml");
    // JSON is YAML.
    writeFileSync(file, JSON.stringify(this.config(), null, 2));
    this.up = spawn(
      this.options.cli,
      ["up", "--foreground", "--state-directory", this.state, "--file", file],
      { env: this.environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    this.up.stderr.on("data", (chunk) => {
      log += chunk;
    });
    await new Promise((ready, fail) => {
      const timer = setTimeout(() => fail(new Error(`supertag up did not start: ${log}`)), 60_000);
      this.up.stdout.once("data", () => {
        clearTimeout(timer);
        ready();
      });
      this.up.once("exit", (code) => fail(new Error(`supertag up exited (${code}): ${log}`)));
    });
  }

  cli(args, options) {
    return run(
      this.options.cli,
      [...args, "--state-directory", this.state],
      this.environment,
      options,
    );
  }

  async json(args) {
    return JSON.parse(await this.cli(args));
  }

  /**
   * Enrolls the second person: the User bob-eval, who may talk to every eval Tag, with one device
   * joined by their invite key and saved as the Gateway `second` in this deployment's home. The
   * device acts for the User, so the person's store is the User's.
   */
  async enrollSecondPerson(tags) {
    const ps = await this.json(["ps", "--output", "json"]);
    const service =
      ps.services.find((row) => row.type === "gateway" && row.address) ??
      ps.services.find((row) => row.type === "control-plane" && row.address);
    if (!service) throw new Error("no local Gateway or Control Plane address to connect to");
    const url = /^[a-z]+:\/\//.test(service.address)
      ? service.address
      : `http://${service.address}`;
    const issued = await this.json([
      "user",
      "invite",
      SECOND_PERSON,
      "--display-name",
      "Bob",
      ...tags.flatMap((tag) => ["--tag", tag]),
    ]);
    const joined = JSON.parse(
      await run(
        this.options.cli,
        ["connect", url, "--name", "second", "--client-name", SECOND_PERSON],
        { ...this.environment, SUPERTAG_OPERATOR_TOKEN: issued.invite_key },
      ),
    );
    if (joined.connected_as !== `client:${SECOND_PERSON}`)
      throw new Error(`the second person's device joined as ${joined.connected_as}`);
    this.secondPrincipal = `user:${SECOND_PERSON}`;
    this.secondScope = personScope(this.secondPrincipal);
  }

  count(harness) {
    const turns = (this.turns.get(harness) ?? 0) + 1;
    if (this.options.live && turns > LIVE_TURN_CAP)
      throw new Error(`${harness} reached the live mode's cap of ${LIVE_TURN_CAP} turns`);
    this.turns.set(harness, turns);
  }

  async finished(taskId) {
    return waitFor(`Task ${taskId}`, this.wait, async () => {
      const task = await this.json(["get", "task", taskId]);
      return FINISHED.includes(task.state) ? task : undefined;
    });
  }

  /** One turn in a Session of its own; its result. */
  async submit(harness, session, prompt) {
    this.count(harness);
    const submitted = await this.json([
      "task",
      "submit",
      "--tag",
      `memeval-${harness}`,
      "--session",
      `${harness}-${session}`,
      ...(this.options.live ? ["--max-reported-tokens", String(LIVE_TURN_TOKENS)] : []),
      prompt,
    ]);
    const task = await this.finished(submitted.task_id);
    if (task.state !== "TASK_STATE_SUCCEEDED")
      throw new Error(`${harness} ${session}: ${task.state}: ${task.result ?? ""}`);
    return task.result ?? "";
  }

  /** One message in the operator's conversation; the reply. */
  message(harness, text) {
    this.count(harness);
    return this.cli(["message", `memeval-${harness}`, text], { timeoutMs: this.wait });
  }

  /** One message in the second person's conversation, from their device; the reply. */
  second(harness, text) {
    this.count(harness);
    return run(
      this.options.cli,
      ["message", `memeval-${harness}`, text, "--gateway", "second"],
      this.environment,
      { timeoutMs: this.wait },
    );
  }

  /** An Objective whose owner is the Tag; its first turn's result. */
  async objective(harness, id, outcome) {
    this.count(harness);
    const objective = `${harness}-${id}`;
    await this.json(["objective", "create", objective, "--owner", `memeval-${harness}`, outcome]);
    const session = (await this.json(["get", "objective", objective])).session_id;
    const first = await waitFor(`Objective ${objective}'s turn`, this.wait, async () => {
      const listed = await this.json([
        "get",
        "task",
        "--tag",
        `memeval-${harness}`,
        "--session",
        session,
      ]);
      return (listed.tasks ?? []).at(-1);
    });
    const task = await this.finished(first.task_id);
    if (task.state !== "TASK_STATE_SUCCEEDED")
      throw new Error(`${harness} ${id}: ${task.state}: ${task.result ?? ""}`);
    return task.result ?? "";
  }

  async memoryStats(harness) {
    const metrics = await this.json(["metrics", "--output", "json"]);
    return (metrics.memory ?? []).filter((store) => store.tag_id === `memeval-${harness}`);
  }

  /** One of the harness's stores: `shared`, the `second` person's, or the `operator`'s. */
  async store(harness, which) {
    return storeOf(await this.memoryStats(harness), which, this.secondScope);
  }

  report(label) {
    const path = join(this.reports, `${label}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  }

  /** The first review report of the harness's store `which`. */
  review(harness, which) {
    const scope = which === "shared" ? "shared" : which === "second" ? this.secondScope : undefined;
    const prefix = `${harness}-review-`;
    const name = readdirSync(this.reports)
      .filter((file) => file.startsWith(prefix) && file.endsWith("-1.json"))
      .find((file) => {
        const of = file.slice(prefix.length, -"-1.json".length);
        return scope ? of === scope : of !== "shared" && of !== this.secondScope;
      });
    return name ? JSON.parse(readFileSync(join(this.reports, name), "utf8")) : undefined;
  }

  async stop() {
    if (this.up && this.up.exitCode === null) {
      this.up.kill("SIGTERM");
      await new Promise((done) => {
        const timer = setTimeout(() => {
          this.up.kill("SIGKILL");
          done();
        }, 30_000);
        this.up.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    if (!this.options.keep) rmSync(this.root, { recursive: true, force: true });
  }
}

/** One of a harness's stores in `supertag metrics`: `shared`, `second`, or `operator`. */
function storeOf(stores, which, secondScope) {
  return stores.find((store) =>
    which === "shared"
      ? store.shared
      : which === "second"
        ? store.scope === secondScope
        : !store.shared && store.scope !== secondScope,
  );
}

/** Scores one step: the memory its turn started with (fixture), or its reply (live). */
export function score(step, harness, observation, live) {
  const report = observation.report ?? {};
  const loaded = report.loaded ?? "";
  const all = live
    ? (observation.reply ?? "")
    : `${loaded}\n${Object.values(report.memories ?? {}).join("\n")}`;
  const contains = (text, needle) => text.toLowerCase().includes(needle.toLowerCase());
  return (step.expect ?? []).flatMap((expectation) => {
    // Only the fixture sees what the turn loaded and was shown.
    if (live && (expectation.fixture || expectation.loaded || expectation.proposals)) return [];
    if (expectation.proposals !== undefined) {
      const got = (report.proposals ?? []).length;
      return [{ check: expectation.check, pass: got === expectation.proposals }];
    }
    if (expectation.loaded !== undefined) {
      // Codex loads its ad hoc notes only once a review folds them into its summary.
      const want = !(harness === "codex" && expectation.codex === false);
      const got = contains(loaded, expectation.loaded);
      return [
        { check: `${expectation.check}${want ? "" : " (not for Codex)"}`, pass: got === want },
      ];
    }
    if (expectation.has !== undefined)
      return [{ check: expectation.check, pass: contains(all, expectation.has) }];
    return [{ check: expectation.check, pass: !contains(all, expectation.lacks) }];
  });
}

function script(step, harness) {
  return [`memory-eval ${harness}-${step.id}`, ...step.fixture]
    .join("\n")
    .replaceAll("{h}", harness);
}

async function runStep(deployment, harness, step, live) {
  const prompt = live ? step.live : script(step, harness);
  const reply = step.conversation
    ? await deployment.message(harness, prompt)
    : step.second
      ? await deployment.second(harness, prompt)
      : step.objective
        ? await deployment.objective(harness, step.id, prompt)
        : await deployment.submit(harness, step.id, prompt);
  if (step.proposals) {
    // The Work Session's own turn runs after its parent's: wait for what it proposed.
    const wanted = live ? 1 : step.proposals.count;
    const waited = waitFor(`${harness}'s Work Session proposals`, deployment.wait, async () => {
      const store = await deployment.store(harness, step.proposals.store);
      return (store?.counters?.proposals_created ?? 0) >= wanted;
    });
    // A live harness may not start the Work Session; the counters will say so.
    await (live ? waited.catch(() => {}) : waited);
  }
  const observation = {
    reply,
    report: live ? undefined : deployment.report(`${harness}-${step.id}`),
  };
  if (!live && !observation.report)
    throw new Error(`${harness} ${step.id}: the fixture reported nothing`);
  return { step: step.id, checks: score(step, harness, observation, live), reply };
}

/**
 * One harness's scenario up to the review, then turns enough in each store (the operator's, the
 * second person's, and the shared one) for its review.
 */
async function beforeReview(deployment, harness, live) {
  const results = [];
  for (const step of STEPS) {
    if (step.review) break;
    results.push(await runStep(deployment, harness, step, live));
  }
  const pad = (index) => (live ? "Reply with OK." : `memory-eval ${harness}-pad-${index}`);
  // The steps count some turns of each store, and the Work Sessions' report turns count in
  // theirs; pad each store to the turns its review waits for, and one more for good measure.
  for (let index = 0; index < REVIEW_AFTER_TURNS - 6; index++)
    await deployment.submit(harness, `pad-${index}`, pad(index));
  for (let index = 0; index < REVIEW_AFTER_TURNS - 1; index++)
    await deployment.second(harness, pad(`second-${index}`));
  for (let index = 0; index < REVIEW_AFTER_TURNS - 1; index++)
    await deployment.objective(harness, `pad-shared-${index}`, pad(`shared-${index}`));
  return results;
}

/** The fixture's checks of one store's review. */
function reviewChecks(deployment, harness, which, counters, others) {
  const report = deployment.review(harness, which);
  if (!report) return [{ check: `the ${which} store was reviewed`, pass: false }];
  const listed = report.listed ?? [];
  const checks = [
    {
      check: `the ${which} review listed only its own Sessions`,
      pass: listed.length > 0 && listed.every((session) => !others.includes(session)),
    },
  ];
  if (which !== "second")
    checks.push(
      {
        check: `the ${which} review's request listed both proposals`,
        pass: (report.proposals ?? []).length === 2,
      },
      {
        check: `the ${which} review merged one proposal and dropped one`,
        pass: (counters.proposals_merged ?? 0) >= 1 && (counters.proposals_dropped ?? 0) >= 1,
      },
    );
  if (harness === "codex")
    checks.push({
      check: `the ${which} review consolidated Codex's notes`,
      pass: (report.did ?? []).includes("consolidate"),
    });
  return checks;
}

/** Each store's daily review, then the steps after it. */
async function afterReview(deployment, harness, live) {
  const stores = await waitFor(`${harness}'s daily reviews`, live ? 900_000 : 150_000, async () => {
    const stores = await deployment.memoryStats(harness);
    return ["shared", "operator", "second"].every(
      (which) => (storeOf(stores, which, deployment.secondScope)?.counters?.review_turns ?? 0) >= 1,
    )
      ? stores
      : undefined;
  });
  if (live) for (let index = 0; index < 3; index++) deployment.count(harness);
  const counters = (which) => storeOf(stores, which, deployment.secondScope).counters;
  const checks = [
    {
      check: "each review with proposals merged one",
      pass: ["shared", "operator"].every((which) => (counters(which).proposals_merged ?? 0) >= 1),
    },
  ];
  if (!live) {
    // Which Sessions are whose, from the reports of the turns that ran in them.
    const sessionsOf = (filter) =>
      STEPS.filter(filter)
        .map((step) => deployment.report(`${harness}-${step.id}`)?.session_id)
        .filter(Boolean);
    const operator = sessionsOf((step) => step.session || step.conversation);
    const second = sessionsOf((step) => step.second);
    const shared = sessionsOf((step) => step.objective);
    checks.push(
      ...reviewChecks(deployment, harness, "operator", counters("operator"), [
        ...second,
        ...shared,
      ]),
      ...reviewChecks(deployment, harness, "second", counters("second"), [...operator, ...shared]),
      ...reviewChecks(deployment, harness, "shared", counters("shared"), [...operator, ...second]),
    );
  }
  const results = [{ step: "review", checks }];
  for (const step of STEPS.slice(STEPS.findIndex((step) => step.review) + 1))
    results.push(await runStep(deployment, harness, step, live));
  return results;
}

function counterChecks(stores, secondScope, live) {
  const person = storeOf(stores, "operator", secondScope)?.counters ?? {};
  const second = storeOf(stores, "second", secondScope)?.counters ?? {};
  const shared = storeOf(stores, "shared", secondScope)?.counters ?? {};
  const checks = [
    // Codex loads only its summary, which only a review consolidates: its turns load a store's
    // memory once that store was reviewed, private stores too.
    { check: "turns that loaded memory were counted", pass: (person.turns_loaded ?? 0) >= 1 },
    {
      check: "the second person's turns loaded their memory",
      pass: (second.turns_loaded ?? 0) >= 1,
    },
    { check: "memories written were counted", pass: (person.written ?? 0) >= 1 },
    { check: "the shared store is counted apart", pass: (shared.turns ?? 0) >= 1 },
    {
      check: "each store was reviewed",
      pass: [person, second, shared].every((counters) => (counters.review_turns ?? 0) >= 1),
    },
  ];
  if (!live)
    checks.push(
      { check: "memory reads were counted", pass: (person.recalls ?? 0) >= 1 },
      {
        check: "each store counted its two proposals, one merged and one dropped",
        pass: [person, shared].every(
          (counters) =>
            counters.proposals_created === 2 &&
            counters.proposals_merged === 1 &&
            counters.proposals_dropped === 1,
        ),
      },
    );
  return checks;
}

/**
 * A Worker Host whose memory endpoint can't listen says why, in `supertag get memories` and
 * `supertag status`, rather than that no Worker Host runs: here a file that isn't a socket sits
 * where its socket goes.
 */
async function endpointFailureChecks(options) {
  const deployment = new Deployment(options, {
    stateName: "state",
    prepare: (state) => {
      mkdirSync(join(state, "hosts", "eval"), { recursive: true });
      writeFileSync(join(state, "hosts", "eval", "memory.sock"), "not a socket");
    },
  });
  try {
    await deployment.start();
    const listed = await waitFor("the memory endpoint's failure", deployment.wait, async () => {
      const listed = await deployment.json(["get", "memories"]);
      return /did not start/.test(listed.unavailable ?? "") ? listed : undefined;
    });
    const status = await deployment.cli(["status"]);
    return [
      {
        check: "get memories says the memory endpoint did not start, and why",
        pass:
          /is not a socket/.test(listed.unavailable) &&
          !/No Worker Host runs/.test(listed.unavailable),
      },
      {
        check: "supertag status says the memory endpoint did not start",
        pass: /memory endpoint did not start/.test(status),
      },
    ];
  } catch (error) {
    return [{ check: `the memory endpoint's failure is visible: ${error.message}`, pass: false }];
  } finally {
    await deployment.stop();
  }
}

export async function evaluate(options) {
  const deployment = new Deployment(options);
  const outcome = { mode: options.live ? "live" : "fixture", harnesses: {} };
  try {
    await deployment.start();
    for (const harness of options.harnesses)
      await deployment.cli([
        "tag",
        "put",
        `memeval-${harness}`,
        "--instructions",
        "Memory eval Tag. Keep your memory current.",
        ...(options.live ? ["--harness", harness] : []),
      ]);
    await deployment.enrollSecondPerson(options.harnesses.map((harness) => `memeval-${harness}`));
    const before = await Promise.allSettled(
      options.harnesses.map((harness) => beforeReview(deployment, harness, options.live)),
    );
    // Move the Control Plane's clock past a day: its maintenance sweep queues each store's
    // review within the next minute.
    writeFileSync(deployment.offset, String(DAY_AND_AN_HOUR_MS));
    const after = await Promise.allSettled(
      options.harnesses.map((harness, index) =>
        before[index].status === "fulfilled"
          ? afterReview(deployment, harness, options.live)
          : Promise.reject(before[index].reason),
      ),
    );
    for (const [index, harness] of options.harnesses.entries()) {
      const runs = [before[index], after[index]];
      const steps = runs.flatMap((run) => (run.status === "fulfilled" ? run.value : []));
      const failure = runs.find((run) => run.status === "rejected")?.reason;
      const stores = await deployment.memoryStats(harness).catch(() => []);
      steps.push({
        step: "counters",
        checks: counterChecks(stores, deployment.secondScope, options.live),
      });
      outcome.harnesses[harness] = {
        steps: steps.map(({ step, checks, reply }) => ({
          step,
          checks,
          ...(options.live && reply !== undefined ? { reply: reply.trim().slice(0, 400) } : {}),
        })),
        error: failure ? String(failure.message ?? failure) : undefined,
        turns: deployment.turns.get(harness) ?? 0,
        counters: stores,
      };
    }
  } finally {
    await deployment.stop();
  }
  // Every memory read above went through the Worker Host's short socket, as its state
  // directory is too deep for one beside it.
  outcome.endpoint = {
    steps: [
      {
        step: "endpoint",
        checks: [
          {
            check: "a state directory too deep for a socket still serves its memory",
            pass: Object.values(outcome.harnesses).some((result) => result.counters.length > 0),
          },
          ...(options.live ? [] : await endpointFailureChecks(options)),
        ],
      },
    ],
  };
  outcome.passed = [...Object.values(outcome.harnesses), outcome.endpoint].every(
    (result) =>
      !result.error && result.steps.every((step) => step.checks.every((check) => check.pass)),
  );
  return outcome;
}

/** The report: each harness's checks, then its counters, then the memory endpoint's. */
export function text(outcome) {
  const lines = [`Memory eval (${outcome.mode})`];
  for (const [harness, result] of Object.entries(outcome.harnesses)) {
    const checks = result.steps.flatMap((step) =>
      step.checks.map((check) => ({ step: step.step, ...check })),
    );
    const passed = checks.filter((check) => check.pass).length;
    lines.push("", `${harness}: ${passed}/${checks.length} checks passed in ${result.turns} turns`);
    for (const check of checks)
      lines.push(`  ${check.pass ? "pass" : "FAIL"}  ${check.step}: ${check.check}`);
    if (result.error) lines.push(`  error: ${result.error}`);
    for (const store of result.counters) {
      const c = store.counters;
      lines.push(
        `  ${store.shared ? "shared" : `private (${store.scope})`} store: ${store.memories} memories, ${store.proposals_waiting} proposals waiting, index ${store.loaded.lines} lines; ` +
          `${c.turns} turns (${c.review_turns} reviews, ${c.proposing_turns} proposing), ${c.turns_loaded} loaded memory (${c.loaded_lines} lines, ${c.truncated_turns} cut short), ${c.recalls} memory reads; ` +
          `written ${c.written}, updated ${c.updated}, deleted ${c.deleted}; reviews wrote ${c.review_written}, updated ${c.review_updated}, deleted ${c.review_deleted}; ` +
          `proposals ${c.proposals_created} created, ${c.proposals_merged} merged, ${c.proposals_dropped} dropped, ${c.proposals_expired} expired; ${c.seeds_delivered} seeds`,
      );
    }
  }
  if (outcome.endpoint) {
    lines.push("", "memory endpoint:");
    for (const check of outcome.endpoint.steps.flatMap((step) => step.checks))
      lines.push(`  ${check.pass ? "pass" : "FAIL"}  ${check.check}`);
  }
  lines.push("", outcome.passed ? "All checks passed." : "Some checks failed.");
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parse(process.argv.slice(2));
    const outcome = await evaluate(options);
    process.stdout.write(options.json ? `${JSON.stringify(outcome, null, 2)}\n` : text(outcome));
    process.exitCode = outcome.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`memory eval: ${error.message ?? error}\n`);
    process.exitCode = 2;
  }
}
