import type { TagAppearance } from "@supertag/client/model";
import { expect, it } from "vitest";
import {
  appearanceKey,
  conflicted,
  conflictWith,
  defaultAppearance,
  describeAppearance,
  drawable,
  layers,
  PRESETS,
  randomAppearance,
  withHead,
} from "./felt";

const patch: TagAppearance = {
  version: 1,
  catalog: "felt-v1",
  head: "pear",
  color: "moss",
  expression: "cheerful",
  hat: "plum-beanie",
  glasses: "round-charcoal",
  headphones: null,
};

it("draws a recipe's layers back to front, each a bundled asset", () => {
  const urls = layers(patch) ?? [];
  // Head, face, hat, glasses: no headphones band or pads.
  expect(urls).toHaveLength(4);
  expect(urls[0]).toMatch(/moss/);
  expect(urls[1]).toMatch(/cheerful/);
  expect(urls[2]).toMatch(/plum-beanie/);
  expect(urls[3]).toMatch(/round-charcoal/);
  const listener = layers({ ...patch, hat: null, headphones: "navy-over-ear" }) ?? [];
  // The band goes behind the head and the pads over the face and glasses.
  expect(listener[0]).toMatch(/headband/);
  expect(listener.at(-1)).toMatch(/ear-pads/);
});

it("can't draw another catalog, schema version, or unknown piece", () => {
  expect(drawable({ ...patch, catalog: "felt-v9" })).toBe(false);
  expect(drawable({ ...patch, version: 2 })).toBe(false);
  expect(drawable({ ...patch, head: "square" })).toBe(false);
  expect(drawable({ ...patch, glasses: "tortoise" })).toBe(false);
  expect(drawable(patch)).toBe(true);
});

it("derives the same valid default from the same Tag ID, and varies across IDs", () => {
  const ids = ["lead", "patch", "reviewer", "finch", "moss", "kite", "docs", "ci", "triage"];
  for (const id of ids) {
    const look = defaultAppearance(id);
    expect(appearanceKey(defaultAppearance(id))).toBe(appearanceKey(look));
    expect(drawable(look)).toBe(true);
    expect(conflicted(look)).toBe(false);
  }
  expect(new Set(ids.map((id) => appearanceKey(defaultAppearance(id)))).size).toBeGreaterThan(4);
});

it("randomizes only to looks the catalog allows", () => {
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 200; i++) {
    const look = randomAppearance(random);
    expect(drawable(look)).toBe(true);
    expect(conflicted(look)).toBe(false);
  }
});

it("names the piece a choice conflicts with, both ways", () => {
  expect(conflictWith(patch, "headphones", "navy-over-ear")).toEqual({
    kind: "hat",
    id: "plum-beanie",
  });
  const listener = { ...patch, hat: null, headphones: "navy-over-ear" };
  expect(conflictWith(listener, "hat", "plum-beanie")).toEqual({
    kind: "headphones",
    id: "navy-over-ear",
  });
  expect(conflictWith(listener, "glasses", "round-charcoal")).toBeUndefined();
  expect(conflicted({ ...patch, headphones: "navy-over-ear" })).toBe(true);
});

it("keeps every choice the other head offers", () => {
  expect(withHead(patch, "bean")).toEqual({ ...patch, head: "bean" });
});

it("offers presets as ordinary editable recipes", () => {
  expect(PRESETS.map(({ id }) => id)).toEqual(["moss-reader", "ocean-listener"]);
  for (const { appearance } of PRESETS) {
    expect(drawable(appearance)).toBe(true);
    expect(conflicted(appearance)).toBe(false);
  }
});

it("describes a portrait in words", () => {
  expect(describeAppearance(patch)).toBe(
    "Pear, moss green, cheerful, with a plum beanie and round glasses",
  );
  expect(describeAppearance({ ...patch, hat: null, glasses: null })).toBe(
    "Pear, moss green, cheerful",
  );
});
