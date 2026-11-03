import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Python is an independent protocol consumer, not a published SuperTag SDK.
const temporary = await mkdtemp(join(tmpdir(), "supertag-python-proto-"));
const root = resolve(import.meta.dirname, "..");
const python = join(temporary, "venv/bin/python");
const generated = join(temporary, "generated");
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
try {
  run("python3", ["-m", "venv", join(temporary, "venv")]);
  run(python, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "-r",
    "tests/fixtures/python-execution/requirements.txt",
  ]);
  await mkdir(generated);
  run(python, [
    "-m",
    "grpc_tools.protoc",
    "-Ispec/proto",
    `--python_out=${generated}`,
    `--grpc_python_out=${generated}`,
    "spec/proto/supertag/environment/v1/environment.proto",
    "spec/proto/supertag/session/v1/session.proto",
    "spec/proto/supertag/worklet/v1/worklet.proto",
  ]);
  run(python, ["tests/fixtures/python-execution/worklet_heartbeat_conformance.py"], {
    env: { ...process.env, PYTHONPATH: generated },
  });
  run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "tests/python-execution-conformance.test.ts",
      "tests/python-session-conformance.test.ts",
    ],
    {
      env: {
        ...process.env,
        SUPERTAG_CONFORMANCE_PYTHON: python,
        SUPERTAG_CONFORMANCE_BINDINGS: generated,
      },
    },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
