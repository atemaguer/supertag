import type { Tag, TagAppearance } from "@supertag/client/model";
import { useEffect, useState } from "react";
import {
  appearanceKey,
  defaultAppearance,
  describeAppearance,
  drawable,
  layers,
} from "../avatars/felt";

/**
 * The portrait a Tag wears: its saved recipe, or the default its permanent ID derives. A recipe
 * from an art catalog this app doesn't bundle draws a plain fallback with the Tag's initial.
 */
export function tagPortrait(tag: Pick<Tag, "tagId" | "appearance">): TagAppearance {
  return tag.appearance ?? defaultAppearance(tag.tagId);
}

/** Each recipe's layers, so a render reads them once. */
const layered = new Map<string, string[] | undefined>();

function layersOf(key: string, appearance: TagAppearance): string[] | undefined {
  if (!layered.has(key)) layered.set(key, layers(appearance));
  return layered.get(key);
}

/** Composed portraits by recipe, so every row showing the same look reuses one image. */
const composed = new Map<string, Promise<string | undefined>>();
const ready = new Map<string, string>();

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

/** Draws a recipe's layers into one image once, or nothing where the window can't draw. */
function compose(key: string, urls: readonly string[]): Promise<string | undefined> {
  let pending = composed.get(key);
  if (!pending) {
    pending = (async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 512;
      const context = canvas.getContext?.("2d");
      if (!context) return undefined;
      try {
        for (const image of await Promise.all(urls.map(load))) context.drawImage(image, 0, 0);
        const url = canvas.toDataURL("image/png");
        ready.set(key, url);
        return url;
      } catch {
        return undefined;
      }
    })();
    composed.set(key, pending);
  }
  return pending;
}

/** The composed image of a recipe once it is drawn; until then its layers are stacked. */
function useComposed(key: string, urls: readonly string[] | undefined): string | undefined {
  const [url, setUrl] = useState(() => ready.get(key));
  useEffect(() => {
    if (!urls) return;
    const done = ready.get(key);
    if (done) {
      setUrl(done);
      return;
    }
    let live = true;
    void compose(key, urls).then((composedUrl) => {
      if (live && composedUrl) setUrl(composedUrl);
    });
    return () => {
      live = false;
    };
  }, [key, urls]);
  return urls ? (url ?? ready.get(key)) : undefined;
}

/**
 * A portrait drawn from a recipe at any size. With `label` it is an image of that name;
 * otherwise it is decorative and hidden from assistive technology, because the Tag's name beside
 * it already says who it is.
 */
export function Portrait({
  appearance,
  fallback,
  label,
  className,
}: {
  appearance: TagAppearance;
  /** The letter drawn when the recipe's art isn't bundled. */
  fallback: string;
  label?: string;
  className?: string;
}) {
  const key = appearanceKey(appearance);
  const urls = layersOf(key, appearance);
  const image = useComposed(key, urls);
  const known = urls !== undefined;
  return (
    <span
      className={`avatar portrait${className ? ` ${className}` : ""}`}
      data-color={known ? appearance.color : undefined}
      data-unknown={known ? undefined : true}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {!known ? (
        <span className="portrait-fallback">{fallback.slice(0, 1).toUpperCase()}</span>
      ) : image ? (
        <img className="portrait-layer" src={image} alt="" draggable={false} />
      ) : (
        urls.map((url) => (
          <img key={url} className="portrait-layer" src={url} alt="" draggable={false} />
        ))
      )}
    </span>
  );
}

/** A Tag's portrait where its name shows beside it, as in the sidebar and the pickers. */
export function TagAvatar({
  tag,
  large,
  label,
}: {
  tag: Pick<Tag, "tagId" | "name" | "appearance">;
  large?: boolean;
  /** Names the portrait for a screen reader, where no name is beside it. */
  label?: string;
}) {
  return (
    <Portrait
      appearance={tagPortrait(tag)}
      fallback={tag.name ?? tag.tagId}
      label={label}
      className={large ? "large" : undefined}
    />
  );
}

/** What a portrait shows, in words, or why this app can't draw it. */
export function portraitDescription(appearance: TagAppearance): string {
  return drawable(appearance)
    ? describeAppearance(appearance)
    : `an avatar from the ${appearance.catalog} art catalog, which this app doesn't have`;
}
