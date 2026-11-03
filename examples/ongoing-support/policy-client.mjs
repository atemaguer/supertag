export async function policyRequest(url, token, path, input) {
  const response = await fetch(`${url}${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
}

export function validateReceipt(operation, proposal) {
  if (!operation || Object.entries(proposal).some(([key, value]) => operation[key] !== value))
    throw new Error("Provider receipt does not match the reviewed proposal");
  return operation;
}

// Always inspect before sending, including on a fresh Attempt after a process crash.
export async function applyReviewedPolicy(url, token, proposal) {
  const inspect = () =>
    policyRequest(url, token, `/operation?operationId=${encodeURIComponent(proposal.operationId)}`);
  const { operation } = await inspect();
  if (operation) return { receipt: validateReceipt(operation, proposal), recovered: true };
  try {
    return {
      receipt: validateReceipt(await policyRequest(url, token, "/apply", proposal), proposal),
      recovered: false,
    };
  } catch (error) {
    const status = await inspect(); // An unavailable lookup stays uncertain; never infer absence from failure.
    if (!status.operation) throw error;
    return { receipt: validateReceipt(status.operation, proposal), recovered: true };
  }
}
