import type { ComponentProps } from "react";
import { desktop, inDesktopApp } from "../desktop";

/** The host of a web link, or nothing for any other kind of link. */
export function webHost(href: string | undefined): string | undefined {
  try {
    const url = new URL(href ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : undefined;
  } catch {
    return undefined;
  }
}

/** Opens a web link in the system browser, never in the app's own window. */
export function openExternal(href: string) {
  if (inDesktopApp())
    void desktop()
      .openExternal({ url: href })
      .catch(() => {});
  else window.open(href, "_blank", "noopener,noreferrer");
}

/**
 * A link in a Tag's message. A web link names its host on hover and opens in the system browser;
 * any other link shows as text.
 */
export function ExternalLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  const host = webHost(href);
  if (!href || !host) return <span>{children}</span>;
  return (
    <a
      {...props}
      href={href}
      title={host}
      className="message-link"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
