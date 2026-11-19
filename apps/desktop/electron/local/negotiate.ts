/**
 * Asking the local Gateway which release it runs, with `supertag-ai`'s own negotiation, so the
 * app's protocol versions stay single-sourced in the SDK.
 */
import { createGatewayClient, PROTOCOL_VERSIONS, ProtocolMismatchError } from "../gateway/sdk";
import type { Peer } from "./services";

export { PROTOCOL_VERSIONS };

/**
 * Negotiates with the Gateway at `url`: the peer of a protocol mismatch when it named itself, or
 * nothing when it agreed, could not be reached, or refused for another reason.
 */
export async function probe(
  url: string,
  token: string,
  buildVersion: string,
): Promise<Peer | undefined> {
  const client = createGatewayClient({ url, token, buildVersion });
  try {
    await client.negotiate();
    return undefined;
  } catch (error) {
    if (!(error instanceof ProtocolMismatchError)) return undefined;
    return { build: error.peerBuild, versions: error.peerVersions };
  } finally {
    client.close();
  }
}
