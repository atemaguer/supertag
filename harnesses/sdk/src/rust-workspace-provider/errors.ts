/**
 * A provider's configuration the operator must fix, such as a missing account resource. Its
 * message reaches the Worker Host as is, so it must name only operator configuration, never a
 * credential or Task data.
 */
export class WorkspaceConfigurationError extends Error {
  override readonly name = "WorkspaceConfigurationError";
}
