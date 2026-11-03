import { DEPLOYMENT_RUNTIME } from "../../shared/src/index";

interface RoutingEnv {
  SUPERTAG_MAINTENANCE?: unknown;
  CONTROL_PLANE: {
    getByName(name: string): {
      fetch(request: Request): Promise<Response>;
      stop(): Promise<void>;
    };
  };
}

const instanceName = "control-plane";

export async function routeRequest(request: Request, env: RoutingEnv): Promise<Response> {
  if (env.SUPERTAG_MAINTENANCE === "true")
    return new Response("Control Plane maintenance", { status: 503 });
  // Preserve URLs, bodies, auth headers, and WebSocket upgrades. The API Server authenticates.
  return env.CONTROL_PLANE.getByName(instanceName).fetch(request);
}

export async function maintainContainer(env: RoutingEnv): Promise<void> {
  const container = env.CONTROL_PLANE.getByName(instanceName);
  if (env.SUPERTAG_MAINTENANCE === "true") {
    await container.stop();
    return;
  }
  // Wakes the instance after replacement or failure without waiting for a user request.
  const response = await container.fetch(
    new Request(`http://localhost${DEPLOYMENT_RUNTIME.healthPath}`),
  );
  if (!response.ok) throw new Error(`Control Plane health check failed (${response.status})`);
  await response.body?.cancel();
}
