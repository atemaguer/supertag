import type { Platform } from "@supertag/client/react";

/** The window as the shared hooks see it: in view while the document is not hidden. */
export const windowPlatform: Platform = {
  visible: () => !document.hidden,
  onVisibilityChange(changed) {
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  },
};
