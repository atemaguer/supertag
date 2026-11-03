/**
 * Unsandboxed harnesses. Codex runs the commands a Task asks for inside its own OS sandbox.
 * Claude Code and OpenCode in the local process environment run them as the host user, with no
 * sandbox. A host operator opts in before such a harness runs Tasks granted `commands:execute`.
 *
 * Worker profiles report this through two capabilities. Placement reads them from the host's
 * descriptor; they are self-reported, like labels, and decide placement, never access.
 */

/** The runtime action whose Tasks need a sandboxed harness or the host's opt-in. */
export const COMMANDS_EXECUTE_ACTION = "commands:execute";

/**
 * The profile may run Tasks granted `commands:execute`: its harness runs commands in a sandbox,
 * or the host operator allowed it to run them without one.
 */
export const COMMANDS_EXECUTE_CAPABILITY_ID = "supertag.commands.execute";

/** The profile's harness runs commands as the host user, without an OS sandbox. */
export const UNSANDBOXED_COMMANDS_CAPABILITY_ID = "supertag.commands.unsandboxed";

/** The host service setting in supertag.yaml that opts unsandboxed harnesses in. */
export const ALLOW_UNSANDBOXED_COMMANDS_SETTING = "allow-unsandboxed-commands";

/** A Worker Host whose matching harnesses run commands unsandboxed without the host's opt-in. */
export interface UnsandboxedCommandHold {
  readonly workerHostId: string;
  readonly harnesses: readonly string[];
}

/** How one host's Worker profiles may run `commands:execute` Tasks, from its descriptor. */
export interface HostCommandSupport {
  /** Whether any profile reports either capability. A host that reports neither is not checked. */
  readonly reported: boolean;
  /** Whether a matching profile may run commands. */
  readonly permitted: boolean;
  /** Harnesses of matching profiles that run commands unsandboxed and were not allowed to. */
  readonly refused: readonly string[];
}

/**
 * Reads a host descriptor's Worker profiles. `harness` limits the answer to profiles of that
 * harness, for a Task that names one.
 */
export function hostCommandSupport(
  descriptor: Readonly<Record<string, unknown>>,
  harness?: string,
): HostCommandSupport {
  let reported = false;
  let permitted = false;
  const refused = new Set<string>();
  const workers = Array.isArray(descriptor["workers"]) ? descriptor["workers"] : [];
  for (const worker of workers) {
    if (!isRecord(worker)) continue;
    const entries = Array.isArray(worker["profileCapabilities"])
      ? worker["profileCapabilities"].filter(isRecord)
      : [{ capabilities: worker["capabilities"] }];
    for (const entry of entries) {
      const allowed = hasCapability(entry["capabilities"], COMMANDS_EXECUTE_CAPABILITY_ID);
      const unsandboxed = hasCapability(entry["capabilities"], UNSANDBOXED_COMMANDS_CAPABILITY_ID);
      if (allowed || unsandboxed) reported = true;
      const name = typeof entry["harness"] === "string" ? entry["harness"] : undefined;
      if (harness !== undefined && name !== harness) continue;
      if (allowed) permitted = true;
      else if (unsandboxed) refused.add(name ?? "its harness");
    }
  }
  return { reported, permitted, refused: [...refused].sort() };
}

/**
 * Why a host does not run a Task's commands, and the setting that changes it. For example:
 * "Worker Host laptop runs claude-code without a sandbox; add claude-code to
 * allow-unsandboxed-commands in its supertag.yaml service to let it run commands."
 */
export function unsandboxedCommandsReason(hold: UnsandboxedCommandHold): string {
  const names = hold.harnesses.length > 0 ? hold.harnesses : ["its harness"];
  const listed =
    names.length === 1
      ? (names[0] as string)
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1) as string}`;
  const one = names.length === 1;
  return `Worker Host ${hold.workerHostId} runs ${listed} without a sandbox; add ${one ? listed : "them"} to ${ALLOW_UNSANDBOXED_COMMANDS_SETTING} in its supertag.yaml service to let ${one ? "it" : "them"} run commands.`;
}

/** The holds a scheduling diagnosis records, read defensively from its stored payload. */
export function unsandboxedCommandHoldsOf(
  payload: Readonly<Record<string, unknown>> | undefined,
): UnsandboxedCommandHold[] {
  const value = payload?.["unsandboxedCommands"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((hold) =>
    isRecord(hold) &&
    typeof hold["workerHostId"] === "string" &&
    Array.isArray(hold["harnesses"]) &&
    hold["harnesses"].every((harness) => typeof harness === "string")
      ? [{ workerHostId: hold["workerHostId"], harnesses: hold["harnesses"] as string[] }]
      : [],
  );
}

function hasCapability(capabilities: unknown, id: string): boolean {
  return (
    Array.isArray(capabilities) &&
    capabilities.some(
      (capability) =>
        isRecord(capability) && capability["id"] === id && capability["version"] === 1,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
