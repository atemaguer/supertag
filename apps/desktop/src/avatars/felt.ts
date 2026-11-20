/**
 * The felt mascot portraits a Tag can wear: the bundled `felt-v1` art catalog, the recipes it
 * draws, and the rules the editor follows. A recipe names one component of each kind; every
 * layer is a 512 × 512 transparent PNG drawn at the origin, back to front. The Control Plane
 * checks the same IDs when a portrait is saved.
 */
import type { TagAppearance } from "@supertag/client/model";
import catalog from "./felt-v1/catalog.json";

export const FELT = "felt-v1";
const VERSION = 1;

/** Every layer's URL in the built app, by its path in the catalog. */
const files = import.meta.glob<string>("./felt-v1/*/*.png", {
  eager: true,
  import: "default",
});

type Layers = Record<string, Record<string, string>>;
const shapes = catalog.shapes as Record<string, Layers>;

export type Accessory = "hat" | "glasses" | "headphones";
export const ACCESSORIES: readonly Accessory[] = ["hat", "glasses", "headphones"];

/** The drawing slots, back to front, and the recipe key that selects each one's layer. */
const ORDER: readonly { slot: string; key: keyof TagAppearance }[] = catalog.order.map((slot) => ({
  slot,
  key: (
    {
      headphonesBack: "headphones",
      head: "color",
      expression: "expression",
      hat: "hat",
      glasses: "glasses",
      headphonesFront: "headphones",
    } as Record<string, keyof TagAppearance>
  )[slot] as keyof TagAppearance,
}));

/** What each choice is called where a person picks it or a screen reader names it. */
const LABELS: Record<string, string> = {
  pear: "Pear",
  bean: "Wide bean",
  moss: "Moss green",
  coral: "Coral red",
  ocean: "Ocean blue",
  cheerful: "Cheerful",
  curious: "Curious",
  sleepy: "Sleepy",
  "plum-beanie": "Plum beanie",
  "round-charcoal": "Round glasses",
  "navy-over-ear": "Navy headphones",
  "moss-reader": "Moss reader",
  "ocean-listener": "Ocean listener",
};

export function label(id: string): string {
  return LABELS[id] ?? id;
}

const first = (layers: Record<string, string> | undefined) => Object.keys(layers ?? {});

export const HEADS: readonly string[] = Object.keys(shapes);
/** The choices of each kind, as every head offers them. */
export const COLORS: readonly string[] = first(shapes[HEADS[0] ?? ""]?.["head"]);
export const EXPRESSIONS: readonly string[] = first(shapes[HEADS[0] ?? ""]?.["expression"]);
export const CHOICES: Record<Accessory, readonly string[]> = {
  hat: first(shapes[HEADS[0] ?? ""]?.["hat"]),
  glasses: first(shapes[HEADS[0] ?? ""]?.["glasses"]),
  headphones: first(shapes[HEADS[0] ?? ""]?.["headphonesFront"]),
};

/** The editable starting points the catalog offers. */
export const PRESETS: readonly { id: string; appearance: TagAppearance }[] = catalog.presets.map(
  ({ id, head, color, expression, hat, glasses, headphones }) => ({
    id,
    appearance: {
      version: VERSION,
      catalog: FELT,
      head,
      color,
      expression,
      hat,
      glasses,
      headphones,
    },
  }),
);

/** A recipe this app can draw: its schema, its catalog, and every ID in it. */
export function drawable(appearance: TagAppearance): boolean {
  return layers(appearance) !== undefined;
}

/** The URLs of a recipe's layers, back to front, or nothing when this app can't draw it. */
export function layers(appearance: TagAppearance): string[] | undefined {
  if (appearance.version !== VERSION || appearance.catalog !== FELT) return undefined;
  const shape = shapes[appearance.head];
  if (!shape) return undefined;
  const urls: string[] = [];
  for (const { slot, key } of ORDER) {
    const id = appearance[key];
    const required = key === "color" || key === "expression";
    if (id === null || id === "") {
      if (required) return undefined;
      continue;
    }
    const path = shape[slot]?.[String(id)];
    const url = path === undefined ? undefined : files[`./felt-v1/${path}`];
    if (url === undefined) return undefined;
    urls.push(url);
  }
  return urls;
}

/** Pairs of accessories the catalog says can't be worn together, as `[kind, id]` pairs. */
const INCOMPATIBLE: readonly [Accessory, string, Accessory, string][] = catalog.incompatible.map(
  ({ hat, headphones }) => ["hat", hat, "headphones", headphones],
);

/** The piece already in the recipe that `id` for `kind` can't be worn with, if any. */
export function conflictWith(
  appearance: TagAppearance,
  kind: Accessory,
  id: string,
): { kind: Accessory; id: string } | undefined {
  for (const [a, x, b, y] of INCOMPATIBLE) {
    if (a === kind && x === id && appearance[b] === y) return { kind: b, id: y };
    if (b === kind && y === id && appearance[a] === x) return { kind: a, id: x };
  }
  return undefined;
}

/** Whether the recipe wears two pieces that can't go together. */
export function conflicted(appearance: TagAppearance): boolean {
  return ACCESSORIES.some((kind) => {
    const id = appearance[kind];
    return id !== null && conflictWith(appearance, kind, id) !== undefined;
  });
}

/** The recipe on another head, keeping each choice that head offers. */
export function withHead(appearance: TagAppearance, head: string): TagAppearance {
  const shape = shapes[head];
  if (!shape) return appearance;
  const keep = (slot: string, id: string | null) =>
    id !== null && shape[slot]?.[id] !== undefined ? id : null;
  return {
    ...appearance,
    head,
    color: keep("head", appearance.color) ?? first(shape["head"])[0] ?? appearance.color,
    expression:
      keep("expression", appearance.expression) ??
      first(shape["expression"])[0] ??
      appearance.expression,
    hat: keep("hat", appearance.hat),
    glasses: keep("glasses", appearance.glasses),
    headphones: keep("headphonesFront", appearance.headphones),
  };
}

/** A 32-bit FNV-1a hash, so the same Tag ID always draws the same default. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Every combination of accessories the catalog allows, without any first. */
function outfits(): Pick<TagAppearance, Accessory>[] {
  const found: Pick<TagAppearance, Accessory>[] = [];
  for (const hat of [null, ...CHOICES.hat])
    for (const glasses of [null, ...CHOICES.glasses])
      for (const headphones of [null, ...CHOICES.headphones]) {
        const outfit = { hat, glasses, headphones };
        if (!conflicted({ ...PRESETS[0]?.appearance, ...outfit } as TagAppearance))
          found.push(outfit);
      }
  return found;
}
const OUTFITS = outfits();

function pick<T>(list: readonly T[], value: number): T {
  return list[value % list.length] as T;
}

/** The portrait a Tag nobody gave one wears: derived from its permanent ID, never stored. */
export function defaultAppearance(tagId: string): TagAppearance {
  const value = hash(tagId);
  return {
    version: VERSION,
    catalog: FELT,
    head: pick(HEADS, value),
    color: pick(COLORS, value >>> 3),
    expression: pick(EXPRESSIONS, value >>> 7),
    ...pick(OUTFITS, value >>> 11),
  };
}

/** A random portrait the catalog allows, to edit from. */
export function randomAppearance(random: () => number = Math.random): TagAppearance {
  const index = (length: number) => Math.floor(random() * length);
  return {
    version: VERSION,
    catalog: FELT,
    head: HEADS[index(HEADS.length)] ?? "pear",
    color: COLORS[index(COLORS.length)] ?? "moss",
    expression: EXPRESSIONS[index(EXPRESSIONS.length)] ?? "cheerful",
    ...(OUTFITS[index(OUTFITS.length)] ?? { hat: null, glasses: null, headphones: null }),
  };
}

/** One string per recipe, for caching what it draws and comparing two. */
export function appearanceKey(appearance: TagAppearance): string {
  const { version, catalog, head, color, expression, hat, glasses, headphones } = appearance;
  return JSON.stringify([version, catalog, head, color, expression, hat, glasses, headphones]);
}

export function sameAppearance(a: TagAppearance | undefined, b: TagAppearance | undefined) {
  return a === b || (a !== undefined && b !== undefined && appearanceKey(a) === appearanceKey(b));
}

/** The portrait in words: "Pear, moss green, curious, with a plum beanie and round glasses". */
export function describeAppearance(appearance: TagAppearance): string {
  // Glasses and headphones are plural nouns; a hat takes an article.
  const worn = ACCESSORIES.flatMap((kind) => {
    const id = appearance[kind];
    if (id === null) return [];
    const name = label(id).toLowerCase();
    return [kind === "hat" ? `a ${name}` : name];
  });
  const wearing =
    worn.length === 0
      ? ""
      : `, with ${worn.length === 1 ? worn[0] : `${worn.slice(0, -1).join(", ")} and ${worn.at(-1)}`}`;
  return `${label(appearance.head)}, ${label(appearance.color).toLowerCase()}, ${label(appearance.expression).toLowerCase()}${wearing}`;
}
