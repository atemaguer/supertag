import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { SurfaceController } from "./gateway-surfaces.js";
import { SUPERTAG_VERSION, VERSION_HEADER } from "./version.js";

export interface GatewayDependencies {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly surfaceController: SurfaceController;
  readonly handleRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

/**
 * The protocol boundary of one Control Plane process. It owns network listeners,
 * surface runtimes, request normalization, and response transport. Durable
 * admission, scheduling, organization state, and recovery remain in ControlPlane.
 */
export class Gateway {
  readonly #dependencies: GatewayDependencies;
  readonly #surfaceController: SurfaceController;
  readonly #activeRequests = new Set<Promise<void>>();
  #requestListener: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  #surfaceStop: Promise<void> | undefined;
  #draining = false;

  constructor(dependencies: GatewayDependencies) {
    this.#dependencies = dependencies;
    this.#surfaceController = dependencies.surfaceController;
  }

  async start(): Promise<string> {
    if (this.#requestListener !== undefined) throw new Error("Gateway is already running");
    await this.#surfaceController.start();
    this.#surfaceStop = undefined;
    this.#draining = false;
    this.#requestListener = (request, response) => {
      // Every response, including refusals and failures, names the release that produced it.
      response.setHeader(VERSION_HEADER, SUPERTAG_VERSION);
      if (this.#draining && !allowedDuringDrain(request)) {
        writeJson(response, 503, { error: "control_plane_draining" });
        return;
      }
      let releaseRequest: (() => void) | undefined;
      const activeRequest = new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      this.#activeRequests.add(activeRequest);
      void this.#dependencies
        .handleRequest(request, response)
        .catch((error: unknown) => {
          if (!response.headersSent) {
            writeJson(response, 500, { error: "ingestion_failed", message: errorMessage(error) });
          } else {
            response.end();
          }
        })
        .finally(() => {
          this.#activeRequests.delete(activeRequest);
          releaseRequest?.();
        });
    };
    this.#dependencies.server.on("request", this.#requestListener);
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        this.#dependencies.server.once("error", failed);
        this.#dependencies.server.listen(this.#dependencies.port, this.#dependencies.host, () => {
          this.#dependencies.server.off("error", failed);
          resolve();
        });
      });
    } catch (error) {
      this.#dependencies.server.off("request", this.#requestListener);
      this.#requestListener = undefined;
      this.#surfaceStop ??= this.#surfaceController.stop();
      await this.#surfaceStop;
      throw error;
    }
    const address = this.#dependencies.server.address();
    const boundPort =
      typeof address === "object" && address !== null ? address.port : this.#dependencies.port;
    return `http://${this.#dependencies.host}:${boundPort}`;
  }

  /** Stop admitting network work while allowing accepted requests to finish. */
  beginDrain(): void {
    this.#draining = true;
    this.#surfaceStop ??= this.#surfaceController.stop();
  }

  async drain(): Promise<void> {
    this.beginDrain();
    await Promise.all([this.#surfaceStop, ...this.#activeRequests]);
  }

  async stop(): Promise<void> {
    await this.drain();
    if (this.#requestListener !== undefined) {
      this.#dependencies.server.off("request", this.#requestListener);
      this.#requestListener = undefined;
    }
    if (!this.#dependencies.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#dependencies.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

function allowedDuringDrain(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  return (
    (request.method === "GET" &&
      (pathname === "/health" || pathname === "/healthz" || pathname === "/readyz")) ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/internal/v1/")
  );
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
