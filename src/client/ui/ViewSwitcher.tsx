// The console's view menu: a button showing the current view, opening a menu of
// Global · Talk · one row per Cog (swatch-dotted). Picking a row navigates (a full
// reload, then a reconnect to that view's ws), which is why it is a plain <a>.
//
// It is rendered ONLY when the page is not a replay: in replay mode the console
// shows no operator affordances at all.
import React, { useEffect, useRef, useState } from "react";
import { navUrl, type View } from "./nav";
import { seatAlias, seatColor } from "../colors";

export function ViewSwitcher({
  view,
  seat,
  seats,
}: {
  view: View;
  seat: number | null;
  seats: number[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const label = view === "global" ? "Global" : view === "feed" ? "Talk" : seat !== null ? seatAlias(seat) : "Cog";
  const labelColor = view === "seat" && seat !== null ? seatColor(seat) : "var(--text)";

  const row = (active: boolean, accent: string, name: string, href: string): React.ReactElement => (
    <a
      key={name}
      href={href}
      className={`vs-row ${active ? "is-active" : ""}`}
      style={{ borderLeftColor: active ? accent : "transparent", ...(active ? { color: accent } : {}) }}
    >
      <span className="vs-dot" style={{ background: accent }} />
      {name}
    </a>
  );

  return (
    <div className="view-switcher" ref={ref} data-testid="view-switcher">
      <button
        type="button"
        className="vs-button"
        style={{ color: labelColor }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip="switch view"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="vs-current">{label}</span>
        <span className="vs-caret">▾</span>
      </button>
      {open && (
        <div className="vs-menu" role="menu">
          {row(view === "global", "var(--text)", "Global", navUrl(window.location, "global", null))}
          {row(view === "feed", "var(--paint)", "Talk", navUrl(window.location, "feed", null))}
          <div className="vs-divider" />
          {seats.map((s) =>
            row(view === "seat" && seat === s, seatColor(s), seatAlias(s), navUrl(window.location, "seat", s)),
          )}
        </div>
      )}
    </div>
  );
}
