# Desktop app design

The decisions the desktop window follows. Change the window and this page together, and look at
`pnpm --filter @supertag/desktop shots` before and after (see [README](README.md#look-at-a-change)).

The tone is serious, not playful. Personality comes from the type and from disciplined colour:
one accent, one tile colour per Tag. No decoration, and no motion beyond the typing dots and the
existing transitions, all of which stop under `prefers-reduced-motion`.

## Tokens

Every value below is a custom property on `:root` in `src/style.css`. Use them; do not add a
one-off size, colour or radius where a token fits.

| Group | Tokens |
| --- | --- |
| Text | `--text` what you read · `--text-2` supporting text and values · `--muted` labels, previews, state · `--faint` times and the release |
| Colour | `--accent` needs you, unread, your messages · `--mint` connected · `--line` hairlines · `--rail`, `--panel`, `--hover`, `--selected`, `--background` surfaces |
| Type | `--display` (Bricolage Grotesque) for headings and Tag names; Geist for everything else |
| Sizes | `--font-2xs` 10 · `--font-xs` 11 · `--font-sm` 12 · `--font-md` 13 · `--font-base` 14 · `--font-lg` 18 · `--font-xl` 20 |
| Weights | `--weight-regular` 450 · `--weight-medium` 550 · `--weight-bold` 650 |
| Spacing | `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 |
| Radii | `--radius-sm` 6 · `--radius-md` 9 · `--radius-lg` 14 · `--radius-pill` |
| Row | `--row-height` 52 · `--row-pad` 8 · `--row-gap` 10 |
| Avatar | `--avatar-sm` 22 · `--avatar-md` 34 · `--avatar-lg` 40 · `--avatar-xl` 56 |
| Header | `--header-height` 48 |

The sidebar, the avatar, the header band and the markdown blocks use the tokens. Older rules
elsewhere in the stylesheet still carry literal values; move them to tokens when you touch them.

## Avatar

A Tag has one avatar, `TagAvatar`, wherever it appears: sidebar rows, the rail, the header pill,
the inspector, the command palette, and an empty conversation.

- A rounded-square tile (radius 28% of its side) filled with the Tag's colour, with its two-letter
  monogram: the initials of the first two words of its name, or the first two letters of one word.
- The colour comes from the Tag's ID (`tagColor`), so it never changes. Each of the five fills has
  its own dark ink for the letters, at a contrast of at least 7:1.
- The lead Tag also carries a small pin badge at the tile's bottom right. Nothing else marks it.
- No grey monograms, no second glyph, no circles.

## Sidebar

From top to bottom: the brand row with search and **+**, the list, the foot.

- The brand row sits below the title bar, clear of the macOS window controls: the round mascot at
  26 px (`src/assets/supertag-mark@2x.png`, a small copy of the brand art, named "SuperTag") and
  the wordmark in the display face, left-aligned, with search and **+** at the right. The list's
  **Tags** heading stays in the page for screen readers and is not drawn.

- One list. The lead Tag is pinned first, with a hairline after it. No heading is drawn over it.
  The other Tags follow, most recently active first.
- Every row is `--row-height` tall and has the same parts: the avatar; the name in the display
  face with one slot right-aligned beside it; then one ellipsised line with the latest message
  and the unread dot at its right. The second line is always the message, or a faint
  `No messages yet`. An unread row's message is brighter.
- The slot beside the name shows the time of the latest message. While the Tag is working or
  needs you, a compact state label takes its place: `Working` in `--text-2`, `Needs you` in the
  accent. One slot, so a row never trades its message for its state.
- The selected row has a soft fill (`--selected`) and `aria-current`. Rows are buttons, named
  with their state ("moss, Working"), and show the focus ring inside their edge.
- The foot holds the Gateway selector as one quiet line: a status dot, the Gateway's name, a
  chevron. The release sits beside it in faint small type, and wraps under it when both do not
  fit. An offered update sits above them. Nothing in the foot is heavier than a Tag row.
- Folded into the rail, a row is its avatar with a status dot, and the foot stacks search, **+**,
  the Gateway button and the release.

## Conversation

- A solid header band (`--header-height`) with a hairline under it holds the Tag's pill: avatar,
  name, and the harness after a divider. The transcript starts below the band, so the pill never
  covers a message. Selecting the pill opens the inspector.
- Under the composer, one muted read-only line says where the Tag's work runs: the Worker Host
  of its latest turn ("This Mac" when it is this machine), its Workspace with the branch it
  follows, and its harness. A part the window does not know is left out. It offers no pickers.
  The keys, "Enter to send · Shift + Enter for a new line", show at the right of that line only
  while the composer is empty and has the cursor, and in the send button's tooltip.
- Code blocks: the copy and download buttons have no frame of their own. A long line scrolls
  sideways and fades at the right edge while more lies to the right.
- Tables: the actions lie over the table's top right corner and show on hover or keyboard focus.
  No empty row above the table.

## Inspector

- Header: the avatar at `--avatar-lg`, the name, and "Lead Tag" or the Tag's ID under it.
- Label and value rows for the harness, Work Sessions and instructions.
- Disclosures for Permissions and Activity. Permissions starts open, because the list is short
  and is what the panel is opened for; Activity loads when opened.

## Keyboard and motion

- Everything pressable shows a `:focus-visible` ring in the accent at 45%; nothing shows an
  outline at rest.
- ⌘1 to ⌘9, ⌘↑ and ⌘↓ move between Tags; Tab reaches each row. Esc closes the inspector.
- New transitions and animations need a reason and a `prefers-reduced-motion` rule.
