import type { GatewayRelease } from "@supertag/client/model";
import { version } from "../../package.json";

/** This app's SuperTag release, from its package, as Electron's `app.getVersion()` reads it. */
export const APP_VERSION: string = version;

/** Whether the connected Gateway runs another release than the app; false while disconnected. */
export function releaseDiffers(app: string, gateway?: GatewayRelease): boolean {
  return gateway !== undefined && gateway.build !== app;
}
