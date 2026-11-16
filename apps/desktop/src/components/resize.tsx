import { type KeyboardEvent, type PointerEvent, useCallback, useRef, useState } from "react";

/** A width saved under `key`, or `fallback` when none is saved or storage is unavailable. */
export function storedWidth(key: string, fallback: number): number {
  try {
    const saved = Number(localStorage.getItem(key));
    return Number.isFinite(saved) && saved > 0 ? saved : fallback;
  } catch {
    return fallback;
  }
}

/** A pane width that is remembered across restarts. */
export function useStoredWidth(key: string, fallback: number) {
  const [width, setWidth] = useState(() => storedWidth(key, fallback));
  const save = useCallback(
    (next: number) => {
      const rounded = Math.round(next);
      setWidth(rounded);
      try {
        localStorage.setItem(key, String(rounded));
      } catch {
        // Without storage the width lasts until the window closes.
      }
    },
    [key],
  );
  return [width, save] as const;
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** How far ← and → move a separator. */
export const KEY_STEP = 16;

/**
 * A vertical separator that resizes the pane beside it by dragging or with ← and →. `grows` is the
 * direction that widens the pane: 1 when the pane is on the left of the separator, -1 when it is
 * on the right. It reports each width while dragging and the last one on release; the owner
 * clamps or snaps it.
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  grows,
  className,
  onResize,
  onStep,
  onDoubleClick,
  onEnter,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  grows: 1 | -1;
  className?: string;
  onResize(width: number, done: boolean): void;
  /** Handles ← and → itself, given +1 to widen the pane or -1 to narrow it. */
  onStep?(direction: 1 | -1): void;
  onDoubleClick?(): void;
  onEnter?(): void;
}) {
  const drag = useRef<{ x: number; width: number; pointer: number }>(undefined);
  const [dragging, setDragging] = useState(false);

  function end(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    drag.current = undefined;
    setDragging(false);
    document.documentElement.removeAttribute("data-resizing");
    onResize(start.width + (event.clientX - start.x) * grows, true);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused, dragged, or valued.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      className={className ? `resize-handle ${className}` : "resize-handle"}
      data-dragging={dragging || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // No text selection, and no window drag: only this element moves.
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { x: event.clientX, width: value, pointer: event.pointerId };
        setDragging(true);
        document.documentElement.setAttribute("data-resizing", "");
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointer !== event.pointerId) return;
        onResize(start.width + (event.clientX - start.x) * grows, false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const direction = ((event.key === "ArrowRight" ? 1 : -1) * grows) as 1 | -1;
          if (onStep) onStep(direction);
          else onResize(value + direction * KEY_STEP, true);
        } else if (event.key === "Enter" && onEnter) {
          event.preventDefault();
          onEnter();
        }
      }}
    />
  );
}
