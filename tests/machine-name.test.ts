import { hostname } from "node:os";
import { expect, it } from "vitest";
import { machineName } from "../apps/cli/src/machine-name.js";

it("prefers the macOS LocalHostName over a network-assigned hostname", () => {
  expect(machineName("darwin", () => "Dana-MacBook-Pro\n")).toBe("Dana-MacBook-Pro");
  expect(machineName("darwin", () => undefined)).toBe(hostname());
  expect(machineName("linux", () => "ignored")).toBe(hostname());
});
