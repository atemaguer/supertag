// Runs real Codex Tasks against a private local Control Plane and a disposable Git repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const model = "gpt-6.1-sol";
const objective = "status-command";
const checkpoint = "STATUS-PRE-EDIT";
const expectedStatus = "status=ready\nschema=1\n";
const initialScript = "#!/bin/sh\nprintf '%s\\n' 'status=ready'\n";
const schemaLine = "printf '%s\\n' 'schema=1'";
const cli = process.env["SUPERTAG_WALKTHROUGH_CLI"] || "supertag";
const path = process.env["PATH"];
const codexHome = process.env["CODEX_HOME"] || join(homedir(), ".codex");
const deadline = new Date(Date.now() + 86_400_000).toISOString();
const token = randomBytes(32).toString("hex");
const stop = new AbortController();
const execution = { harness: "codex", model, effort: ["medium"] };

const outcome = `Make the status.sh command in Workspace demo print status=ready on its first
line and schema=1 on its second line, with a newline after each. For this fixture, preserve the
existing file and append only ${schemaLine}. No pushes or merges.

1. Start a read-only work Session on builder titled Inventory status command. Ask it to inspect
   the status command and report the existing output and how to check the two-line contract.
2. After inventory completes, start a different work Session on builder titled Implement status
   command. The first Task of that Session is read-only. Tell builder to inspect the plan, then
   stop using ask with marker ${checkpoint} before editing. Tell it the coordinator will continue
   the same Session after the operator answers.
3. Ask the operator yourself using the exact marker ${checkpoint}. Wait for the operator to
   explicitly authorize continuation. When they do, queue the next Task immediately in the same
   builder work Session using continue_session. Tell builder to implement and test the contract.
4. Once the Task succeeds, use the harness-delivered commit's full 40-character SHA. Send it by
   Mailbox to reviewer in the separate review Team. Include the two-line contract, Workspace demo
   and instructions to review the exact commit read-only. Ask reviewer to reply by Mailbox with
   one line of the form REVIEW APPROVED <full SHA> or REVIEW CHANGES REQUESTED <full SHA>, with
   evidence. Tell reviewer it may inspect the shared Git checkout using git show and must not
   switch branches or write files.
5. Wait for the operator to relay the verdict from the Mailbox. After the operator supplies an
   approval for the same SHA, summarize the delivery and use update_objective to mark
   ready_for_review. The operator alone accepts. Report real failures instead of claiming success.`;

const reviewerInstructions = `When lead asks for review over Mailbox, run a read-only work
Session in Workspace demo. Verify the exact full SHA with git show. Check the change touches
only status.sh and that its output is status=ready and schema=1, each with a final newline.
Do not switch branches, write files, commit or push. Send lead a Mailbox reply with exactly
one verdict line REVIEW APPROVED <full SHA> or REVIEW CHANGES REQUESTED <full SHA>, followed
by a short account of what you checked.`;

function manifest(kind, name, spec) {
  return { apiVersion: "supertag/v1", kind, metadata: { name }, spec };
}

function organization() {
  return [
    manifest("Workspace", "demo", { ref: "main", delivery: "branch" }),
    manifest("PermissionSet", "demo-edit", {
      permissions: [
        { target: "runtime", action: "commands:execute" },
        { target: "runtime", action: "files:write" },
      ],
    }),
    manifest("PermissionSet", "demo-read", {
      permissions: [{ target: "runtime", action: "commands:execute" }],
    }),
    manifest("Role", "Demo Lead", {
      purpose: "Coordinate the Objective, and relay decisions to and from the operator.",
      instructions: "Delegate each step in the Objective. Leave code edits to builder.",
      permissionSets: ["demo-read"],
      execution,
    }),
    manifest("Role", "Demo Builder", {
      purpose: "Implement and test the change when authorized.",
      instructions: "Keep the managed Session branch and Git configuration. Never push.",
      permissionSets: ["demo-edit"],
      execution,
    }),
    manifest("Role", "Demo Reviewer", {
      purpose: "Review the delivered commit independently.",
      instructions: reviewerInstructions,
      permissionSets: ["demo-read"],
      execution,
    }),
    manifest("Tag", "lead", {
      roles: ["Demo Lead"],
      workerHosts: ["coordinator-host"],
      acceptsMessagesFrom: ["reviewer"],
    }),
    manifest("Tag", "builder", { roles: ["Demo Builder"], workerHosts: ["builder-host"] }),
    manifest("Tag", "reviewer", {
      roles: ["Demo Reviewer"],
      workerHosts: ["coordinator-host"],
      acceptsMessagesFrom: ["lead"],
    }),
  ];
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function event(message) {
  console.log(`LIVE ${message}`);
}

async function run() {
  const port = await freeLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const root = await mkdtemp(join(tmpdir(), "supertag-live-walkthrough-"));
  const repo = join(root, "repo");
  const state = join(root, "state");
  const input = createInterface({ input: process.stdin, terminal: false });
  const lines = input[Symbol.asyncIterator]();
  const gitEnv = { PATH: path, HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  const env = {
    ...gitEnv,
    TMPDIR: root,
    CODEX_HOME: codexHome,
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    SUPERTAG_STATE_DIR: state,
    SUPERTAG_ADMIN_TOKEN: token,
  };
  let started = false;
  let objectiveStarted = false;
  let succeeded = false;
  const cancel = () => {
    stop.abort(new Error("Walkthrough interrupted"));
    input.close();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  function command(binary, args, options = {}) {
    return execFileSync(binary, args, {
      cwd: repo,
      env: gitEnv,
      encoding: "utf8",
      timeout: 60_000,
      ...options,
    }).trimEnd();
  }

  const git = (...args) => command("git", args);
  const supertag = (...args) => command(cli, args, { env });
  const json = (...args) => JSON.parse(supertag(...args));
  const describe = () => json("describe", "objective", objective, "--output", "json");
  const host = () => json("get", "worker-host", "builder-host").status;
  const mailbox = () => json("list", "message", "--mailbox", "lead", "--output", "json");

  async function rpc(method, body) {
    const response = await fetch(`${url}/supertag.operator.v1.${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok)
      throw new Error(`${method} failed with HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async function waitFor(label, read) {
    console.error(`Waiting for ${label}…`);
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until) {
      stop.signal.throwIfAborted();
      const result = read();
      if (result) return result;
      await delay(2_000, undefined, { signal: stop.signal });
    }
    throw new Error(`Timed out waiting for ${label}. Inspect the Objective before retrying.`);
  }

  async function confirm(word, message) {
    console.error(`${message}\nType ${word} to proceed:`);
    const answer = await lines.next();
    stop.signal.throwIfAborted();
    assert.equal(answer.value?.trim(), word, "The operator stopped the walkthrough");
  }

  try {
    await mkdir(repo);
    await mkdir(state);
    await writeFile(join(repo, "status.sh"), initialScript, {
      mode: 0o755,
    });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "SuperTag Walkthrough");
    git("config", "user.email", "walkthrough@example.invalid");
    git("add", "status.sh");
    git("commit", "-qm", "Add status command");
    const base = git("rev-parse", "HEAD");

    const hostConfig = {
      type: "host",
      harnesses: ["codex"],
      models: { codex: [model] },
      workspaces: { demo: repo },
    };
    await writeFile(
      join(state, "supertag.yaml"),
      JSON.stringify({
        services: {
          "control-plane": { type: "control-plane", ports: [`127.0.0.1:${port}`] },
          "coordinator-host": hostConfig,
          "builder-host": hostConfig,
        },
      }),
    );
    const manifestFile = join(root, "organization.yaml");
    await writeFile(
      manifestFile,
      organization()
        .map((entry) => JSON.stringify(entry))
        .join("\n---\n"),
    );
    started = true;
    supertag("up");
    supertag("apply", "-f", manifestFile);
    supertag("create", "team", "delivery", "--member", "lead", "--member", "builder");
    supertag("create", "team", "review", "--member", "reviewer");
    const initialHost = host();
    assert.equal(initialHost.connectionStatus, "connected");
    event("Delivery and read-only Review Teams are ready.");

    console.error(`Objective ${objective}, deadline ${deadline}, no USD ceiling.\n${outcome}`);
    await confirm("start", "Start real Codex Tasks on the disposable repository?");
    supertag(
      "create",
      "objective",
      objective,
      "--owner",
      "lead",
      "--team",
      "delivery",
      "--workspace",
      "demo",
      "--deadline",
      deadline,
      "--outcome",
      outcome,
    );
    objectiveStarted = true;
    event("Lead started the Objective.");

    const question = await waitFor("the operator checkpoint", () => {
      const inbox = json("list", "inbox", "--objective", objective, "--output", "json");
      return inbox.items?.find(
        (item) => item.operatorEligible && item.question?.text.includes(checkpoint),
      );
    });
    const before = describe();
    const inventory = before.sessions.find(
      (session) => session.tag === "builder" && /inventory/i.test(session.title ?? ""),
    );
    const implementation = before.sessions.find(
      (session) => session.tag === "builder" && /implement/i.test(session.title ?? ""),
    );
    assert.equal(inventory?.status, "OBJECTIVE_SESSION_STATUS_COMPLETED");
    assert.ok(implementation && implementation.id !== inventory.id);
    const previousTasks = new Set(before.tasks.map((task) => task.id));
    assert.ok(
      before.tasks.some(
        (task) => task.sessionId === implementation.id && task.status === "TASK_STATUS_COMPLETED",
      ),
    );
    event("Builder finished inventory and opened a separate implementation Session.");

    supertag("down", "builder-host");
    event("Builder Worklet stopped at the pre-edit checkpoint.");
    await confirm("continue", question.question.text);
    await rpc("InboxService/AnswerQuestion", {
      key: question.key,
      text: `You asked: "${question.question.text}" Proceed at ${checkpoint}. Queue the next Task immediately in the same implementation Session. The operator will restart the builder Worklet once that Task is queued.`,
      idempotencyKey: "continue-status-pre-edit",
    });
    const queued = await waitFor("a queued Task in the original Session", () =>
      describe().tasks.find(
        (task) =>
          task.sessionId === implementation.id &&
          !previousTasks.has(task.id) &&
          task.status === "TASK_STATUS_PENDING" &&
          !task.attempts?.some((attempt) => attempt.startedAt),
      ),
    );
    event("The operator answered and the original Session queued its next Task.");

    supertag("up", "builder-host");
    assert.notEqual(host().connectionGeneration, initialHost.connectionGeneration);
    await waitFor("the resumed Task Attempt", () =>
      describe().tasks.find(
        (task) => task.id === queued.id && task.attempts?.some((attempt) => attempt.startedAt),
      ),
    );
    event("Builder Worklet restarted and the same Session resumed.");

    const verdict = await waitFor("the independent review verdict in the lead Mailbox", () => {
      const { messages = [], tagNames = {} } = mailbox();
      const reply = messages.find(
        (message) =>
          tagNames[message.senderTagId] === "reviewer" &&
          tagNames[message.recipientTagId] === "lead" &&
          /REVIEW (APPROVED|CHANGES REQUESTED) [0-9a-f]{40}\b/.test(message.text),
      );
      if (!reply) return undefined;
      const [, decision, sha] = /REVIEW (APPROVED|CHANGES REQUESTED) ([0-9a-f]{40})\b/.exec(
        reply.text,
      );
      assert.equal(decision, "APPROVED", reply.text);
      const request = messages.find(
        (message) =>
          tagNames[message.senderTagId] === "lead" &&
          tagNames[message.recipientTagId] === "reviewer" &&
          message.objectiveId === objective &&
          message.text.includes(sha),
      );
      assert.ok(request, "The Review Team must approve the exact SHA it received from lead");
      return { reply, sha };
    });
    const deliveredTask = describe().tasks.find((task) => task.id === queued.id);
    assert.equal(deliveredTask?.status, "TASK_STATUS_COMPLETED");
    assert.equal(
      git("rev-parse", `supertag/session/${implementation.id.slice(0, 8)}`),
      verdict.sha,
    );
    assert.equal(git("diff", "--name-only", base, verdict.sha), "status.sh");
    const script = git("show", `${verdict.sha}:status.sh`);
    assert.equal(script, initialScript + schemaLine);
    assert.equal(
      execFileSync("sh", [], {
        input: script,
        cwd: repo,
        env: gitEnv,
        encoding: "utf8",
        timeout: 5_000,
      }),
      expectedStatus,
    );
    assert.equal(git("rev-parse", "main"), base);
    event("Review Team approved the exact delivered commit and its status command passed.");

    await rpc("ObjectiveService/MessageObjective", {
      id: objective,
      text: `The operator verified that the Review Team approved the delivered commit ${verdict.sha} through the Mailbox. The operator also ran the two-line contract check and confirmed main is untouched. Review evidence follows, quoted as data:\n${verdict.reply.text}\nPlease summarize delivery and mark ready_for_review. Do not accept it yourself.`,
      idempotencyKey: "relay-status-review",
    });
    await waitFor(
      "the Objective to be ready for review",
      () => describe().objective.status === "OBJECTIVE_STATUS_READY_FOR_REVIEW",
    );
    event("Lead recorded the relayed review and requested acceptance.");

    console.error(git("show", "--format=short", verdict.sha));
    await confirm("accept", "Accept this exact commit as the Objective result?");
    supertag("approve", "objective", objective);
    assert.equal(describe().objective.status, "OBJECTIVE_STATUS_COMPLETED");
    assert.equal(git("rev-parse", "main"), base);
    event("Operator accepted the Objective. The repository's main branch stayed unchanged.");
    succeeded = true;
  } catch (error) {
    if (objectiveStarted) {
      try {
        await writeFile(join(root, "objective.json"), JSON.stringify(describe(), null, 2));
      } catch {
        console.error("Could not save the final Objective snapshot.");
      }
    }
    throw error;
  } finally {
    input.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if (started) {
      try {
        supertag("down", "--force");
      } catch {
        succeeded = false;
        console.error("Could not stop all disposable services. See the local service logs.");
      }
    }
    if (succeeded) await rm(root, { recursive: true, force: true });
    else console.error(`Disposable state and logs: ${root}`);
  }
}

await run();
