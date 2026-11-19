/**
 * Which Gateway URLs the app dials, and the form each is saved under. `https://` and loopback
 * `http://` URLs dial native gRPC; `wss://` and loopback `ws://` URLs carry the same connection
 * through a WebSocket tunnel, which may have a path. As the Rust app's `endpoint` and
 * `gateway_origin`, with the same messages.
 */
import { isIP } from "node:net";

const MAX_ORIGIN_BYTES = 2048;
const INVALID =
  "The Gateway URL must be an origin without credentials, path, or query, or a tunnel URL without credentials or query.";

function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "");
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  if (isIP(host) === 6) return host === "::1" || /^(0{1,4}:){7}0{0,3}1$/u.test(host);
  return false;
}

/** A checked Gateway URL: what the client dials, and whether it is a tunnel. */
export interface Target {
  readonly url: string;
  readonly tunnel: boolean;
}

/** Checks a Gateway URL the way the app dials it, or throws the window's message. */
export function endpoint(value: string): Target {
  if (value.includes("#") || value.includes("\\")) {
    throw "Enter a valid Gateway origin without a fragment.";
  }
  const gateway = value.trim();
  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw /^wss?:/iu.test(gateway) ? INVALID : "Enter a valid Gateway URL.";
  }
  const scheme = url.protocol;
  const tunnel = scheme === "ws:" || scheme === "wss:";
  if (url.username !== "" || url.password !== "" || gateway.includes("?")) throw INVALID;
  if (!["http:", "https:", "ws:", "wss:"].includes(scheme)) {
    if (url.host === "") throw "Enter a Gateway host.";
    throw "The Gateway URL must use HTTP, HTTPS, WS, or WSS.";
  }
  if (url.hostname === "") throw "Enter a Gateway host.";
  if (!tunnel && url.pathname !== "/" && url.pathname !== "") throw INVALID;
  if (url.port === "0") throw INVALID;
  if ((scheme === "http:" || scheme === "ws:") && !loopbackHost(url.hostname)) {
    throw "HTTP and WS require a loopback IP address. Use HTTPS or WSS for a remote Gateway.";
  }
  return { url: gateway, tunnel };
}

/**
 * The form a Gateway is saved under: its origin, plus the path of a tunnel URL. Saved origins
 * always contain `://`, so they never collide with the local Gateway's `local`.
 */
export function gatewayOrigin(address: string): string {
  if (Buffer.byteLength(address) > MAX_ORIGIN_BYTES) {
    throw "Enter a Gateway URL of up to 2048 characters.";
  }
  const checked = endpoint(address);
  const url = new URL(checked.url);
  let origin = `${url.protocol}//${url.host}`;
  if (checked.tunnel && url.pathname !== "/" && url.pathname !== "") origin += url.pathname;
  endpoint(origin);
  return origin;
}
