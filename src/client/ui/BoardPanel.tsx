// BoardPanel — the framed, instrumented board: the hex lattice plus the turn
// pulse, the legend, the navigation hint and the hover tile inspector. The
// inspector is a hover card that tracks the tile under the cursor and flips at
// the panel's right/bottom edges; leaving the lattice dismisses it. Nothing is
// pinned, and every overlay it mounts lives INSIDE this panel — which is inside
// `.cg-stage` — so nothing can ever paint into the transport band.
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GameSnapshot } from "../../shared/snapshot";
import type { StampedEvent } from "../net/feed";
import { HexBoard } from "../HexBoard";
import { TileInspector } from "../cg/panels";
import { subscribeTileHighlight } from "../cg/tile-highlight";
import { claimedAt, lastResolvedTurn, razedAt, razeCountAt, smearedAt } from "../cg/derive";
import { CGIcon } from "../cg/atoms";

/** The one-line turn pulse over the board: what this turn actually did. */
function TurnPulse({ snapshot, events }: { snapshot: GameSnapshot; events: StampedEvent[] }): React.ReactElement | null {
  const turn = lastResolvedTurn(snapshot);
  if (turn < 1) return null;
  const claims = claimedAt(events, turn).length;
  const razes = razeCountAt(events, turn);
  const smears = smearedAt(events, turn).length;
  return (
    <div className="cg-glass cg-pulse" data-testid="turn-pulse">
      <span className="cg-mono" style={{ color: "var(--paint)" }}>
        {claims} claimed
      </span>
      {razes > 0 && (
        <span className="cg-mono" style={{ color: "var(--raze)" }}>
          ✖ {razes} razed
        </span>
      )}
      {smears > 0 && (
        <span className="cg-mono" style={{ color: "var(--deal)" }}>
          ✕ {smears} smeared
        </span>
      )}
      <span className="cg-mono" style={{ color: "var(--muted)" }}>
        {snapshot.destroyed} rubble · pool {snapshot.poolEnd}/{snapshot.poolStart}
      </span>
    </div>
  );
}

function Legend(): React.ReactElement {
  return (
    <div className="cg-glass cg-legend">
      <span className="cg-legend-item">
        <CGIcon name="wall" size={14} /> wall
      </span>
      <span className="cg-legend-item">
        <CGIcon name="cracked" size={14} /> cracked · half yield
      </span>
      <span className="cg-legend-item">
        <CGIcon name="rubble" size={14} /> rubble · gone
      </span>
      <span className="cg-legend-item">
        <CGIcon name="hearth" size={14} /> hearth
      </span>
    </div>
  );
}

export function BoardPanel({
  snapshot,
  events,
  highlight = null,
}: {
  snapshot: GameSnapshot;
  events: StampedEvent[];
  highlight?: number | null;
}): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const CARD_W = 250;
  const CARD_H = 320;
  const OFF = 18;
  const handleHover = useCallback((key: string | null, at?: { x: number; y: number }) => {
    if (!key || !at) {
      setHover(null);
      return;
    }
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = at.x - r.left;
    const py = at.y - r.top;
    const x = px + OFF + CARD_W > r.width ? Math.max(8, px - OFF - CARD_W) : px + OFF;
    const y = py + OFF + CARD_H > r.height ? Math.max(8, py - OFF - CARD_H) : py + OFF;
    setHover({ key, x, y });
  }, []);

  const [hotTiles, setHotTiles] = useState<string[]>([]);
  useEffect(() => subscribeTileHighlight(setHotTiles), []);

  const turn = lastResolvedTurn(snapshot);
  return (
    <div className="cg-panel cg-lattice" ref={wrapRef} data-testid="board">
      <div className="cg-lattice-inner">
        <HexBoard
          snapshot={snapshot}
          onHoverTile={handleHover}
          razed={razedAt(events, turn)}
          claimed={claimedAt(events, turn)}
          smeared={smearedAt(events, turn)}
          emphasis={hotTiles}
          highlight={highlight}
        />
      </div>
      <div className="cg-overlay-tl">
        <TurnPulse snapshot={snapshot} events={events} />
      </div>
      <div className="cg-overlay-br">
        <Legend />
      </div>
      <div className="cg-glass cg-navhint">
        <span className="cg-mono">scroll zoom · drag pan · 2×click fit</span>
      </div>
      {hover && (
        <div className="cg-hovercard" style={{ left: hover.x, top: hover.y }}>
          <TileInspector tileKey={hover.key} snapshot={snapshot} />
        </div>
      )}
    </div>
  );
}
