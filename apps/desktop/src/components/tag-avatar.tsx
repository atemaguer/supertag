import type { Tag } from "@supertag/client/model";
import { Pin } from "lucide-react";

/** The tile colours a Tag can have; `style.css` gives each its fill and the ink of its letters. */
const colors = ["peach", "mint", "lilac", "blue", "yellow"] as const;

/** A Tag's colour, fixed by its ID, so it is the same in every window and after every restart. */
export function tagColor(tagId: string): (typeof colors)[number] {
  let hash = 0;
  for (const letter of tagId) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length] ?? "peach";
}

/**
 * A Tag's two letters: the initials of its first two words, or the first two letters of a
 * one-word name. `release-notes` is RN, `finch` is FI.
 */
export function monogram(name: string): string {
  const [first = "", second] = name
    .trim()
    .split(/[\s_-]+/u)
    .filter(Boolean);
  const letters = second ? [[...first][0], [...second][0]] : [...first].slice(0, 2);
  return letters.join("").toLocaleUpperCase();
}

/**
 * The one avatar a Tag has everywhere: a rounded-square tile in the Tag's colour with its
 * monogram, and a pin badge on the lead Tag. `size` is the tile's: `sm` beside a name in a line of
 * text, `md` in a list row, `lg` at the head of a panel, `xl` alone on an empty page.
 */
export function TagAvatar({
  tag,
  size = "md",
}: {
  tag: Pick<Tag, "tagId" | "name" | "lead">;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  return (
    <span className="avatar" data-color={tagColor(tag.tagId)} data-size={size} aria-hidden>
      <span className="avatar-monogram">{monogram(tag.name ?? tag.tagId) || "?"}</span>
      {tag.lead && (
        <span className="avatar-pin">
          <Pin />
        </span>
      )}
    </span>
  );
}
