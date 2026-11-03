import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { policyRequest } from "./policy-client.mjs";

const tools = [
  {
    name: "policy_status",
    description: "Read the current policy and revision for an incident.",
    inputSchema: {
      type: "object",
      properties: { incidentId: { type: "string" } },
      required: ["incidentId"],
      additionalProperties: false,
    },
  },
  {
    name: "operation_status",
    description:
      "Inspect a durable provider receipt. null means no committed operation; an error means unknown, not absent.",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string" } },
      required: ["operationId"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_policy",
    description:
      "Apply reviewed policy bytes once using an operation ID and expected revision. After any error, inspect operation_status before considering a retry.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string" },
        incidentId: { type: "string" },
        expectedRevision: { type: "integer" },
        responseMinutes: { type: "integer", enum: [30] },
        sourceArtifactId: { type: "string" },
        sourceDigest: { type: "string" },
      },
      required: [
        "operationId",
        "incidentId",
        "expectedRevision",
        "responseMinutes",
        "sourceArtifactId",
        "sourceDigest",
      ],
      additionalProperties: false,
    },
  },
];
for (const tool of tools) {
  tool.inputSchema.properties.collection = { type: "string", enum: ["support"] };
  tool.inputSchema.required.push("collection");
}
const server = new Server(
  { name: "support-policy", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const args = params.arguments ?? {};
    if (args.collection !== "support") throw new Error("Out-of-scope collection");
    let value;
    if (params.name === "policy_status")
      value = await policyRequest(
        process.env.SUPPORT_POLICY_URL,
        process.env.SUPPORT_POLICY_TOKEN,
        `/policy?incidentId=${encodeURIComponent(args.incidentId)}`,
      );
    else if (params.name === "operation_status")
      value = await policyRequest(
        process.env.SUPPORT_POLICY_URL,
        process.env.SUPPORT_POLICY_TOKEN,
        `/operation?operationId=${encodeURIComponent(args.operationId)}`,
      );
    else if (params.name === "apply_policy")
      value = await policyRequest(
        process.env.SUPPORT_POLICY_URL,
        process.env.SUPPORT_POLICY_TOKEN,
        "/apply",
        args,
      );
    else throw new Error("Unknown tool");
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
