import type { Tag, TagAdmin, TagAppearance } from "@supertag/client/model";
import { describe } from "@supertag/client/model";
import { Ban } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ACCESSORIES,
  type Accessory,
  CHOICES,
  COLORS,
  conflicted,
  conflictWith,
  defaultAppearance,
  drawable,
  EXPRESSIONS,
  HEADS,
  label,
  PRESETS,
  randomAppearance,
  sameAppearance,
  withHead,
} from "../avatars/felt";
import { Portrait, portraitDescription } from "./tag-avatar";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * Changing Tags' portraits over one connection, which only a principal that may manage Tags has.
 * `onTagChanged` receives the Tag as a save or a reload left it, for every view that shows it.
 */
export interface AvatarEditing {
  admin: Pick<TagAdmin, "setAppearance" | "tag">;
  onTagChanged(tag: Tag): void;
}

const TABS = [
  { id: "shape", label: "Shape" },
  { id: "color", label: "Color" },
  { id: "expression", label: "Expression" },
  { id: "accessories", label: "Accessories" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const ACCESSORY_GROUPS: Record<Accessory, { title: string; none: string }> = {
  hat: { title: "Hats", none: "No hat" },
  glasses: { title: "Glasses", none: "No glasses" },
  headphones: { title: "Headphones", none: "No headphones" },
};

/** The editor for a Tag's portrait, in a dialog. Closing it any way but saving drops the draft. */
export function AvatarEditorDialog({
  tag,
  editing,
  open,
  onOpenChange,
  opener,
}: {
  tag: Tag;
  editing: AvatarEditing;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** What focus returns to once the dialog closes, saved or not. */
  opener?: RefObject<HTMLElement | null>;
}) {
  const name = tag.name ?? tag.tagId;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="workspace-dialog avatar-dialog"
        onCloseAutoFocus={(event) => {
          if (!opener?.current?.isConnected) return;
          event.preventDefault();
          opener.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit avatar</DialogTitle>
          <DialogDescription>
            Everyone who can see {name} sees this portrait. Its name, permissions, and work stay as
            they are.
          </DialogDescription>
        </DialogHeader>
        {open && <AvatarEditor tag={tag} editing={editing} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

type Phase =
  | { kind: "editing" }
  | { kind: "saving" }
  | { kind: "failed"; message: string }
  | { kind: "conflict"; latest: Tag };

export function AvatarEditor({
  tag,
  editing,
  onDone,
}: {
  tag: Tag;
  editing: AvatarEditing;
  onDone(): void;
}) {
  const name = tag.name ?? tag.tagId;
  const tagId = tag.tagId;
  /** The saved portrait the draft started from, and the revision a save names. */
  const [base, setBase] = useState(() => ({
    appearance: tag.appearance,
    revision: tag.appearanceRevision ?? 0,
  }));
  const shown = base.appearance ?? defaultAppearance(tagId);
  const [draft, setDraft] = useState<TagAppearance>(shown);
  const [tab, setTab] = useState<TabId>("shape");
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const pending = useRef(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const unknown = !drawable(shown);
  const changed = !sameAppearance(draft, shown);
  const saving = phase.kind === "saving";
  const canSave = changed && !unknown && !conflicted(draft) && phase.kind !== "conflict" && !saving;

  function finish(saved: Tag) {
    editing.onTagChanged(saved);
    onDone();
  }

  function stale(latest: Tag) {
    editing.onTagChanged(latest);
    setPhase({ kind: "conflict", latest });
  }

  async function write() {
    const result = await editing.admin.setAppearance(tagId, draft, base.revision);
    if (!live.current) return;
    if ("saved" in result) finish(result.saved);
    else stale(result.conflict);
  }

  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setPhase({ kind: "saving" });
    try {
      await work();
    } catch (error) {
      if (live.current) setPhase({ kind: "failed", message: describe(error) });
    } finally {
      pending.current = false;
    }
  }

  const save = () => {
    if (canSave) void run(write);
  };

  /** A save that got no answer may have been saved: read the Tag before writing again. */
  const retry = () =>
    void run(async () => {
      const current = await editing.admin.tag(tagId);
      if (!live.current) return;
      const revision = current.appearanceRevision ?? 0;
      if (revision === base.revision) await write();
      else if (sameAppearance(current.appearance, draft)) finish(current);
      else stale(current);
    });

  function loadLatest(latest: Tag) {
    const appearance = latest.appearance;
    setBase({ appearance, revision: latest.appearanceRevision ?? 0 });
    setDraft(appearance ?? defaultAppearance(tagId));
    setPhase({ kind: "editing" });
  }

  function randomize() {
    let next = randomAppearance();
    for (let tries = 0; tries < 8 && sameAppearance(next, draft); tries++) {
      next = randomAppearance();
    }
    setDraft(next);
  }

  const update = (next: TagAppearance) => {
    if (phase.kind === "failed") setPhase({ kind: "editing" });
    setDraft(next);
  };

  return (
    <form
      className="avatar-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="avatar-editor-body">
        <div className="avatar-previews">
          <Portrait
            appearance={draft}
            fallback={name}
            className="avatar-preview"
            label={`Avatar preview: ${portraitDescription(draft)}`}
          />
          <div className="avatar-row-preview" aria-hidden>
            <Portrait appearance={draft} fallback={name} className="avatar-preview-row" />
            <span className="avatar-row-name">{name}</span>
            <Portrait appearance={draft} fallback={name} className="avatar-preview-small" />
          </div>
        </div>
        {unknown ? (
          <p className="avatar-unknown" role="status">
            {name}'s avatar comes from the {shown.catalog} art catalog, which this version of the
            app doesn't have. Update the app to edit it; it stays as it is until then.
          </p>
        ) : (
          <fieldset className="avatar-choices" disabled={saving}>
            <legend className="visually-hidden">Avatar features</legend>
            <ChoiceGroup label="Presets" className="avatar-presets">
              {PRESETS.map((preset) => (
                <Choice
                  key={preset.id}
                  name={label(preset.id)}
                  selected={sameAppearance(draft, preset.appearance)}
                  appearance={preset.appearance}
                  onSelect={() => update(preset.appearance)}
                />
              ))}
            </ChoiceGroup>
            <Tabs tab={tab} onTab={setTab} />
            <div
              id={`avatar-panel-${tab}`}
              role="tabpanel"
              aria-labelledby={`avatar-tab-${tab}`}
              className="avatar-panel"
            >
              {tab === "shape" && (
                <ChoiceGroup label="Shape">
                  {HEADS.map((head) => (
                    <Choice
                      key={head}
                      name={label(head)}
                      selected={draft.head === head}
                      appearance={withHead(draft, head)}
                      onSelect={() => update(withHead(draft, head))}
                    />
                  ))}
                </ChoiceGroup>
              )}
              {tab === "color" && (
                <ChoiceGroup label="Color">
                  {COLORS.map((color) => (
                    <Choice
                      key={color}
                      name={label(color)}
                      selected={draft.color === color}
                      appearance={{ ...draft, color }}
                      onSelect={() => update({ ...draft, color })}
                    />
                  ))}
                </ChoiceGroup>
              )}
              {tab === "expression" && (
                <ChoiceGroup label="Expression">
                  {EXPRESSIONS.map((expression) => (
                    <Choice
                      key={expression}
                      name={label(expression)}
                      selected={draft.expression === expression}
                      appearance={{ ...draft, expression }}
                      onSelect={() => update({ ...draft, expression })}
                    />
                  ))}
                </ChoiceGroup>
              )}
              {tab === "accessories" &&
                ACCESSORIES.map((kind) => (
                  <AccessoryGroup key={kind} kind={kind} draft={draft} onChange={update} />
                ))}
            </div>
          </fieldset>
        )}
      </div>
      {phase.kind === "failed" && (
        <div className="avatar-status" role="alert">
          <p className="field-error">
            The avatar wasn't saved: {phase.message} Your changes are still here.
          </p>
          <Button type="button" variant="outline" className="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      {phase.kind === "conflict" && (
        <div className="avatar-status" role="alert">
          <p className="field-error">
            Someone saved another avatar for {name} while you were editing. Load it before saving
            again.
          </p>
          <Button
            type="button"
            variant="outline"
            className="secondary"
            onClick={() => loadLatest(phase.latest)}
          >
            Load the latest avatar
          </Button>
        </div>
      )}
      <DialogFooter className="dialog-actions avatar-actions">
        {!unknown && (
          <Button
            type="button"
            variant="outline"
            className="secondary avatar-randomize"
            disabled={saving}
            onClick={randomize}
          >
            Randomize
          </Button>
        )}
        <DialogClose asChild>
          <Button type="button" variant="outline" className="secondary">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" className="primary" disabled={!canSave}>
          {saving ? "Saving…" : "Save avatar"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The four feature tabs; Left and Right move between them. */
function Tabs({ tab, onTab }: { tab: TabId; onTab(tab: TabId): void }) {
  const list = useRef<HTMLDivElement>(null);
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const index = TABS.findIndex(({ id }) => id === tab);
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? TABS.length - 1
          : step
            ? (index + step + TABS.length) % TABS.length
            : -1;
    const next = TABS[target];
    if (!next) return;
    event.preventDefault();
    onTab(next.id);
    list.current?.querySelector<HTMLElement>(`#avatar-tab-${next.id}`)?.focus();
  }
  return (
    <div
      ref={list}
      className="avatar-tabs"
      role="tablist"
      aria-label="Avatar features"
      onKeyDown={move}
    >
      {TABS.map(({ id, label: text }) => (
        <button
          key={id}
          id={`avatar-tab-${id}`}
          type="button"
          role="tab"
          aria-selected={tab === id}
          aria-controls={`avatar-panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          className="avatar-tab"
          onClick={() => onTab(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function ChoiceGroup({
  label: text,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className={`avatar-group${className ? ` ${className}` : ""}`}>
      <legend className="avatar-group-label">{text}</legend>
      <div className="avatar-options">{children}</div>
    </fieldset>
  );
}

/** One choice: a thumbnail of the draft with it, and its name. */
function Choice({
  name,
  selected,
  appearance,
  unavailable,
  describedBy,
  onSelect,
}: {
  name: string;
  selected: boolean;
  /** The draft as it would look with this choice; none for a None choice. */
  appearance?: TagAppearance;
  unavailable?: boolean;
  describedBy?: string;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      className="avatar-option"
      aria-pressed={selected}
      aria-disabled={unavailable || undefined}
      aria-describedby={describedBy}
      onClick={() => {
        if (!unavailable) onSelect();
      }}
    >
      {appearance ? (
        <Portrait appearance={appearance} fallback={name} className="avatar-option-image" />
      ) : (
        <span className="avatar-option-none" aria-hidden>
          <Ban size={22} />
        </span>
      )}
      <span className="avatar-option-label">{name}</span>
    </button>
  );
}

/**
 * The choices of one accessory, None first. A piece that can't be worn with one already chosen
 * says why beside it and offers to swap one for the other.
 */
function AccessoryGroup({
  kind,
  draft,
  onChange,
}: {
  kind: Accessory;
  draft: TagAppearance;
  onChange(next: TagAppearance): void;
}) {
  const conflicts = CHOICES[kind]
    .map((id) => ({ id, with: conflictWith(draft, kind, id) }))
    .filter((entry) => entry.with !== undefined && draft[kind] !== entry.id);
  return (
    <div className="avatar-accessory">
      <ChoiceGroup label={ACCESSORY_GROUPS[kind].title}>
        <Choice
          name={ACCESSORY_GROUPS[kind].none}
          selected={draft[kind] === null}
          onSelect={() => onChange({ ...draft, [kind]: null })}
        />
        {CHOICES[kind].map((id) => {
          const blocked = conflictWith(draft, kind, id);
          return (
            <Choice
              key={id}
              name={label(id)}
              selected={draft[kind] === id}
              appearance={{ ...draft, ...(blocked && { [blocked.kind]: null }), [kind]: id }}
              unavailable={blocked !== undefined && draft[kind] !== id}
              describedBy={blocked ? `avatar-conflict-${id}` : undefined}
              onSelect={() => onChange({ ...draft, [kind]: id })}
            />
          );
        })}
      </ChoiceGroup>
      {conflicts.map(({ id, with: other }) =>
        other ? (
          <p key={id} id={`avatar-conflict-${id}`} className="avatar-conflict">
            {label(id)} can't be worn with the {label(other.id).toLowerCase()}: both sit on the
            crown.{" "}
            <button
              type="button"
              className="avatar-swap"
              onClick={() => onChange({ ...draft, [other.kind]: null, [kind]: id })}
            >
              Remove the {label(other.id).toLowerCase()} and wear {label(id).toLowerCase()}
            </button>
          </p>
        ) : null,
      )}
    </div>
  );
}
