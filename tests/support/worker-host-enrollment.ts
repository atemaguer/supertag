import { hostClient } from "../../apps/cli/src/operator-client.ts";

/** Enrolls a Worker Host through `HostService.EnrollWorkerHost` and returns its token. */
export async function enrollWorkerHost(
  controlPlaneUrl: string,
  adminToken: string,
  workerHostId: string,
): Promise<string> {
  const credential = await hostClient({ url: controlPlaneUrl, token: adminToken }).enrollWorkerHost(
    { id: workerHostId },
  );
  if (credential.workerHostId !== workerHostId || credential.token.length === 0)
    throw new Error("Control Plane returned an invalid Worker Host credential");
  return credential.token;
}
