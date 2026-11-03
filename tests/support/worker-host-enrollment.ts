export async function enrollWorkerHost(
  controlPlaneUrl: string,
  adminToken: string,
  workerHostId: string,
): Promise<string> {
  const response = await fetch(`${controlPlaneUrl}/api/v1/worker-hosts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      apiVersion: "supertag/v1",
      kind: "WorkerHostEnrollment",
      metadata: { id: workerHostId },
      spec: {},
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`Worker Host enrollment failed with HTTP ${response.status}`);
  if (
    typeof body !== "object" ||
    body === null ||
    !("kind" in body) ||
    body.kind !== "WorkerHostCredential" ||
    !("credential" in body) ||
    typeof body.credential !== "object" ||
    body.credential === null ||
    !("token" in body.credential) ||
    typeof body.credential.token !== "string" ||
    body.credential.token.length === 0
  )
    throw new Error("Control Plane returned an invalid Worker Host credential");
  return body.credential.token;
}
