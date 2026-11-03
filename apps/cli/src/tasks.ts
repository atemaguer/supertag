import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseArtifactSelection, validateArtifactPath } from "@supertag/core";
import type { ControlPlaneClient } from "./control-plane-client.js";
import { takeOutputFlag } from "./output-flag.js";

export type TaskCommand = "assign" | "cancel" | "events" | "execution" | "get";

export function isTaskCommand(value: string | undefined): value is TaskCommand {
  return (
    value === "assign" ||
    value === "cancel" ||
    value === "events" ||
    value === "execution" ||
    value === "get"
  );
}

export async function runTaskCommand(
  client: Pick<ControlPlaneClient, "request">,
  command: TaskCommand,
  args: readonly string[],
): Promise<string> {
  if (args.includes("--help")) return taskHelp();
  if (command === "assign" || command === "cancel") {
    const output = takeOutputFlag(args);
    args = output.args;
    if (command === "assign") return assignTask(client, args, output.json);
    const id = args[0]?.trim();
    if (args.length !== 1 || !id) throw new Error("Usage: supertag cancel task ID [--output json]");
    const result = await client.request<{
      readonly status?: { readonly accepted?: boolean; readonly phase?: string };
    }>(`/api/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    if (output.json) return `${JSON.stringify(result, null, 2)}\n`;
    const phase = result?.status?.phase;
    return phase === undefined || phase === "cancelled"
      ? `task/${id} cancelled.\n`
      : result?.status?.accepted
        ? `task/${id} cancellation requested; it is ${phase} until its Worker stops.\n`
        : `task/${id} is already ${phase}; nothing to cancel.\n`;
  }
  const rawId = args[0];
  if (args.length !== 1 || rawId === undefined || rawId.trim() === "") {
    throw new Error(`Usage: supertag ${command} task ID`);
  }
  const id = encodeURIComponent(rawId);
  const suffix = command === "events" ? "/events" : command === "execution" ? "/execution" : "";
  const result = await client.request(`/api/v1/tasks/${id}${suffix}`);
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function taskHelp(): string {
  return `Usage:
  supertag assign task ID --objective ID --team ID --tag ID --instruction-file FILE|- --criterion TEXT [--criterion TEXT] [--item N] [--profile ID --profile-revision REV] [--model MODEL] [--effort low|medium|high] [--max-cost-minor N] [--output-file outputs/FILE] [--input-artifacts FILE]
  supertag get task ID
  supertag describe task ID
  supertag events task ID
  supertag cancel task ID [--output json]

Assignment uses existing Objective, Team, and Tag IDs. The Tag must have a bound Worker Host.
Use - to read instructions from standard input. Repeat --criterion for each acceptance criterion.
Repeat --item for each numbered Objective statement item the Task serves, such as --item 1 --item 3.
Repeat --output-file to capture exact files under outputs/.
--input-artifacts reads a JSON array of {"artifactId":"ID","paths":["outputs/FILE"]}.
Omit the profile to allow scheduling among compatible Workers. Cost uses nonnegative minor units.
--model and --effort must fall within the Tag's allowed execution settings; omit them for its defaults.
assign and cancel print a one-line summary; add --output json for the full record.
`;
}

async function assignTask(
  client: Pick<ControlPlaneClient, "request">,
  args: readonly string[],
  json: boolean,
): Promise<string> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "output-file": { type: "string", multiple: true },
      "input-artifacts": { type: "string" },
      objective: { type: "string" },
      team: { type: "string" },
      tag: { type: "string" },
      "instruction-file": { type: "string" },
      criterion: { type: "string", multiple: true },
      item: { type: "string", multiple: true },
      profile: { type: "string" },
      "profile-revision": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "max-cost-minor": { type: "string" },
    },
  });
  const required = (value: string | undefined, name: string): string => {
    if (!value?.trim()) throw new Error(`${name} is required and must not be blank`);
    return value.trim();
  };
  if (positionals.length !== 1) throw new Error(taskHelp());
  const taskId = required(positionals[0], "Task ID");
  const objectiveId = required(values.objective, "--objective");
  const teamId = required(values.team, "--team");
  const assignedTagId = required(values.tag, "--tag");
  const instructionFile = required(values["instruction-file"], "--instruction-file");
  const acceptanceCriteria = (values.criterion ?? []).map((value) =>
    required(value, "--criterion"),
  );
  if (!acceptanceCriteria.length) throw new Error("At least one --criterion is required");
  const items = (values.item ?? []).map((value) => {
    const item = value.trim();
    if (!/^[1-9]\d{0,2}$/.test(item))
      throw new Error('--item must be a statement item number such as "1" or "3"');
    return item;
  });
  if ((values.profile === undefined) !== (values["profile-revision"] === undefined))
    throw new Error("--profile and --profile-revision must be supplied together");
  const profile =
    values.profile === undefined
      ? undefined
      : {
          id: required(values.profile, "--profile"),
          revision: required(values["profile-revision"], "--profile-revision"),
        };
  const model = values.model === undefined ? undefined : required(values.model, "--model");
  const effort = values.effort;
  if (effort !== undefined && !["low", "medium", "high"].includes(effort))
    throw new Error("--effort must be low, medium, or high");
  const cost = values["max-cost-minor"];
  if (cost !== undefined && (!/^\d+$/.test(cost) || !Number.isSafeInteger(Number(cost))))
    throw new Error("--max-cost-minor must be a nonnegative safe integer");
  const outputFiles = (values["output-file"] ?? []).map((value) => {
    const path = validateArtifactPath(value);
    if (!path.startsWith("outputs/"))
      throw new Error("--output-file must be a file under outputs/");
    if (/[?*[\]{}!]/.test(path))
      throw new Error("--output-file must be an exact file path without glob characters");
    return path;
  });
  if (new Set(outputFiles).size !== outputFiles.length)
    throw new Error("--output-file paths must be unique");
  let inputArtifacts: ReturnType<typeof parseArtifactSelection>[] | undefined;
  if (values["input-artifacts"] !== undefined) {
    const file = required(values["input-artifacts"], "--input-artifacts");
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100)
      throw new Error("--input-artifacts must contain an array of 1–100 artifact selections");
    inputArtifacts = parsed.map((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => key !== "artifactId" && key !== "paths")
      )
        throw new Error("Artifact selections accept only artifactId and paths");
      return parseArtifactSelection(value);
    });
  }
  let instruction: string;
  if (instructionFile === "-") {
    if (process.stdin.isTTY)
      throw new Error("Pipe instructions to standard input when using --instruction-file -");
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    instruction = Buffer.concat(chunks).toString("utf8");
  } else instruction = await readFile(instructionFile, "utf8");
  required(instruction, "Instruction text");
  const result = await client.request("/api/v1/coordination/assign_task", {
    method: "POST",
    body: JSON.stringify({
      taskId,
      objectiveId,
      teamId,
      assignedTagId,
      instruction,
      acceptanceCriteria,
      ...(items.length ? { items } : {}),
      ...(profile || outputFiles.length || model || effort
        ? {
            execution: {
              ...(profile ? { profile } : {}),
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
              ...(outputFiles.length
                ? { outputs: { directory: "outputs", required: outputFiles, include: outputFiles } }
                : {}),
            },
          }
        : {}),
      ...(inputArtifacts === undefined ? {} : { inputArtifacts }),
      ...(cost === undefined ? {} : { maxCostMinor: Number(cost) }),
    }),
  });
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  const status =
    result && typeof result === "object" && "status" in result && typeof result.status === "string"
      ? ` (${result.status})`
      : "";
  return `task/${taskId} assigned to Tag ${assignedTagId}${status}.\n`;
}
