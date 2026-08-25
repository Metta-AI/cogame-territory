// A three-column dashboard layout whose left/right side panels are drag-resizable
// via the gutters flanking the center. Widths persist to localStorage under
// `storageKey`, so a viewer's chosen layout survives reloads. The center fills the
// remaining space (minmax(0,1fr)); the sides are clamped to a sane range.
import React, { useEffect, useRef, useState } from "react";

const GUTTER = 12; // px — the draggable gap between a side panel and the center
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

interface Widths {
  left: number;
  right: number;
}

/** The browser's localStorage, or null where it isn't a working API (SSR, the
 *  jsdom test env, privacy modes). Callers degrade gracefully — no persistence. */
function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  return typeof window !== "undefined" && typeof window.localStorage?.getItem === "function" ? window.localStorage : null;
}

/** Read persisted "<left>,<right>" widths (plain numbers — no JSON parse to throw). */
function loadWidths(key: string, fallback: Widths): Widths {
  const raw = storage()?.getItem(key);
  if (!raw) return fallback;
  const [l, r] = raw.split(",").map(Number);
  return Number.isFinite(l) && Number.isFinite(r) ? { left: l!, right: r! } : fallback;
}

export function ResizableColumns({
  storageKey,
  defaultLeft,
  defaultRight,
  left,
  center,
  right,
  min = 240,
  max = 560,
  rightCollapsed = false,
}: {
  storageKey: string;
  defaultLeft: number;
  defaultRight: number;
  left: React.ReactNode;
  center: React.ReactNode;
  right: React.ReactNode;
  min?: number;
  max?: number;
  /** Collapse the right column to a slim strip (the caller renders the strip
   *  content); its gutter stops resizing while collapsed. */
  rightCollapsed?: boolean;
}): React.ReactElement {
  const [w, setW] = useState<Widths>(() => loadWidths(storageKey, { left: defaultLeft, right: defaultRight }));
  // Latest widths in a ref so the drag move handler (bound once per drag) reads fresh values.
  const wRef = useRef(w);
  wRef.current = w;

  useEffect(() => {
    storage()?.setItem(storageKey, `${w.left},${w.right}`);
  }, [storageKey, w]);

  const startDrag = (side: "left" | "right", e: React.PointerEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const start = side === "left" ? wRef.current.left : wRef.current.right;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      // Dragging the left gutter right widens the left panel; the right gutter is
      // anchored to the right edge, so dragging it right narrows the right panel.
      const next = clamp(side === "left" ? start + dx : start - dx, min, max);
      setW((cur) => ({ ...cur, [side]: next }));
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className="cg-grid"
      style={{ gap: 0, gridTemplateColumns: `${w.left}px ${GUTTER}px minmax(0, 1fr) ${rightCollapsed ? "4px 34px" : `${GUTTER}px ${w.right}px`}` }}
    >
      {left}
      <div
        className="cg-gutter"
        onPointerDown={(e) => startDrag("left", e)}
        onDoubleClick={() => setW((c) => ({ ...c, left: defaultLeft }))}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize left panel"
        data-tip="Drag to resize · double-click to reset"
      />
      {center}
      <div
        className="cg-gutter"
        onPointerDown={rightCollapsed ? undefined : (e) => startDrag("right", e)}
        onDoubleClick={rightCollapsed ? undefined : () => setW((c) => ({ ...c, right: defaultRight }))}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right panel"
        data-tip={rightCollapsed ? undefined : "Drag to resize · double-click to reset"}
        style={rightCollapsed ? { cursor: "default" } : undefined}
      />
      {right}
    </div>
  );
}
