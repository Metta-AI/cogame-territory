// Territory neon-glass atoms: the seat swatch, the tile pill, the paint chip, the
// verb tags, the brand wordmark and the phase strip. Re-labelled from
// coworld-cogherence's atoms; the CSS class vocabulary is inherited unchanged.
import React, { useState } from "react";
import { publishTileHighlight } from "./tile-highlight";
import type { Phase } from "../../shared/engine/types";
import { Icon, type IconName } from "../Icon";
import logoWordmark from "../art/logo-wordmark.png";
import { policyName, seatAlias, seatColor } from "../colors";

/** A real neon-glass game sprite (wall / cracked / rubble / hearth / skull / …). */
export function CGIcon({ name, size = 16, title }: { name: IconName; size?: number; title?: string }): React.ReactElement {
  return <Icon name={name} size={size} title={title} />;
}

/** A seat's colour swatch. */
export function Swatch({ seat, size = 9 }: { seat: number; size?: number }): React.ReactElement {
  return (
    <span
      className="cg-swatch"
      style={{ width: size, height: size, borderRadius: 2, background: seatColor(seat), flex: "0 0 auto" }}
    />
  );
}

/** A seat's name as spectators read it: the in-game ALIAS, plus the real policy
 *  name when the replay carries one. `.plate-name` keeps it from collapsing to
 *  "…" in the 360px featured-match iframe. */
export function SeatName({ seat, showPolicy = true }: { seat: number; showPolicy?: boolean }): React.ReactElement {
  const policy = policyName(seat);
  return (
    <span className="plate-name" style={{ color: seatColor(seat) }}>
      <b className="plate-alias">{seatAlias(seat)}</b>
      {showPolicy && policy && <span className="plate-policy">{policy}</span>}
    </span>
  );
}

/** Free text with any raw seat index rendered as that Cog's coloured alias. */
export function CogText({ text }: { text: string }): React.ReactElement {
  return <>{text}</>;
}

/** A tile address as a hoverable pill — hovering highlights the tile on the board. */
export function TilePill({ k }: { k: string }): React.ReactElement {
  return (
    <span
      className="cg-tilepill"
      onMouseEnter={() => publishTileHighlight([k])}
      onMouseLeave={() => publishTileHighlight([])}
    >
      {k}
    </span>
  );
}

/** The paint badge — a glowing splatter chip, sized like a resource chip. */
export function PaintChip({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <span className="cg-min paint" title="paint">
      <span style={{ display: "inline-flex" }}>
        <CGIcon name="paint-splatter" size={size} />
      </span>
    </span>
  );
}

/** A board-verb tag (claim / raze / transfer / smear …). */
export function VerbTag({ kind, children }: { kind: string; children: React.ReactNode }): React.ReactElement {
  return <span className={`cg-verb ${kind}`}>{children}</span>;
}

function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/** The TERRITORY wordmark — the gear-as-O lockup generated with nano-banana (see
 *  AGENTS.md), keyed to a transparent PNG so it drops onto the dark UI. */
export function Wordmark({ small = false }: { small?: boolean }): React.ReactElement {
  return (
    <img
      src={logoWordmark}
      alt="TERRITORY"
      draggable={false}
      style={{ height: small ? 18 : 24, width: "auto", display: "block" }}
    />
  );
}

/** The brand. Click copies this view's shareable link. */
export function Brand({ small = false }: { small?: boolean }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    copyText(`${window.location.origin}${window.location.pathname}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="brand"
      data-tip="click to copy this view's shareable link"
      onClick={copy}
      onKeyDown={(e) => e.key === "Enter" && copy()}
      style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
    >
      <Wordmark small={small} />
      {copied && (
        <span className="cg-mono" style={{ fontSize: 9, color: "var(--paint)", whiteSpace: "nowrap" }}>
          ✓ copied
        </span>
      )}
    </div>
  );
}

const PHASES: { k: Phase; label: string }[] = [
  { k: "commit", label: "Commit" },
  { k: "resolve", label: "Resolve" },
  { k: "upkeep", label: "Upkeep" },
];

/** The three-phase strip with the current phase lit. */
export function PhaseStripCG({ phase }: { phase: Phase }): React.ReactElement {
  const idx = PHASES.findIndex((p) => p.k === phase);
  return (
    <div className="cg-phases" data-testid="phase-strip">
      {PHASES.map((p, i) => (
        <div key={p.k} className={`cg-phase ${i < idx ? "done" : i === idx ? "current" : ""}`}>
          <span className="cg-phase-dot" />
          {p.label}
        </div>
      ))}
    </div>
  );
}
