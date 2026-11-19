/**
 * The strings the window shows when a Gateway call fails. A handler throws one of these strings; never an upstream message, which
 * can carry request data, backend details, or a credential an unexpected server echoed.
 */
import { Code, ConnectError } from "./sdk";

/** The most of a Gateway's reason for refusing a request the app shows. */
const MAX_REASON_CHARS = 300;

export const CONNECT_FIRST = "Connect to a Gateway first.";
export const CONNECTION_CHANGED = "The connection changed. Refresh this view.";
export const UNREACHABLE =
  "Could not connect to the Gateway. Check its address and TLS certificate.";
export const INCOMPATIBLE =
  "This Gateway runs an incompatible SuperTag release. Use the same release for the Gateway and this app.";
export const INVALID_TOKEN = "Enter a valid operator token or Auth Key.";

/** How many causes `codeOf` follows looking for a reset connection. */
const MAX_CAUSES = 8;

/** Whether the Node.js error code `ECONNRESET` is somewhere in the error's causes. */
function connectionReset(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < MAX_CAUSES && cause instanceof Error; depth++) {
    if ((cause as NodeJS.ErrnoException).code === "ECONNRESET") return true;
    cause = cause.cause;
  }
  return false;
}

/**
 * A failed call's gRPC code. A connection the Gateway reset counts as Unavailable, as a refused
 * one does: connect-node reports a reset socket as Aborted (on Node.js and Bun alike), but
 * nothing was cancelled, and a later attempt may reach the Gateway.
 */
export function codeOf(error: unknown): Code {
  const status = ConnectError.from(error);
  if (status.code === Code.Aborted && connectionReset(status.cause)) return Code.Unavailable;
  return status.code;
}

/** A failed call's status: its gRPC code, as `codeOf` gives it, and the server's own message. */
export function statusOf(error: unknown): { code: Code; message: string } {
  return { code: codeOf(error), message: ConnectError.from(error).rawMessage };
}

/**
 * A failed call as the window shows it. Only the Gateway's InvalidArgument reasons are written
 * for the person who sent the request, so only those are shown: bounded and stripped of control
 * characters. Every other code has its own fixed sentence.
 */
export function rpcError(error: unknown): string {
  const { code, message } = statusOf(error);
  if (code === Code.InvalidArgument) {
    const reason = [...message.replace(/\p{Cc}/gu, "")]
      .slice(0, MAX_REASON_CHARS)
      .join("")
      .trim()
      .replace(/\.+$/u, "");
    return reason === ""
      ? "The Gateway rejected this request. Check its values."
      : `The Gateway rejected this request: ${reason}.`;
  }
  switch (code) {
    case Code.Unauthenticated:
      return "The Gateway rejected the saved credential.";
    case Code.PermissionDenied:
      return "This connection cannot access that resource.";
    case Code.NotFound:
      return "The requested resource is no longer available.";
    case Code.AlreadyExists:
      return "This operation conflicts with an earlier request.";
    case Code.FailedPrecondition:
      return "This action is not available in the current state.";
    case Code.ResourceExhausted:
      return "The Gateway limit was reached. Try a smaller request.";
    case Code.DeadlineExceeded:
    case Code.Unavailable:
      return "The Gateway is unavailable. Try again once it is running.";
    default:
      return "The Gateway request failed.";
  }
}

/** Runs a Gateway call, turning its failure into the window's string with `map`. */
export async function rpc<T>(
  call: () => Promise<T>,
  map: (error: unknown) => string = rpcError,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw map(error);
  }
}

/** A credential as a bearer token: 1 to 8192 ASCII graphic characters, as the Rust rule. */
export function checkBearer(token: string): string {
  if (token.length === 0 || token.length > 8192 || !/^[\x21-\x7e]+$/u.test(token)) {
    throw INVALID_TOKEN;
  }
  return token;
}
