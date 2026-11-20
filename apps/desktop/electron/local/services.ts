/**
 * What the app runs with its own CLI against the local services besides starting and restarting
 * them (which `@supertag/client/node` shares with the terminal UI): adding a folder as a
 * Workspace, and the Tags' harness memory the local Worker Hosts keep.
 */
import type { HarnessMemory, HarnessMemoryList } from "@supertag/client/model";
import {
  deleteHarnessMemoryArgs,
  failureReason,
  jsonResult,
  listHarnessMemoryArgs,
  parseHarnessMemory,
  parseHarnessMemoryList,
  runSupertag,
} from "@supertag/client/node";

/** How long `supertag workspace add` may take: it restarts the changed services, as `up` does. */
const ADD_WORKSPACE_LIMIT_MS = 420_000;

/** A folder `supertag workspace add` made a Workspace of the local host, as its `--json` says. */
export interface AddedWorkspace {
  workspace: string;
  workspaceRef?: string;
  workspaceCommit?: string;
}

/** Adds the git repository at `folder` as a Workspace of the local services in `state`. */
export async function addWorkspace(
  cli: string,
  searchPath: string | undefined,
  state: string,
  folder: string,
): Promise<AddedWorkspace> {
  const ran = await runSupertag(
    cli,
    ["workspace", "add", "--json", "--state-directory", state, folder],
    {
      path: searchPath,
      timeoutMs: ADD_WORKSPACE_LIMIT_MS,
    },
  );
  const value = jsonResult(ran);
  const workspace = value?.["workspace"];
  if (typeof workspace !== "string") {
    throw "This version of the supertag CLI can't add a folder for the app. Update it, then try again.";
  }
  const added: AddedWorkspace = { workspace };
  if (typeof value?.["ref"] === "string") added.workspaceRef = value["ref"];
  if (typeof value?.["baseCommit"] === "string") added.workspaceCommit = value["baseCommit"];
  return added;
}

/** How long reading or deleting a Tag's memory may take. */
const HARNESS_MEMORY_LIMIT_MS = 30_000;

/** The Tag's memory the Worker Hosts of the local services in `state` keep. */
export async function harnessMemory(
  cli: string,
  searchPath: string | undefined,
  state: string,
  tagId: string,
): Promise<HarnessMemoryList> {
  const ran = await runSupertag(cli, listHarnessMemoryArgs(state, tagId), {
    path: searchPath,
    timeoutMs: HARNESS_MEMORY_LIMIT_MS,
  });
  if (!ran.success) throw failureReason(ran);
  return parseHarnessMemoryList(ran.stdout);
}

/** Deletes one memory a Worker Host of the local services in `state` keeps. */
export async function deleteHarnessMemory(
  cli: string,
  searchPath: string | undefined,
  state: string,
  memoryId: string,
): Promise<HarnessMemory> {
  const ran = await runSupertag(cli, deleteHarnessMemoryArgs(state, memoryId), {
    path: searchPath,
    timeoutMs: HARNESS_MEMORY_LIMIT_MS,
  });
  if (!ran.success) throw failureReason(ran);
  return parseHarnessMemory(ran.stdout);
}
