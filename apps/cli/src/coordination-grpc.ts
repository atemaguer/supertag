import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import type { ObjectiveController } from "@supertag/control-plane";
import { TagMessagingError } from "@supertag/core";
import {
  COORDINATION_GRPC_MAX_INPUT_BYTES,
  COORDINATION_GRPC_MAX_OUTPUT_BYTES,
  CoordinationService,
  decodeCoordinationDocument,
  ExecutionAuthorityService,
  encodeCoordinationDocument,
} from "@supertag/worker-transport";
import { coordinationTools, isHiddenCoordinationTool, surfaceTools } from "./coordination-http.js";

export function registerCoordinationGrpcRoutes(
  router: ConnectRouter,
  controller: Pick<
    ObjectiveController,
    "authenticate" | "coordinationActions" | "commandAsAttempt" | "rebindExecutionCredential"
  >,
  options: { readonly beginRequest?: () => () => void } = {},
): void {
  let active = 0;
  async function run<T>(
    context: HandlerContext,
    operation: (token: string | undefined) => Promise<T>,
  ): Promise<T> {
    const timeout = context.timeoutMs();
    if (timeout === undefined || timeout > 60_000)
      throw new ConnectError(
        "Coordination calls require a deadline of at most 60 seconds",
        Code.InvalidArgument,
      );
    if (active >= 64)
      throw new ConnectError("Coordination capacity exhausted", Code.ResourceExhausted);
    const release = options.beginRequest?.();
    active++;
    try {
      if (context.signal.aborted)
        throw new ConnectError("Coordination request cancelled", Code.Canceled);
      const authorization = context.requestHeader.get("authorization");
      return await operation(
        authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined,
      );
    } catch (error) {
      throw safeError(error);
    } finally {
      active--;
      release?.();
    }
  }
  async function allowed(token: string | undefined) {
    const caller = await controller.authenticate(token);
    const actions = await controller.coordinationActions(caller);
    const tools = (
      "kind" in caller && caller.kind === "surface" ? surfaceTools : coordinationTools
    ).filter((tool) => actions.includes(tool.name));
    return { caller, tools };
  }
  const limits = {
    maxTimeoutMs: 60_000,
    readMaxBytes: COORDINATION_GRPC_MAX_INPUT_BYTES,
    writeMaxBytes: COORDINATION_GRPC_MAX_OUTPUT_BYTES,
  };
  router.service(
    CoordinationService,
    {
      listTools: (_, context) =>
        run(context, async (token) => {
          const { tools } = await allowed(token);
          return {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: encodeCoordinationDocument(tool.inputSchema),
            })),
          };
        }),
      callTool: (request, context) =>
        run(context, async (token) => {
          const { caller, tools } = await allowed(token);
          if (
            !tools.some((tool) => tool.name === request.name) &&
            !isHiddenCoordinationTool(request.name)
          )
            throw new ConnectError("Unknown coordination tool", Code.InvalidArgument);
          const input = decodeCoordinationDocument(request.arguments);
          try {
            const result = await controller.commandAsAttempt(request.name, input, caller);
            return { isError: false, content: [{ text: JSON.stringify(result) }] };
          } catch (error) {
            if (error instanceof TagMessagingError && error.statusCode === 401) throw error;
            return {
              isError: true,
              content: [
                {
                  text:
                    error instanceof TagMessagingError
                      ? error.message
                      : "Coordination command failed",
                },
              ],
            };
          }
        }),
    },
    limits,
  );
  router.service(
    ExecutionAuthorityService,
    {
      rebind: (_, context) => run(context, (token) => controller.rebindExecutionCredential(token)),
    },
    { ...limits, readMaxBytes: 8192, writeMaxBytes: 8192 },
  );
}
function safeError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof TagMessagingError) {
    const code =
      {
        400: Code.InvalidArgument,
        401: Code.Unauthenticated,
        403: Code.PermissionDenied,
        404: Code.NotFound,
        409: Code.FailedPrecondition,
        413: Code.ResourceExhausted,
      }[error.statusCode] ?? Code.Internal;
    return new ConnectError(
      code === Code.Internal ? "Coordination unavailable" : error.message,
      code,
    );
  }
  return new ConnectError("Coordination unavailable", Code.Internal);
}
