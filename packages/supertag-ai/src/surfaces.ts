/** Beta contracts for Surface implementations. */

export type {
  InboundEventSink,
  Surface,
  SurfaceIdentity,
  SurfaceMarkdownDocument,
  SurfaceMarkdownNode,
  SurfacePresentation,
  SurfaceReplyCapabilities,
  VerifiedSurfaceAccount,
} from "../../surfaces/sdk/src/index.js";
export {
  parseSurfaceMarkdown,
  readSurfaceAccountCredentials,
  requiredSurfaceSecret,
  serializeSurfaceMarkdown,
  surfaceConfigurationString,
} from "../../surfaces/sdk/src/index.js";
