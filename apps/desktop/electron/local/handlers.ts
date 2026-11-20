/**
 * The channels backed by the app's own CLI: starting and restarting the local services, the
 * first-launch setup, adding a folder as a Workspace of the local Gateway, and the Tags' harness
 * memory its Worker Hosts keep, which never passes through the Control Plane.
 */

import {
  checkSetup,
  type LocalDiscovery,
  localUpgrade,
  type Peer,
  readLocalGateway,
  restartLocal,
  SHARED_GATEWAY_HARNESS_MEMORY,
  setUpLocal,
  shouldStart,
  startLocal,
} from "@supertag/client/node";
import type { SetupCheck } from "../../src/gateway";
import type { Handlers } from "../ipc";
import { type AppIdentity, environment, installCommand, usableCli } from "./cli";
import { addWorkspace, deleteHarnessMemory, harnessMemory } from "./services";

export interface LocalDependencies {
  app: AppIdentity;
  /** The protocol versions this app speaks. */
  protocolVersions: readonly number[];
  /** Negotiates with a Gateway: the peer of a protocol mismatch, or nothing. */
  probe(url: string, token: string): Promise<Peer | undefined>;
  /** The folder picker for a Workspace; null when cancelled. */
  chooseWorkspaceFolder(): Promise<string | null>;
  /**
   * The local state directory of a connection to the local Gateway; rejects with a user-facing
   * string for any other connection. The Gateway backend's `GatewayState.localStateOf`.
   */
  localStateOf(connectionId: string): Promise<string>;
}

type LocalChannels =
  | "localStartNeeded"
  | "startLocalServices"
  | "localCliProblem"
  | "localGatewayUpgrade"
  | "restartLocalServices"
  | "checkSetup"
  | "setUpSupertag"
  | "addLocalWorkspace"
  | "listHarnessMemory"
  | "deleteHarnessMemory";

const NOT_OLDER =
  "The local SuperTag does not run an older release, so it was not restarted. Connect to it again.";

export function localHandlers(deps: LocalDependencies): Pick<Handlers, LocalChannels> {
  const { app } = deps;
  /** The local Gateway as any CLI found says, or nothing when none can say. */
  const discover = async (): Promise<LocalDiscovery | undefined> => {
    const { cli } = await environment(app);
    if (cli === undefined) return undefined;
    return readLocalGateway(cli, app.env).catch(() => undefined);
  };
  const upgrade = (local: LocalDiscovery | undefined) =>
    localUpgrade(local, deps.probe, deps.protocolVersions, app.version);

  return {
    // SuperTag is set up here but its services are stopped. With no CLI, never: first launch
    // belongs to onboarding.
    localStartNeeded: async () => shouldStart(await discover()),

    async startLocalServices() {
      const local = await discover();
      if (!shouldStart(local) || local === undefined) return false;
      const { cli, path } = await usableCli(app);
      await startLocal(cli, local.stateDirectory, { path });
      return true;
    },

    localCliProblem: () =>
      usableCli(app).then(
        () => null,
        (problem: unknown) => (typeof problem === "string" ? problem : "Could not run supertag."),
      ),

    localGatewayUpgrade: async () => upgrade(await discover()),

    async restartLocalServices(_args, progress) {
      const { cli, path } = await usableCli(app);
      const local = await readLocalGateway(cli, app.env);
      // Only an older local release is restarted, or set-up services a failed restart left
      // stopped; a remote Gateway, or a local one of this or a newer release, is never touched.
      const restartable = local.running ? (await upgrade(local)) !== null : shouldStart(local);
      if (!restartable) throw NOT_OLDER;
      await restartLocal(cli, local.stateDirectory, { path }, (step) => progress.send(step));
    },

    async checkSetup({ directory, harness }) {
      const install = installCommand(app.version);
      let found: Awaited<ReturnType<typeof usableCli>>;
      try {
        found = await usableCli(app);
      } catch (problem) {
        // No CLI, or one of another version than the app: say what to do instead of running it.
        return { cli: null, problem: String(problem), install } satisfies SetupCheck;
      }
      // The CLI's own JSON, passed on as is.
      return (await checkSetup(
        found.cli,
        { path: found.path },
        install,
        directory,
        harness,
      )) as SetupCheck;
    },

    async setUpSupertag({ directory, harness }) {
      const { cli, path } = await usableCli(app);
      return setUpLocal(cli, { path }, directory, harness);
    },

    async addLocalWorkspace({ connectionId }) {
      const state = await deps.localStateOf(connectionId);
      const folder = await deps.chooseWorkspaceFolder();
      if (folder === null) return null;
      const { cli, path } = await usableCli(app);
      return addWorkspace(cli, path, state, folder);
    },

    // Only the local Gateway's Worker Hosts are on this machine to read a Tag's memory from.
    async listHarnessMemory({ connectionId, tagId }) {
      const state = await deps.localStateOf(connectionId).catch(() => undefined);
      if (state === undefined) {
        return { memories: [], keptOn: [], unavailable: SHARED_GATEWAY_HARNESS_MEMORY };
      }
      const { cli, path } = await usableCli(app);
      return harnessMemory(cli, path, state, tagId);
    },

    async deleteHarnessMemory({ connectionId, memoryId }) {
      const state = await deps.localStateOf(connectionId);
      const { cli, path } = await usableCli(app);
      return deleteHarnessMemory(cli, path, state, memoryId);
    },
  };
}
