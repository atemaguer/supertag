import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import type { TagMailboxService } from "@supertag/control-plane";
import { TagMessagingError } from "@supertag/core";
import {
  decodeObjectiveInput,
  decodeSend,
  encodeMessage,
  encodeObjective,
  encodePost,
  encodeWorkstream,
  MAILBOX_GRPC_MAX_REQUEST_BYTES,
  MAILBOX_GRPC_MAX_RESPONSE_BYTES,
  mailboxRecord,
  mailboxProtocol as p,
} from "@supertag/worker-transport/mailbox-rpc";

/** Named RPC edge; TagMailboxService remains responsible for credentials, grants and lease fencing. */
export function registerMailboxGrpcRoutes(
  router: ConnectRouter,
  service: TagMailboxService,
  options: { readonly beginRequest?: () => () => void } = {},
): void {
  let polls = 0;
  let commands = 0;
  async function run<T>(
    context: HandlerContext,
    poll: boolean,
    operation: (token: string | undefined) => Promise<T>,
  ): Promise<T> {
    const timeout = context.timeoutMs();
    if (timeout === undefined || timeout > 30_000)
      throw new ConnectError(
        "Mailbox calls require a deadline of at most 30 seconds",
        Code.InvalidArgument,
      );
    // Long polls never consume the slots needed to acknowledge or renew already claimed work.
    if ((poll ? polls : commands) >= 64)
      throw new ConnectError("Mailbox capacity exhausted", Code.ResourceExhausted);
    const release = options.beginRequest?.();
    if (poll) polls++;
    else commands++;
    try {
      context.signal.throwIfAborted();
      const authorization = context.requestHeader.get("authorization");
      return await operation(
        authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined,
      );
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      if (context.signal.aborted)
        throw new ConnectError("Mailbox request cancelled", Code.Canceled);
      if (error instanceof TagMessagingError) {
        const codes: Record<number, Code> = {
          400: Code.InvalidArgument,
          401: Code.Unauthenticated,
          403: Code.PermissionDenied,
          404: Code.NotFound,
          409: Code.Aborted,
          413: Code.ResourceExhausted,
          429: Code.ResourceExhausted,
          503: Code.Unavailable,
        };
        throw new ConnectError(error.message, codes[error.statusCode] ?? Code.Internal);
      }
      throw new ConnectError("Mailbox operation failed", Code.Internal);
    } finally {
      if (poll) polls--;
      else commands--;
      release?.();
    }
  }
  const withoutId = (value: Record<string, unknown>) => {
    const { id: _, ...body } = value;
    return body;
  };
  router.service(
    p.MailboxService,
    {
      send: (request, context) =>
        run(context, false, async (token) => {
          const result = await service.send(token, decodeSend(request));
          return { message: encodeMessage(result.message), duplicate: result.duplicate };
        }),
      history: (request, context) =>
        run(context, false, async (token) => {
          const result = await service.history(
            token,
            mailboxRecord(p.HistoryRequestSchema, request),
          );
          return {
            items: result.items.map(encodeMessage),
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          };
        }),
      receive: (request, context) =>
        run(context, true, async (token) => {
          const delivery = await service.receive(
            token,
            mailboxRecord(p.ReceiveRequestSchema, request),
            context.signal,
          );
          return delivery
            ? {
                delivery: {
                  message: encodeMessage(delivery.message),
                  leaseToken: delivery.leaseToken,
                  leaseExpiresAt: delivery.leaseExpiresAt,
                },
              }
            : {};
        }),
      acknowledge: (request, context) =>
        run(context, false, async (token) => {
          await service.settle(token, request.messageId, "ack", { leaseToken: request.leaseToken });
          return {};
        }),
      release: (request, context) =>
        run(context, false, async (token) => {
          await service.settle(token, request.messageId, "release", {
            leaseToken: request.leaseToken,
            ...(request.retry === undefined ? {} : { retry: request.retry }),
          });
          return {};
        }),
      renew: (request, context) =>
        run(context, false, async (token) => {
          await service.settle(token, request.messageId, "renew", {
            leaseToken: request.leaseToken,
            ...(request.leaseMs === undefined ? {} : { leaseMs: request.leaseMs }),
          });
          return {};
        }),
      createObjective: (request, context) =>
        run(context, false, async (token) =>
          encodeObjective(await service.createObjective(token, decodeObjectiveInput(request))),
        ),
      getObjective: (request, context) =>
        run(context, false, async (token) =>
          encodeObjective(await service.getObjective(token, request.id)),
        ),
      listObjectives: (request, context) =>
        run(context, false, async (token) => ({
          items: (
            await service.listObjectives(
              token,
              mailboxRecord(p.ListObjectivesRequestSchema, request),
            )
          ).map(encodeObjective),
        })),
      updateObjectiveStatus: (request, context) =>
        run(context, false, async (token) =>
          encodeObjective(
            await service.updateObjectiveStatus(
              token,
              request.id,
              withoutId(mailboxRecord(p.UpdateObjectiveStatusRequestSchema, request)),
            ),
          ),
        ),
      getWorkstream: (request, context) =>
        run(context, false, async (token) =>
          encodeWorkstream(await service.getWorkstream(token, request.id)),
        ),
      listWorkstreams: (request, context) =>
        run(context, false, async (token) => ({
          items: (
            await service.listWorkstreams(
              token,
              mailboxRecord(p.ListWorkstreamsRequestSchema, request),
            )
          ).map(encodeWorkstream),
        })),
      postWorkstream: (request, context) =>
        run(context, false, async (token) => {
          // A repeated field cannot be absent; an empty `to` means the post names no Tags.
          const { to, ...body } = withoutId(mailboxRecord(p.PostWorkstreamRequestSchema, request));
          return encodePost(
            await service.postWorkstream(token, request.id, {
              ...body,
              ...(request.to.length ? { to } : {}),
            }),
          );
        }),
      workstreamPosts: (request, context) =>
        run(context, false, async (token) => ({
          items: (
            await service.listWorkstreamPosts(
              token,
              request.id,
              withoutId(mailboxRecord(p.WorkstreamPostsRequestSchema, request)),
            )
          ).map(encodePost),
        })),
    },
    {
      readMaxBytes: MAILBOX_GRPC_MAX_REQUEST_BYTES,
      writeMaxBytes: MAILBOX_GRPC_MAX_RESPONSE_BYTES,
      maxTimeoutMs: 30_000,
    },
  );
}
