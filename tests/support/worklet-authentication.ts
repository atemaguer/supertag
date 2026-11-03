import { createHash, timingSafeEqual } from "node:crypto";
import type {
  WorkletAuthenticationRequest,
  WorkletAuthenticationResult,
} from "../../packages/runtime/transport/src/index.js";

/**
 * Test-only Worklet authentication: one shared secret admits any Worker Host, and each host's
 * connection generation increases on every successful claim.
 */
export function sharedTokenAuthentication(
  token: string,
): (request: WorkletAuthenticationRequest) => WorkletAuthenticationResult | undefined {
  const generations = new Map<string, number>();
  const expected = createHash("sha256").update(token).digest();
  return ({ credential, worklet }) => {
    if (!timingSafeEqual(createHash("sha256").update(credential).digest(), expected))
      return undefined;
    const connectionGeneration = (generations.get(worklet.host.id) ?? 0) + 1;
    generations.set(worklet.host.id, connectionGeneration);
    return { connectionGeneration };
  };
}
