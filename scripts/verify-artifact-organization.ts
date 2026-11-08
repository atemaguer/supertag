/** Recheck preserved Docker organization evidence without spending model usage. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyArtifactOrganizationEvidence } from "./artifact-organization-evidence.js";

const directory = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Provide the existing Docker integration evidence directory");
type Row = Record<string, unknown>;
const evidence = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8"));
const configuration = JSON.parse(
  await readFile(join(directory, "run.json"), "utf8").catch(() => "{}"),
);
const owner = evidence.objectives[0].ownerTagId as string;
const reviewer = (evidence.tasks as Row[]).find((row) => row["tagId"] !== owner)?.["tagId"] as
  | string
  | undefined;
assert(reviewer, "Missing an independent reviewer Task");
const nativeSessions: Row[] = [];
for (const name of await readdir(directory)) {
  if (!/-worker-[ab]\.log$/.test(name)) continue;
  for (const line of (await readFile(join(directory, name), "utf8")).split("\n")) {
    try {
      const value = JSON.parse(line);
      if (value.type === "native-session") nativeSessions.push(value);
    } catch {
      // Readiness and transport diagnostics are not native-session observations.
    }
  }
}
const contents: Array<{ artifactId: unknown; tagId: unknown; path: unknown; text: string }> = [];
for (const artifact of evidence.artifacts as Row[]) {
  const entries =
    typeof artifact["entries"] === "string"
      ? (JSON.parse(artifact["entries"]) as Row[])
      : (artifact["entries"] as Row[]);
  for (const entry of entries) {
    const digest = String(entry["digest"]).replace(/^sha256:/, "");
    assert(/^[a-f0-9]{64}$/.test(digest));
    const bytes = await hostCopy(directory, digest);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    if (bytes.length <= 64_000 && /\.(md|txt|json)$/.test(String(entry["path"]))) {
      contents.push({
        artifactId: artifact["id"],
        tagId: artifact["tagId"],
        path: entry["path"],
        text: bytes.toString("utf8"),
      });
    }
  }
}
const verification = verifyArtifactOrganizationEvidence({
  state: evidence,
  contents,
  nativeSessions,
  owner,
  reviewer,
  expectedMinutes: evidence.expectedMinutes,
});
const cleanup = JSON.parse(await readFile(join(directory, "cleanup.json"), "utf8"));
assert(
  [...cleanup.containers, ...cleanup.infrastructure].every((status) => status === "fulfilled"),
);
for (const host of ["worker-a", "worker-b"]) {
  for (const path of ["home", "state"]) {
    await assert.rejects(access(join(directory, host, path)), { code: "ENOENT" });
  }
}
const report = {
  passed: true,
  objectiveId: evidence.objectiveId,
  model: "gpt-5.6-luna",
  verification,
  cleanupVerified: true,
  seccomp: configuration.seccomp ?? "not recorded",
  verificationMode: "Preserved evidence from real Docker execution; no model replay",
  boundary: "API invocation, not Slack; does not establish default Docker sandbox compatibility",
};
await writeFile(join(directory, "verified-report.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
await writeFile(join(directory, "artifact-text.json"), JSON.stringify(contents, null, 2), {
  mode: 0o600,
});
await writeFile(join(directory, "native-sessions.json"), JSON.stringify(nativeSessions, null, 2), {
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

/** An artifact's bytes from the Worker Host that holds them; the Control Plane keeps none. */
async function hostCopy(directory: string, digest: string): Promise<Buffer> {
  for (const host of await readdir(directory, { withFileTypes: true })) {
    if (!host.isDirectory()) continue;
    const bytes = await readFile(
      join(directory, host.name, "state/artifacts/sha256", digest),
    ).catch(() => undefined);
    if (bytes) return bytes;
  }
  throw new Error(`No Worker Host in ${directory} holds sha256:${digest}`);
}
