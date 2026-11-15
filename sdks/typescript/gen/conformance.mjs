import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { TaskSchema, TaskState } from "./supertag/runtime/v2/runtime_pb.ts";

const task = fromBinary(TaskSchema, readFileSync(0));
assert.equal(task.tagRevision, 9007199254740994n);
assert.equal(task.result, "");
assert.equal(task.attemptId, "go-attempt");
assert.equal(task.state, TaskState.RUNNING);
task.state = TaskState.SUCCEEDED;
task.result = "✓ verified";
process.stdout.write(toBinary(TaskSchema, task));
