import { expect, it } from "vitest";
import packageJson from "../../package.json";
import { APP_VERSION, releaseDiffers } from "./version";

it("names the app's release from its package", () => {
  expect(APP_VERSION).toBe(packageJson.version);
});

it("says when the connected Gateway runs another release", () => {
  expect(releaseDiffers("0.3.4", { build: "0.3.4", protocol: 7 })).toBe(false);
  expect(releaseDiffers("0.3.4", { build: "0.3.3", protocol: 7 })).toBe(true);
  // Disconnected, there is nothing to differ from.
  expect(releaseDiffers("0.3.4")).toBe(false);
});
