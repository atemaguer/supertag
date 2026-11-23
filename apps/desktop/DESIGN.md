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

From top to bottom: the title row, search, the **Tags** heading, the list, the foot.

- The title row is `--header-height` tall, like the conversation's header band, and drags the
  window. On macOS the window controls sit at its left (`electron/window-chrome.ts` places
  them, centred on the row) and the brand follows them: the round mascot at 22 px
  (`src/assets/supertag-mark@2x.png`, named "SuperTag") and the wordmark in the display face.
  The brand is not a button. Without left-hand window controls it starts at the sidebar's edge.
- Search is one quiet row across the sidebar: a magnifier, "Search", and the key, ⌘K or Ctrl+K.
  It opens the command palette; the sidebar has no search of its own.
- The list's heading is a small uppercase label, "Tags", in `--faint`, with **+** (New Tag) at
  its right. It is the real heading of the list.
- In the rail the mascot sits alone under the window controls, and search and **+** are icons
  at the foot.
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
- The foot holds the Gateway selector on the left as one quiet line (a status dot, the Gateway's
  name, a chevron) and the Settings gear on the right, the size and colour of search and **+**.
  The sidebar shows no version. An offered update sits above them. Nothing in the foot is
  heavier than a Tag row.
- A small accent dot on the gear says something in Settings waits: an update, or a Gateway on
  another release than the app.
- Folded into the rail, a row is its avatar with a status dot, and the foot stacks search, **+**,
  the gear and the Gateway button.

## Conversation

- A solid header band (`--header-height`) with a hairline under it holds the Tag's pill: avatar,
  name, and the harness after a divider. The transcript starts below the band, so the pill never
  covers a message. Selecting the pill opens the inspector.
- Under the composer, one muted read-only line says where the Tag's work runs: the Worker Host
  of its latest turn ("This Mac" when it is this machine), its Workspace with the branch it
  follows, and its harness. A part the window does not know is left out. It offers no pickers.
  The keys, "Enter to send · Shift + Enter for a new line", show at the right of that line only
  while the composer is empty and has the cursor, and in the send button's tooltip.
- What a Tag waits on a person for is a **Needs you** card at the end of the conversation, the
  width of a message, with an accent hairline and label. Nothing in it has the focus or is the
  default, and only the first action is filled with the accent.
  - An approval request: the summary, the exact arguments in mono, then the pills **Approve
    once**, **Deny**, **Reply**. Deny asks for a reason in place of the pills before it sends.
    A decided request collapses to one muted line: "Approved once by you · …". The Gateway does
    not say who decided a request elsewhere, so that line names only the outcome.
  - A question: "NAME is waiting for your answer." under the message that asks, and **Reply**.
  - **Reply** puts the cursor in the composer and adds a "Replying to: …" chip over it, which
    its × or Esc dismisses and sending clears. No red: Deny is an outline pill like any other.
- Under a reply whose turn took 30 seconds or more, one faint line, "Worked for 2m 14s ›",
  opens that turn's Task activity. It is a pointer and nothing else: it does not expand, and it
  never shows a tool, a command or any other activity. The conversation shows only messages.
- Code blocks: the copy and download buttons have no frame of their own. A long line scrolls
  sideways and fades at the right edge while more lies to the right.
- Tables: the actions lie over the table's top right corner and show on hover or keyboard focus.
  No empty row above the table.

## Settings

- One modal dialog, the same as New Tag and Keyboard shortcuts, opened by the gear, ⌘, (Ctrl+,
  outside macOS), **Settings…** in the app menu, and the command palette. Esc closes it and the
  focus returns to the gear. On opening, the dialog itself has the focus, not a button.
- It holds only what works, in short sections under small headings:
  - **About**: the app's release, the connected Gateway's name, release and protocol, and a
    warning in the accent when the Gateway runs another release.
  - **Updates**: the updater's state in one line, the same action the banner offers, and
    **Check for updates**. The banner and the sidebar's update button stay as they are.
  - **Notifications**: what this device notifies about. This is its only home in the window;
    the command palette offers the same choices.
  - Links to the documentation and the release notes.
- A setting goes here when it is about the app or this device. What belongs to a Gateway stays in
  the Gateway menu; what belongs to a Tag stays in its inspector.

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
