import { Container, getContainer } from "@cloudflare/containers";
import {
  containerCommand,
  containerEnvironment,
  forwardable,
  HEALTH_PATH,
  TUNNEL_PORT,
} from "./routing";

interface Env extends Record<string, unknown> {
  SUPERTAG: DurableObjectNamespace<SuperTag>;
}

/** One SuperTag container; `max_instances` is 1 and every request uses this one name. */
const INSTANCE = "supertag";

export class SuperTag extends Container<Env> {
  defaultPort = TUNNEL_PORT;
  // Readiness probe: the tunnel listener's health route (any answer would do, but only this
  // route answers plain HTTP).
  pingEndpoint = `localhost${HEALTH_PATH}`;
  // Open tunnels keep the container awake, and the cron trigger renews it every minute, so
  // the controllers keep running with no client connected.
  sleepAfter = "10m";
  enableInternet = true;
  envVars = containerEnvironment(this.env);
  entrypoint = containerCommand(this.env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const forwarded = forwardable(request);
    if (forwarded instanceof Response) return forwarded;
    return getContainer(env.SUPERTAG, INSTANCE).fetch(forwarded);
  },
  // Starts the container after a deploy or a restart without waiting for a client, and keeps
  // it from sleeping.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const response = await getContainer(env.SUPERTAG, INSTANCE).fetch(
      new Request(`http://localhost${HEALTH_PATH}`),
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error(`SuperTag health check failed (${response.status})`);
  },
} satisfies ExportedHandler<Env>;
