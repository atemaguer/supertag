/**
 * The `app://supertag/` scheme the window loads the renderer from: a stable origin the IPC guard
 * and the navigation lock can check, unlike `file://`. Every response carries the CSP.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const APP_SCHEME = "app";
export const APP_HOST = "supertag";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/index.html`;

const COMMON = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

/**
 * The window's Content Security Policy. Calls to the main process are IPC, not a network origin,
 * so the page may connect only to itself; in development also to the Vite server, whose
 * React refresh preamble is an inline script.
 */
export function contentSecurityPolicy(devOrigin?: string): string {
  if (!devOrigin) return [...COMMON, "script-src 'self'", "connect-src 'self'"].join("; ");
  const socket = devOrigin.replace(/^http/, "ws");
  return [
    ...COMMON,
    "script-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${devOrigin} ${socket}`,
  ].join("; ");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The file under `root` an `app://supertag/...` request names, or nothing: another host, a path
 * that escapes the root, or a hidden segment. `/` is `index.html`.
 */
export function appFile(root: string, requestUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return undefined;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) return undefined;
  const relative = segments.length === 0 ? "index.html" : segments.join("/");
  const file = path.resolve(root, relative);
  const base = path.resolve(root);
  if (file !== base && !file.startsWith(base + path.sep)) return undefined;
  return file;
}

/** Answers one `app://` request from the built renderer in `root`. */
export async function appResponse(
  root: string,
  request: Pick<Request, "url" | "method">,
): Promise<Response> {
  const headers = {
    "Content-Security-Policy": contentSecurityPolicy(),
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  const notFound = () => new Response("Not found", { status: 404, headers });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers });
  }
  const file = appFile(root, request.url);
  if (!file) return notFound();
  try {
    // A link that leads out of the built renderer is refused, as a path that does.
    const [real, base] = await Promise.all([realpath(file), realpath(root)]);
    if (!real.startsWith(base + path.sep)) return notFound();
    if (!(await stat(real)).isFile()) return notFound();
    const body = await readFile(real);
    const type = TYPES[path.extname(real).toLowerCase()] ?? "application/octet-stream";
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: { ...headers, "Content-Type": type },
    });
  } catch {
    return notFound();
  }
}
