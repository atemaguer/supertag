import { resolveDeploymentEnvironment } from "../../shared/src/index";

export function containerEnvironment(env: Record<string, unknown>): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") strings[key] = value;
  }
  return resolveDeploymentEnvironment("cloudflare", strings);
}
