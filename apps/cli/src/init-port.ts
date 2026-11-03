import { createServer } from "node:net";
import { controlPlaneSlot, readStatus, runningProcess } from "./local-state.js";

/** Check before init writes its services file. Port zero asks the OS to choose at startup. */
export async function availableInitPort(options: {
  port: number;
  host: string;
  yes: boolean;
  portVariable?: string;
  write: (text: string) => void;
}): Promise<number> {
  const { port, host, portVariable } = options;
  if (port === 0) return port;
  const slot = controlPlaneSlot();
  if ((await runningProcess(slot)).pid !== undefined) {
    const status = await readStatus(slot);
    const endpoint = status?.resolved?.["ports"] as { host?: string; port?: number } | undefined;
    if (status?.state === "ready" && endpoint?.host === host && endpoint.port === port) return port;
  }
  if (await canListen(host, port)) return port;
  const guidance = `Port ${port} on ${host} is in use. ${portVariable === undefined ? "Choose another port and run supertag init again." : `Unset ${portVariable} or choose a free port in that environment variable, then run supertag init again.`}`;
  // Environment settings override YAML, so saving a different port cannot fix that collision.
  if (!options.yes || portVariable !== undefined) throw new Error(guidance);
  for (let candidate = port + 1; candidate <= 65_535; candidate += 1) {
    if (await canListen(host, candidate)) {
      options.write(`Port ${port} is in use; using ${candidate}.\n`);
      return candidate;
    }
  }
  throw new Error(guidance);
}

async function canListen(host: string, port: number): Promise<boolean> {
  const server = createServer();
  return new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => (error === undefined ? resolve(true) : reject(error)));
    });
  });
}
