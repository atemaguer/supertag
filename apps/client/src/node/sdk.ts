/**
 * The one place the main process takes `supertag-ai/gateway-client` from: the SDK's own source
 * in this repository, bundled into the main process, so the app and the published SDK are one
 * client and `PROTOCOL_VERSIONS` stays single-sourced.
 */
export * from "../../../../sdks/typescript/src/gateway-client";
