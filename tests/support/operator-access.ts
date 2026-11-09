import { accessClient } from "../../apps/cli/src/operator-client.ts";

/** Creates an Operator Token with the admin token and returns its secret. */
export async function issueOperatorToken(
  controlPlaneUrl: string,
  adminToken: string,
  name: string,
): Promise<string> {
  return (
    await accessClient({ url: controlPlaneUrl, token: adminToken }).createOperatorToken({ name })
  ).secret;
}
