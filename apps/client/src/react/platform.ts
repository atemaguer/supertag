/**
 * What the hooks need from the front end they run in, passed in rather than read from `window`
 * or `document`: whether it is in view. The desktop window is in view while it is not hidden; a
 * front end that never provides one counts as always in view.
 */
import { createContext, useContext } from "react";

export interface Platform {
  /** Whether the front end shows now. A hidden one reads only what it must. */
  visible(): boolean;
  /** Calls `changed` whenever `visible()` may have changed, until the returned stop. */
  onVisibilityChange(changed: () => void): () => void;
}

export const alwaysVisible: Platform = {
  visible: () => true,
  onVisibilityChange: () => () => {},
};

const PlatformContext = createContext<Platform>(alwaysVisible);

/** Gives the hooks beneath it this front end's `Platform`. */
export const PlatformProvider = PlatformContext.Provider;

export function usePlatform(): Platform {
  return useContext(PlatformContext);
}
