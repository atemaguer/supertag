import {
  type HarnessControlCapabilities,
  type HarnessExecutionControl,
  validateHarnessControlCapabilities,
} from "./harness-control.js";
import type {
  CapabilityIdentifier,
  HarnessCapabilities,
  HarnessResolution,
  HarnessRuntime,
} from "./index.js";

/** Effective support can narrow registration, but cannot silently add authority or features. */
export function validateHarnessResolution(
  declared: HarnessCapabilities,
  resolution: HarnessResolution,
  runtime: HarnessRuntime,
  providerCapabilities: readonly CapabilityIdentifier[],
  executionProviderCapabilities: readonly CapabilityIdentifier[] = providerCapabilities,
): void {
  const actual = resolution.capabilities;
  for (const support of [declared, actual]) {
    validateHarnessSessionCapabilities(support);
    validateHarnessExecutionLimitCapabilities(support);
    validateMcpClientSupport(support);
  }
  if (actual.sessionPersistence === "native" && actual.sessions?.scope === "none")
    throw new Error("Native sessionState support requires a session persistence scope");
  if (declared.control) validateHarnessControlCapabilities(declared.control);
  if (actual.control) validateHarnessControlCapabilities(actual.control);
  if (actual.id !== declared.id || actual.version !== declared.version)
    throw new Error("Resolved Harness identity differs from registration");
  if (JSON.stringify(resolution).length > 32_768)
    throw new Error("Harness resolution exceeds 32768 characters");
  for (const flag of ["streaming", "cancellation"] as const)
    if (actual[flag] && !declared[flag]) throw new Error(`Resolved Harness cannot add ${flag}`);
  if (
    actual.sessionPersistence !== "none" &&
    actual.sessionPersistence !== declared.sessionPersistence
  )
    throw new Error("Resolved Harness cannot add sessionState support");
  if (actual.inputKinds.some((kind) => !declared.inputKinds.includes(kind)))
    throw new Error("Resolved Harness cannot add input kinds");
  for (const key of ["maxNativeAgents", "maxReportedTokens", "maxReportedCost"] as const)
    if (actual.executionLimits?.[key] && !declared.executionLimits?.[key])
      throw new Error(`Resolved Harness cannot add ${key} enforcement`);
  for (const client of actual.mcpClients ?? []) {
    const declaredClient = declared.mcpClients?.find(
      (candidate) => candidate.client === client.client,
    );
    if (
      declaredClient === undefined ||
      client.transports.some((transport) => !declaredClient.transports.includes(transport))
    )
      throw new Error("Resolved Harness cannot add MCP client support");
  }
  if (
    actual.runtimePlacements?.some(
      (placement) =>
        declared.runtimePlacements !== undefined && !declared.runtimePlacements.includes(placement),
    )
  )
    throw new Error("Resolved Harness cannot add runtime placements");
  for (const support of [declared, actual]) {
    if (support.runtimePlacements && !support.runtimePlacements.includes(runtime.placement))
      throw new Error(`Harness cannot run in ${runtime.placement} placement`);
    for (const required of support.requiredRuntimeCapabilities ?? [])
      if (
        !providerCapabilities.some(
          (item) => item.id === required.id && item.version === required.version,
        )
      )
        throw new Error(`Harness runtime lacks ${required.id}@${required.version}`);
    for (const required of support.requiredExecutionCapabilities ?? [])
      if (
        !executionProviderCapabilities.some(
          (item) => item.id === required.id && item.version === required.version,
        )
      )
        throw new Error(`Execution environment lacks ${required.id}@${required.version}`);
  }
  if (actual.control) validateControlRefinement(declared.control, actual.control);
  if (
    actual.sessions &&
    actual.sessions.scope !== "none" &&
    actual.sessions.scope !== declared.sessions?.scope
  )
    throw new Error("Resolved Harness cannot change session persistence scope");
  for (const flag of ["resume", "export"] as const)
    if (actual.sessions?.[flag] && !declared.sessions?.[flag])
      throw new Error(`Resolved Harness cannot add session ${flag}`);
  if (actual.sessions?.scope === "local" && runtime.placement !== "local")
    throw new Error("Local native session support cannot be advertised remotely");
  if (actual.sessions?.scope === "none" && (actual.sessions.resume || actual.sessions.export))
    throw new Error("Session support needs a persistence scope");
}

/** Session support must be explicit, including harnesses with no persistence. */
export function validateHarnessSessionCapabilities(capabilities: HarnessCapabilities): void {
  const sessions = capabilities.sessions;
  if (
    !sessions ||
    typeof sessions.resume !== "boolean" ||
    typeof sessions.export !== "boolean" ||
    !["none", "local", "environment", "portable"].includes(sessions.scope)
  )
    throw new Error(
      "Invalid Harness session capabilities: sessions must declare resume, export, and scope",
    );
}

function validateMcpClientSupport(capabilities: HarnessCapabilities): void {
  const clients = capabilities.mcpClients ?? [];
  if (new Set(clients.map((client) => client.client)).size !== clients.length)
    throw new Error("Harness MCP client placements must be unique");
  for (const client of clients) {
    if (
      !["harness-runtime", "worker-host", "execution-environment"].includes(client.client) ||
      client.transports.length === 0 ||
      new Set(client.transports).size !== client.transports.length ||
      client.transports.some(
        (transport) =>
          transport !== "mcp-http" && transport !== "mcp-stdio" && transport !== "worker-local",
      )
    )
      throw new Error("Invalid Harness MCP client support");
  }
}

export function validateHarnessExecutionLimitCapabilities(capabilities: HarnessCapabilities): void {
  const native = capabilities.executionLimits?.maxNativeAgents;
  if (
    native !== undefined &&
    (native.minimum !== 0 || !Number.isSafeInteger(native.maximum) || native.maximum < 0)
  )
    throw new Error("Invalid native agent limit capability");
  const tokens = capabilities.executionLimits?.maxReportedTokens;
  if (
    tokens !== undefined &&
    (tokens.minimum !== 1 ||
      !Number.isSafeInteger(tokens.maximum) ||
      tokens.maximum < 1 ||
      tokens.enforcement !== "interrupt-on-report")
  )
    throw new Error("Invalid reported token limit capability");
  const cost = capabilities.executionLimits?.maxReportedCost;
  if (
    cost !== undefined &&
    (cost.minimum !== 0 ||
      !Number.isSafeInteger(cost.maximum) ||
      cost.maximum < 0 ||
      cost.enforcement !== "provider-budget" ||
      !Array.isArray(cost.currencies) ||
      cost.currencies.length === 0 ||
      cost.currencies.some((currency) => !/^[A-Z]{3}$/u.test(currency)) ||
      new Set(cost.currencies).size !== cost.currencies.length)
  )
    throw new Error("Invalid reported cost limit capability");
}

/** A live channel must preserve the semantics resolved before Harness startup. */
export function validateExecutionControl(
  control: HarnessExecutionControl,
  capabilities: HarnessCapabilities,
  identity: { readonly taskId: string; readonly attemptId: string },
): void {
  if (!capabilities.control) throw new Error("Harness returned an undeclared control channel");
  validateControlRefinement(capabilities.control, control.capabilities);
  if (control.taskId !== identity.taskId || control.attemptId !== identity.attemptId)
    throw new Error("Harness control channel belongs to another Attempt");
}

function validateControlRefinement(
  declared: HarnessControlCapabilities | undefined,
  actual: HarnessControlCapabilities,
): void {
  validateHarnessControlCapabilities(actual);
  if (actual.operations.some((operation) => !declared?.operations.includes(operation)))
    throw new Error("Resolved Harness cannot add control operations");
  if (actual.inputMode !== undefined && actual.inputMode !== declared?.inputMode)
    throw new Error("Resolved Harness cannot change input control semantics");
}
