/**
 * The window's Gateway calls, through the desktop app's main process: one connection as a
 * `Gateway`, the saved Gateways, and setting SuperTag up on this machine.
 */
import type { Gateway, RestartStep, WatchUpdate } from "@supertag/client/model";
import { desktop } from "./desktop";

export function gatewaySession(connectionId: string, scope: string, principal?: string): Gateway {
  const api = desktop();
  return {
    scope,
    tags: () => api.listTags({ connectionId }),
    conversations: () => api.listConversations({ connectionId }),
    messages: (read) => api.listMessages({ connectionId, read }),
    send: (tagId, text, operationId) => api.sendMessage({ connectionId, tagId, text, operationId }),
    markRead: (tagId, order) => api.markConversationRead({ connectionId, tagId, order }),
    events: (taskId, afterSequence) => api.listTaskEvents({ connectionId, taskId, afterSequence }),
    async follow(read, receive) {
      const followId = await api.startConversationFollow({ connectionId, read }, receive);
      return () => api.stopConversationFollow({ followId });
    },
    harnessMemory: (tagId) => api.listHarnessMemory({ connectionId, tagId }),
    deleteHarnessMemory: (memoryId) => api.deleteHarnessMemory({ connectionId, memoryId }),
    ...(principal?.startsWith("operator:")
      ? { networkLogs: (tagId: string) => api.listNetworkLogs({ connectionId, tagId }) }
      : {}),
    locateTaskFiles: (taskId) => api.locateTaskFiles({ connectionId, taskId }),
    listTaskFiles: (taskId, path) => api.listTaskFiles({ connectionId, taskId, path }),
    readTaskFile: (taskId, path) => api.readTaskFile({ connectionId, taskId, path }),
    revealTaskFile: (taskId, path) => api.revealTaskFile({ connectionId, taskId, path }),
    tagActivity: (tagId) => api.tagActivity({ connectionId, tagId }),
    schedules: (tagId) => api.listSchedules({ connectionId, tagId }),
    changeSchedule: (scheduleId, action) =>
      api.changeSchedule({ connectionId, scheduleId, action }),
    inbox: () => api.listInbox({ connectionId }),
    approval: (approvalId) => api.getApproval({ connectionId, approvalId }),
    decideApproval: (approvalId, approve, reason) =>
      api.decideApproval({ connectionId, approvalId, approve, reason }),
    resolveAttempt: (taskId, attemptId, decision) =>
      api.resolveAttempt({ connectionId, taskId, attemptId, decision }),
    readCache: (key) => api.readCache({ connectionId, key }),
    writeCache: (key, value) => api.writeCache({ connectionId, key, value }),
  };
}

/** One harness as `supertag init --check --json` reports it. */
export interface SetupHarness {
  harness: string;
  installed: boolean;
  /** Unknown when the harness isn't installed, or its check couldn't run. */
  signed_in: boolean | null;
  node: { ok: boolean; fix: string | null } | null;
  /** One line saying what to do, when it isn't ready. */
  fix: string | null;
  /** The command in `fix`, to copy. */
  fix_command?: string | null;
  install_url?: string | null;
}

/** What `supertag init --check --json` says about setting SuperTag up here. */
export interface SetupCheck {
  /** The CLI the app runs, or null when there is none; then `install` says how to get it. */
  cli?: string | null;
  /** The CLI found is too old to set SuperTag up from the app; `install` updates it. */
  outdated?: string;
  /** Why the app can't run the CLI it found, or found none, as one message to show. */
  problem?: string;
  install?: string;
  ready?: boolean;
  repository?: {
    directory: string;
    git: boolean;
    root: string | null;
    name: string | null;
    has_commits: boolean;
    branch: string | null;
    fix: string | null;
  };
  harnesses?: SetupHarness[];
  state?: { directory: string; configured: boolean; repository_mapped: boolean };
}

/** Setting SuperTag up on this machine, through the supertag CLI. */
export const nativeSetup = {
  check: (directory?: string, harness?: string) =>
    desktop().checkSetup({
      ...(directory === undefined ? {} : { directory }),
      ...(harness === undefined ? {} : { harness }),
    }),
  chooseFolder: () => desktop().chooseProjectFolder({}),
  setUp: (directory: string, harness: string) => desktop().setUpSupertag({ directory, harness }),
};

export const nativeGateway = {
  list: () => desktop().listGateways({}),
  save: (gateway: string, name: string, token: string) =>
    desktop().saveGateway({ gateway, name, token }),
  select: (origin: string) => desktop().selectGateway({ origin }),
  connectLocal: () => desktop().connectLocalGateway({}),
  /** Whether SuperTag is set up on this machine but its local services are stopped. */
  localStartNeeded: () => desktop().localStartNeeded({}),
  /** Whether this launch is the first after the app updated itself. */
  updatePending: () => desktop().localUpdatePending({}),
  /** Starts the stopped local services with `supertag up`, or after the app updated itself
   * restarts them with its new CLI; false when nothing needed starting. */
  startLocal: () => desktop().startLocalServices({}),
  /** Why the app can't run the `supertag` CLI (missing, or another version), with the command
   * that installs the right one; null when it can. */
  localCliProblem: () => desktop().localCliProblem({}),
  /** The older release the local Gateway runs, which the app can restart with its own version;
   * null when it runs this app's protocol, a newer release, or not at all. */
  localUpgrade: () => desktop().localGatewayUpgrade({}),
  /** Restarts the local services with the app's own CLI: `supertag down`, then `supertag up`
   * against the same state directory, which migrates the database. */
  restartLocal: (progress: (step: RestartStep) => void) =>
    desktop().restartLocalServices({}, progress),
  clear: (forget?: string) => desktop().clearGateway(forget === undefined ? {} : { forget }),
  async watch(connectionId: string, watchEpoch: number, receive: (update: WatchUpdate) => void) {
    const watchId = await desktop().startGatewayWatch({ connectionId, watchEpoch }, receive);
    return () => desktop().stopGatewayWatch({ watchId });
  },
};
