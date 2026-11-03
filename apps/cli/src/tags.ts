import type { Store } from "@supertag/core";
import { DrizzleStore, FileGatewayCredentialVault } from "@supertag/store";
import {
  executeTagOperation,
  type TagCommand,
  type TagOperationDependencies,
} from "./tag-command-adapter.js";

export { isTagCommand, type TagCommand, tagResourceHelp } from "./tag-command-adapter.js";

export interface TagCommandDependencies extends TagOperationDependencies {
  readonly store: TagOperationDependencies["store"] & Pick<Store, "connect" | "disconnect">;
}

export interface TagCommandRunOptions {
  readonly manageConnection?: boolean;
  readonly write?: (text: string) => void;
}

/** CLI connection lifetime and output; application operations do not own either. */
export async function runTagCommand(
  command: TagCommand,
  args: readonly string[],
  dependencies: TagCommandDependencies = {
    store: new DrizzleStore(),
    credentialVault: new FileGatewayCredentialVault(),
  },
  options: TagCommandRunOptions = {},
): Promise<void> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const help = args.includes("--help") || args.includes("-h");
  const manageConnection = !help && (options.manageConnection ?? true);
  if (manageConnection) await dependencies.store.connect();
  try {
    await executeTagOperation(command, args, dependencies, write);
  } finally {
    if (manageConnection) await dependencies.store.disconnect();
  }
}
