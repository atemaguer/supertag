import { Container } from "@cloudflare/containers";
import { DEPLOYMENT_RUNTIME } from "../../shared/src/index";
import { containerEnvironment } from "./config";
import { maintainContainer, routeRequest } from "./routing";

interface Env extends Record<string, unknown> {
  CONTROL_PLANE: DurableObjectNamespace<SuperTagControlPlane>;
}

export class SuperTagControlPlane extends Container<Env> {
  defaultPort = DEPLOYMENT_RUNTIME.port;
  sleepAfter = "10m";
  envVars = containerEnvironment(this.env);

  // Scheduling and outbound surface activity must continue without inbound HTTP traffic.
  override async onActivityExpired(): Promise<void> {
    if (this.env.SUPERTAG_MAINTENANCE === "true") await this.stop();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return routeRequest(request, env);
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await maintainContainer(env);
  },
} satisfies ExportedHandler<Env>;
