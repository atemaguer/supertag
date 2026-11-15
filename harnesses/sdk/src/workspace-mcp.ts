/**
 * One selected server as the trusted commit's `.mcp.json` declares it, with no value resolved,
 * so it is safe to give a provider. A stdio server's `env` maps each variable it sets to the host
 * variable it references, such as `SUPERTAG_MCP_TOKEN`. HTTP servers carry only their name: their
 * URL and headers stay with the Worker's policy proxy.
 */
export type WorkspaceMcpServerDefinition =
  | { readonly name: string; readonly transport: "http" }
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };
