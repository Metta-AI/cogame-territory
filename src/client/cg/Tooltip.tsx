// One global neon-glass tooltip. Any element carrying a `data-tip` attribute
// (HTML or SVG) shows it in a styled card beside the cursor — replacing the
// browser's native title bubble (slow, unstyled, inconsistent across browsers).
// A single document-level listener serves the whole app; the card itself is
// pointer-events: none so it never steals the hover that opened it.
import React, { useEffect, useRef, useState } from "react";

const OFF = 14; // px between the cursor and the card

export function TooltipLayer(): React.ReactElement | null {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tipOf = (t: EventTarget | null): string | null => {
      const el = t instanceof Element ? t.closest("[data-tip]") : null;
      return el?.getAttribute("data-tip") || null;
    };
    const onMove = (e: MouseEvent): void => {
      const text = tipOf(e.target);
      setTip(text ? { text, x: e.clientX, y: e.clientY } : null);
    };
    const onLeave = (): void => setTip(null);
    document.addEventListener("mousemove", onMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  // Clamp to the viewport once the card's real size is known (it just rendered).
  useEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    let x = tip.x + OFF;
    let y = tip.y + OFF;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, tip.x - OFF - r.width);
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, tip.y - OFF - r.height);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [tip]);

  if (!tip) return null;
  // Multiline tips are pre-formatted tables (mono font) — keep their alignment.
  const pre = tip.text.includes("\n");
  return (
    <div ref={ref} className="cg-tip" style={{ left: tip.x + OFF, top: tip.y + OFF, whiteSpace: pre ? "pre" : undefined }} role="tooltip">
      {tip.text}
    </div>
  );
}
