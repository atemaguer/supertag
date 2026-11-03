import type { SessionStateRef, SessionStateStore, StoredHarnessSessionState } from "./index.js";

/** Worker-side access to the current Attempt's private, Session-owned native state. */
export class HttpSessionStateStore implements SessionStateStore {
  readonly #base: string;
  #authorization: string;
  #refreshing: Promise<void> | undefined;
  readonly #versions = new Map<string, number>();

  constructor(options: { readonly controlPlaneUrl: string; readonly token: string }) {
    const url = new URL(options.controlPlaneUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error("Session persistence requires HTTPS outside loopback");
    this.#base = url.origin;
    this.#authorization = `Bearer ${options.token}`;
  }

  async load(ref: SessionStateRef): Promise<StoredHarnessSessionState | undefined> {
    const result = await this.#request("load", { ref });
    return result === null ? undefined : (result as StoredHarnessSessionState);
  }

  async save(state: StoredHarnessSessionState): Promise<void> {
    const writeVersion = (this.#versions.get(state.ref.id) ?? 0) + 1;
    this.#versions.set(state.ref.id, writeVersion);
    await this.#request("save", { ...state, writeVersion });
  }

  async #request(operation: string, value: unknown): Promise<unknown> {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error("Session state exceeds 16 MiB");
    for (let attempt = 0; attempt < 3; attempt++) {
      const authorization = this.#authorization;
      const response = await fetch(`${this.#base}/internal/v1/sessions/${operation}`, {
        method: "POST",
        body,
        redirect: "error",
        headers: { authorization, "content-type": "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Session persistence returned no response");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 16 * 1024 * 1024) throw new Error("Session state exceeds 16 MiB");
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      await response.body?.cancel();
      if (response.status === 401 && attempt === 0) {
        this.#refreshing ??= this.#refresh(authorization).finally(() => {
          this.#refreshing = undefined;
        });
        await this.#refreshing;
        continue;
      }
      if (attempt < 2 && [502, 503, 504].includes(response.status)) continue;
      throw new Error(`Session persistence ${operation} failed (HTTP ${response.status})`);
    }
    throw new Error("Session persistence unavailable");
  }

  async #refresh(authorization: string): Promise<void> {
    const response = await fetch(`${this.#base}/internal/v1/coordination/rebind`, {
      method: "POST",
      redirect: "error",
      headers: { authorization },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Session execution authority expired");
    }
    const value = (await response.json()) as { token?: string };
    if (!value.token) throw new Error("Session execution authority unavailable");
    this.#authorization = `Bearer ${value.token}`;
  }
}
