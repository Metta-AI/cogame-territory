// THE BOARD — a hex lattice of resource walls that only ever gets poorer.
// Pointy-top axial hexes (matching hex-layout.ts).
//
//   * a DRY owned tile is solid owner colour;
//   * a WET tile draws an owner-coloured splatter polygon at 0.55 inset under a
//     shrinking ring, animated by the `cg-drying` keyframe (1.0 -> 0.35 opacity,
//     scale 1.0 -> 0.86 over 250 ms, matching the replay's one-snapshot-per-250 ms
//     playback) and carries `data-wet="1"` so tests can see it;
//   * `cracked` draws a fractured double outline at half fill plus a chipped-wall
//     sprite;
//   * `rubble` is a flat near-black hole with no border and no sprite — visibly
//     walkable, visibly gone;
//   * a hearth carries a ringed home glyph, and a STAGGERED seat's home ring
//     pulses red;
//   * yield is the wall sprite's size, 1-3.
//
// Navigation is kept from the base: the 169-hex board is LARGER than the frame at
// a 360px embed width, so wheel-zoom toward the cursor (1x-8x via the viewBox),
// drag-pan and double-click-to-fit all stay. The SVG's default state is
// `preserveAspectRatio="xMidYMid meet"` over the whole lattice, which IS the fit
// view — so no separate minimap is added; it would only duplicate it.
import React, { useEffect, useRef, useState } from "react";
import type { GameSnapshot, TileSnapshot } from "../shared/snapshot";
import { axialToPixel, hexCorners, polygonPoints } from "./hex-layout";
import { seatColor } from "./colors";
import { homeRingKeys, tileKey } from "./cg/derive";
import { iconSrc, tileSprite } from "./Icon";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const MAX_ZOOM = 8;
const SIZE = 26;
const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const corners = (cx: number, cy: number): string => polygonPoints(hexCorners(cx, cy, SIZE));
/** A hex's corners pulled `f` of the way toward its centre — the paint splatter. */
const innerCorners = (cx: number, cy: number, f: number): string =>
  polygonPoints(hexCorners(cx, cy, SIZE).map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f })));
/** Sprite size by yield: 1-3 walls read at a glance without a label. */
const spriteSize = (y: number): number => SIZE * (0.62 + 0.18 * Math.min(3, Math.max(0, y)));

export function HexBoard({
  snapshot,
  onHoverTile,
  razed = [],
  claimed = [],
  smeared = [],
  emphasis = [],
  highlight = null,
}: {
  snapshot: GameSnapshot;
  /** Reports the tile under the cursor (with client coordinates) on enter, and
   *  null when the cursor leaves — drives the hover inspector. */
  onHoverTile?: (key: string | null, at?: { x: number; y: number }) => void;
  /** Tiles razed on the shown turn — the destruction reveal. */
  razed?: string[];
  /** Tiles claimed on the shown turn — the wet-paint reveal. */
  claimed?: string[];
  /** Tiles smeared on the shown turn — nobody holds them and both paid. */
  smeared?: string[];
  /** Tiles to ring brightly (a ledger row is hovered). */
  emphasis?: string[];
  /** Focus one seat's territory: dim everyone else. */
  highlight?: number | null;
}): React.ReactElement {
  const centers = snapshot.tiles.map((t) => axialToPixel(t.q, t.r, SIZE));
  const xs = centers.map((c) => c.x);
  const ys = centers.map((c) => c.y);
  const pad = SIZE * 1.4;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const w = maxX - minX;
  const h = maxY - minY;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<Box | null>(null);
  const base: Box = { x: minX, y: minY, w, h };
  const baseRef = useRef(base);
  baseRef.current = base;
  const viewRef = useRef(view);
  viewRef.current = view;
  const draggingRef = useRef(false);

  const screenScale = (rect: DOMRect, v: Box): number => Math.min(rect.width / v.w, rect.height / v.h) || 1;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const b = baseRef.current;
      const cur = viewRef.current ?? b;
      const f = Math.exp(-e.deltaY * 0.0015);
      const newW = clampN(cur.w * f, b.w / MAX_ZOOM, b.w);
      if (newW === cur.w) return;
      const rect = svg.getBoundingClientRect();
      let fx = 0.5;
      let fy = 0.5;
      if (rect.width && rect.height) {
        const s = screenScale(rect, cur);
        const padX = (rect.width - cur.w * s) / 2;
        const padY = (rect.height - cur.h * s) / 2;
        fx = clampN((e.clientX - rect.left - padX) / s / cur.w, 0, 1);
        fy = clampN((e.clientY - rect.top - padY) / s / cur.h, 0, 1);
      }
      const newH = cur.h * (newW / cur.w);
      const x = clampN(cur.x + fx * (cur.w - newW), b.x, b.x + b.w - newW);
      const y = clampN(cur.y + fy * (cur.h - newH), b.y, b.y + b.h - newH);
      setView(newW >= b.w ? null : { x, y, w: newW, h: newH });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    const start = viewRef.current;
    if (e.button !== 0 || !start) return; // nothing to pan at full fit
    e.preventDefault();
    const b = baseRef.current;
    const s = screenScale(svgRef.current!.getBoundingClientRect(), start);
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent): void => {
      if (!draggingRef.current && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      if (!draggingRef.current) {
        draggingRef.current = true;
        document.body.style.cursor = "grabbing";
        onHoverTile?.(null);
      }
      setView({
        ...start,
        x: clampN(start.x - (ev.clientX - sx) / s, b.x, b.x + b.w - start.w),
        y: clampN(start.y - (ev.clientY - sy) / s, b.y, b.y + b.h - start.h),
      });
    };
    const up = (): void => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const vb = view ?? base;
  const razedSet = new Set(razed);
  const claimedSet = new Set(claimed);
  const smearSet = new Set(smeared);
  const emphSet = new Set(emphasis);
  // A staggered seat's home ring pulses red: one more strike and it is gone.
  const staggered = new Set<string>();
  for (const cog of snapshot.cogs) {
    if (cog.life !== "staggered") continue;
    for (const k of homeRingKeys(snapshot, cog.seat)) staggered.add(k);
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block", overflow: "visible", cursor: view ? "grab" : "default", touchAction: "none" }}
      onMouseLeave={() => onHoverTile?.(null)}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setView(null)}
      data-testid="hexboard"
    >
      <defs>
        <radialGradient id="cg-core" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="#3ce0c0" stopOpacity={0.16} />
          <stop offset="55%" stopColor="#1a8f9e" stopOpacity={0.04} />
          <stop offset="100%" stopColor="#07070c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx={cx} cy={cy} rx={w * 0.42} ry={h * 0.42} fill="url(#cg-core)" />

      {snapshot.tiles.map((t: TileSnapshot, i) => {
        const c = centers[i]!;
        const k = tileKey(t.q, t.r);
        const owner = t.owner;
        const col = owner === null ? null : seatColor(owner);
        const cn = corners(c.x, c.y);
        const dim = highlight !== null && owner !== highlight ? 0.34 : 1;

        let fill: string;
        let fillOp: number;
        let stroke: string;
        let strokeW = 1;
        let glow = 0;

        if (t.state === "rubble") {
          // A flat near-black hole: no border, no sprite. Visibly walkable.
          fill = "#05050a";
          fillOp = 1;
          stroke = "none";
          strokeW = 0;
        } else if (owner !== null) {
          fill = col!;
          fillOp = (t.wet ? 0.42 : 0.86) * dim;
          stroke = t.state === "cracked" ? col! : "#07070c";
          strokeW = t.state === "cracked" ? 1.8 : 1.2;
          glow = (t.wet ? 5 : 9) * dim;
        } else {
          fill = t.state === "cracked" ? "#191320" : "#14141e";
          fillOp = 1;
          stroke = t.state === "cracked" ? "#3a2430" : "#1b1b28";
          strokeW = 1;
        }

        const sprite = tileSprite(t.state, t.yield);
        const sz = spriteSize(t.effYield || t.yield);

        return (
          <g
            key={k}
            className={`cg-tile${t.wet ? " cg-drying" : ""}`}
            data-tile={k}
            data-state={t.state}
            data-wet={t.wet ? "1" : "0"}
            data-owner={owner === null ? "" : String(owner)}
            onMouseEnter={(e) => {
              if (!draggingRef.current) onHoverTile?.(k, { x: e.clientX, y: e.clientY });
            }}
            style={{ filter: glow > 0 ? `drop-shadow(0 0 ${glow.toFixed(1)}px ${col ?? "#3ce0c0"})` : "none" }}
          >
            <polygon
              points={cn}
              fill={fill}
              fillOpacity={fillOp}
              stroke={stroke}
              strokeWidth={strokeW}
              strokeLinejoin="round"
            />

            {/* cracked: a fractured double outline at half fill */}
            {t.state === "cracked" && (
              <>
                <polygon
                  points={innerCorners(c.x, c.y, 0.74)}
                  fill="none"
                  stroke={col ?? "#ff5a2c"}
                  strokeWidth={0.9}
                  strokeDasharray="4 3"
                  opacity={0.8 * dim}
                />
                <path
                  d={`M${(c.x - SIZE * 0.4).toFixed(1)},${(c.y - SIZE * 0.5).toFixed(1)}L${(c.x + SIZE * 0.12).toFixed(1)},${c.y.toFixed(1)}L${(c.x - SIZE * 0.2).toFixed(1)},${(c.y + SIZE * 0.5).toFixed(1)}`}
                  fill="none"
                  stroke="#ff5a2c"
                  strokeWidth={1.4}
                  opacity={0.85 * dim}
                />
              </>
            )}

            {/* the DRYING-PAINT animation: a splatter under a shrinking ring */}
            {t.wet && owner !== null && (
              <g className="cg-drying-mark" pointerEvents="none">
                <polygon points={innerCorners(c.x, c.y, 0.55)} fill={col!} fillOpacity={0.95} stroke="none" />
                <polygon
                  points={innerCorners(c.x, c.y, 0.88)}
                  fill="none"
                  stroke={col!}
                  strokeWidth={1.6}
                  opacity={0.9}
                />
              </g>
            )}

            {/* the wall sprite: yield IS its size */}
            {sprite !== null && t.state !== "rubble" && (
              <image
                href={iconSrc[sprite]}
                x={c.x - sz / 2}
                y={c.y - sz / 2}
                width={sz}
                height={sz}
                opacity={(owner === null ? 0.72 : 0.9) * dim}
                preserveAspectRatio="xMidYMid meet"
                pointerEvents="none"
              />
            )}

            {/* hearth: a ringed home glyph on the permanent coordinate */}
            {t.hearthOf !== null && (
              <g pointerEvents="none">
                <polygon
                  points={innerCorners(c.x, c.y, 0.94)}
                  fill="none"
                  stroke={seatColor(t.hearthOf)}
                  strokeWidth={2.2}
                  opacity={0.95}
                />
                <image
                  href={iconSrc.hearth}
                  x={c.x - SIZE * 0.42}
                  y={c.y - SIZE * 0.42}
                  width={SIZE * 0.84}
                  height={SIZE * 0.84}
                  opacity={0.85}
                  preserveAspectRatio="xMidYMid meet"
                />
              </g>
            )}

            {/* a staggered seat's home ring pulses red */}
            {staggered.has(k) && (
              <polygon
                className="cg-stagger"
                points={cn}
                fill="none"
                stroke="#ff2e63"
                strokeWidth={2.4}
                pointerEvents="none"
              />
            )}

            {/* an eliminated seat's hearth wears the skull */}
            {t.hearthOf !== null && snapshot.cogs[t.hearthOf]?.life === "eliminated" && (
              <image
                href={iconSrc.skull}
                x={c.x - SIZE * 0.5}
                y={c.y - SIZE * 0.5}
                width={SIZE}
                height={SIZE}
                opacity={0.95}
                preserveAspectRatio="xMidYMid meet"
                pointerEvents="none"
              />
            )}

            {razedSet.has(k) && (
              <polygon
                points={cn}
                fill="none"
                stroke="#ff5a2c"
                strokeWidth={2.6}
                style={{ filter: "drop-shadow(0 0 8px #ff5a2c)" }}
                pointerEvents="none"
              />
            )}
            {claimedSet.has(k) && (
              <polygon
                points={cn}
                fill="none"
                stroke="#fff"
                strokeWidth={1.8}
                strokeDasharray="3 3"
                opacity={0.9}
                pointerEvents="none"
              />
            )}
            {smearSet.has(k) && (
              <text
                x={c.x}
                y={c.y + 5}
                textAnchor="middle"
                fontSize="15"
                fill="#ffe14d"
                pointerEvents="none"
              >
                ✕
              </text>
            )}
            {emphSet.has(k) && (
              <polygon
                points={cn}
                fill="#fff"
                fillOpacity="0.1"
                stroke="#fff"
                strokeWidth="2.4"
                style={{ filter: "drop-shadow(0 0 8px #fff)" }}
                pointerEvents="none"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
