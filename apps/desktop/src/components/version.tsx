import type { GatewayRelease } from "@supertag/client/model";
import { version } from "../../package.json";

/** This app's SuperTag release, from its package, as Electron's `app.getVersion()` reads it. */
export const APP_VERSION: string = version;

/**
 * What the sidebar says of the releases: this app's, and the Gateway's when it runs another one.
 * `label` is the expanded sidebar's line, `short` the rail's, and `detail` names both releases
 * and the protocol version for the tooltip.
 */
export function versionText(app: string, gateway?: GatewayRelease) {
  const differs = gateway !== undefined && gateway.build !== app;
  const detail = [`SuperTag ${app}`];
  if (gateway) {
    detail.push(`Gateway ${gateway.build}`);
    if (gateway.protocol > 0) detail.push(`Protocol ${gateway.protocol}`);
  } else detail.push("Not connected to a Gateway");
  return {
    label: differs ? `SuperTag ${app} · Gateway ${gateway.build}` : `SuperTag ${app}`,
    short: differs ? [app, gateway.build] : [app],
    detail: detail.join("\n"),
  };
}

/** Small, muted release text at the foot of the sidebar. */
export function VersionLabel({
  app = APP_VERSION,
  gateway,
  wide,
}: {
  app?: string;
  /** The connected Gateway's release; none while disconnected. */
  gateway?: GatewayRelease;
  wide: boolean;
}) {
  const text = versionText(app, gateway);
  return (
    <p className="sidebar-version" data-wide={wide} title={text.detail}>
      <span aria-hidden>
        {wide ? text.label : text.short.map((line) => <span key={line}>{line}</span>)}
      </span>
      <span className="visually-hidden">{text.detail.replaceAll("\n", ", ")}</span>
    </p>
  );
}
