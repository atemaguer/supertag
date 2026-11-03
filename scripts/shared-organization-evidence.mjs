/** Join backend MCP observations to recorded execution identity, not ledger labels alone. */
export function observedMcpHarnesses({ verification, attempts, placements }) {
  const clients = verification?.mcp?.nativeClients;
  if (!Array.isArray(clients) || !Array.isArray(attempts) || !Array.isArray(placements))
    return new Set();
  const observed = new Set();
  for (const client of clients) {
    if (
      !client ||
      !["claude-code", "codex"].includes(client.harness) ||
      typeof client.attemptId !== "string" ||
      typeof client.taskId !== "string" ||
      client.readAfterProbe !== true ||
      !Array.isArray(client.transports) ||
      !client.transports.includes("stdio") ||
      !client.transports.includes("http")
    )
      continue;
    const matchingAttempts = attempts.filter((attempt) => attempt?.id === client.attemptId);
    const matchingPlacements = placements.filter(
      (placement) => placement?.attemptId === client.attemptId,
    );
    if (matchingAttempts.length !== 1 || matchingPlacements.length !== 1) continue;
    const attempt = matchingAttempts[0];
    const placement = matchingPlacements[0];
    if (
      attempt.taskId === client.taskId &&
      attempt.status === "completed" &&
      attempt.executionCompleted === true &&
      placement.completed === true &&
      placement.harnessId === client.harness
    )
      observed.add(client.harness);
  }
  return observed;
}

/** Consume repeated status snapshots without duplicating historical call or failure evidence. */
export function takeUnseenTaskEvents(groups, seen) {
  const result = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (typeof group?.taskId !== "string" || !Array.isArray(group.events)) continue;
    for (const event of group.events) {
      if (typeof event?.id !== "string" || event.id.length === 0) continue;
      const key = JSON.stringify([group.taskId, event.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ taskId: group.taskId, event });
    }
  }
  return result;
}

/** Match Docker-observed container ownership with Control Plane-recorded Worker Host execution. */
export function observedDockerWorkerHarnesses({ workerHosts, attempts, placements, verification }) {
  const observed = new Set();
  if (
    workerHosts?.mode !== "docker" ||
    typeof workerHosts.owner !== "string" ||
    !workerHosts.owner ||
    !Array.isArray(workerHosts.workers) ||
    !Array.isArray(attempts) ||
    !Array.isArray(placements)
  )
    return observed;
  const workers = workerHosts.workers;
  if (
    workers.length !== 2 ||
    new Set(workers.map((w) => w.containerId)).size !== 2 ||
    new Set(workers.map((w) => w.workerHostId)).size !== 2
  )
    return observed;
  for (const [manager, harness] of [
    ["claude", "claude-code"],
    ["codex", "codex"],
  ]) {
    const own = workers.filter((w) => w.manager === manager);
    if (own.length !== 1) continue;
    const worker = own[0];
    if (
      worker.kind !== "docker" ||
      worker.runningObserved !== true ||
      worker.ownerLabel !== workerHosts.owner ||
      typeof worker.containerId !== "string" ||
      !worker.containerId ||
      typeof worker.workerHostId !== "string" ||
      !worker.workerHostId
    )
      continue;
    if (
      attempts.some(
        (a) =>
          a.workerHostId === worker.workerHostId &&
          a.status === "completed" &&
          a.executionCompleted === true &&
          observedMcpHarnesses({
            verification,
            attempts: [a],
            placements: placements.filter((p) => p.attemptId === a.id),
          }).has(harness),
      )
    )
      observed.add(harness);
  }
  return observed;
}
