import type { GatewayActivation, GatewayList } from "@supertag/client/model";
import type { SetupCheck } from "./gateway";

/** What the window asks while it decides its first screen. */
export interface StartupApi {
  list(): Promise<GatewayList>;
  localStartNeeded(): Promise<boolean>;
  startLocal(): Promise<boolean>;
  select(origin: string): Promise<GatewayActivation>;
  connectLocal(): Promise<GatewayActivation>;
  check(): Promise<SetupCheck>;
}

/** The window's first screen: a connection, the setup screen, or neither (the empty state). */
export interface Startup {
  gateways: GatewayList;
  activation?: GatewayActivation;
  setup?: SetupCheck;
}

/**
 * Decides the first screen on launch. The last saved Gateway used wins; with none, the local one
 * when it runs. SuperTag set up here with its services stopped starts them first (`starting`
 * hears it begin and end). With no Gateway at all and no SuperTag set up here, it is the setup
 * screen. `gateways` hears each list as it arrives. Rejects with what failed.
 */
export async function startup(
  api: StartupApi,
  hooks: { gateways(list: GatewayList): void; starting(on: boolean): void; live(): boolean },
): Promise<Startup> {
  let saved = await api.list();
  if (!hooks.live()) return { gateways: saved };
  hooks.gateways(saved);
  if (!saved.active && !saved.local?.origin && (await api.localStartNeeded())) {
    hooks.starting(true);
    try {
      await api.startLocal();
    } finally {
      if (hooks.live()) hooks.starting(false);
    }
    saved = await api.list();
    if (!hooks.live()) return { gateways: saved };
    hooks.gateways(saved);
  }
  const activation = saved.active
    ? await api.select(saved.active)
    : saved.local?.origin
      ? await api.connectLocal()
      : undefined;
  if (activation) return { gateways: saved, activation };
  if (saved.profiles.length > 0 || !hooks.live()) return { gateways: saved };
  const check = await api.check();
  return check.state?.configured ? { gateways: saved } : { gateways: saved, setup: check };
}
