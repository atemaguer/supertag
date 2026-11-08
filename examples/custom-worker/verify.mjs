import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertConformance,
  runEnvironmentConformance,
  runHarnessConformance,
  runWorkerConformance,
} from "supertag-ai/testing";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  InMemorySessionStateStore,
  LocalWorklet,
} from "supertag-ai/worker";

import { ExampleEnvironmentProvider } from "./environment.mjs";
import { ExampleHarness } from "./harness.mjs";
import { ExampleWorker, exampleAttempt, profile } from "./worker.mjs";

const attempt = exampleAttempt();
const harness = new ExampleHarness();
const provider = new ExampleEnvironmentProvider();
const plan = await harness.plan(executionContext(attempt));
const environmentSpec = { task: attempt, profile, plan: plan.execution };

assertConformance(await runWorkerConformance({ worker: new ExampleWorker(), attempt }));
assertConformance(
  await runEnvironmentConformance({
    provider,
    spec: environmentSpec,
    expectedPlacement: "local",
  }),
);

const environment = await provider.provision(environmentSpec);
await environment.prepare(plan.execution);
try {
  assertConformance(
    await runHarnessConformance({
      harness,
      context: executionContext(attempt),
      executionEnvironment: environment,
      expectedInputKinds: [],
      verifyCancellation: true,
    }),
  );
} finally {
  await environment.dispose("completed");
}

process.stdout.write("External Worker, Harness, and Environment conformance passed\n");

function executionContext(task) {
  return {
    attempt: task,
    profile,
    context: { instructions: [], skills: [], history: [], resources: [] },
    tools: [],
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore: new InMemorySessionStateStore(),
  };
}

const journalDirectory = await mkdtemp(join(tmpdir(), "supertag-external-journal-"));
const durable = new DurableLocalWorklet(
  new LocalWorklet("example", "example-host", [new ExampleWorker()]),
  new FileAttemptJournal(journalDirectory),
);
try {
  const receipt = await durable.accept(attempt);
  assert.equal(receipt.attemptId, attempt.attemptId);
  const events = [];
  for await (const event of durable.events(attempt.attemptId)) events.push(event);
  assert.equal(events.at(-1)?.event.type, "execution.completed");
  assert.equal((await durable.inspect(attempt.attemptId))?.status, "completed");
  assert.equal((await durable.accept(attempt)).specDigest, receipt.specDigest);
  const replay = [];
  for await (const event of durable.events(attempt.attemptId, events[0].sequence))
    replay.push(event);
  assert.deepEqual(replay, events.slice(1));
  process.stdout.write("External durable Worklet acceptance and replay passed\n");
} finally {
  await durable.shutdown("Example finished");
  await rm(journalDirectory, { recursive: true, force: true });
}
