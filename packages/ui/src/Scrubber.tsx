// Scrubber<T> — a game-agnostic transport + draggable rail over any timeline.
// The component owns the playhead UI (first/prev/next/last/live, a draggable
// rail with per-item ticks, a glowing thumb, ←/→ keys); the GAME supplies the
// per-tick density/label via `renderMeta` and the current-item readout via
// `renderReadout`. It knows nothing about turns, scores, or board state.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export interface ScrubberProps<T> {
  /** Ordered timeline (e.g. snapshots). The thumb sits at `index`. */
  timeline: T[];
  index: number;
  onSeek: (i: number) => void;
  playing?: boolean;
  onTogglePlay?: () => void;
  /** Per-tick overlay drawn inside each rail tick (density bars, key-turn marks). */
  renderMeta?: (item: T, i: number) => ReactNode;
  /** Readout for the current item, shown beside the transport (e.g. "TURN 42"). */
  renderReadout?: (item: T, i: number) => ReactNode;
}

export function Scrubber<T>({
  timeline,
  index,
  onSeek,
  playing = false,
  onTogglePlay,
  renderMeta,
  renderReadout,
}: ScrubberProps<T>) {
  const last = Math.max(0, timeline.length - 1);
  const live = index >= last;
  const railRef = useRef<HTMLDivElement>(null);

  // ←/→ step one item. Registered once; reads latest state via a ref so the
  // listener never goes stale. Ignored while typing in an input/textarea.
  const stepRef = useRef({ index, last, onSeek });
  stepRef.current = { index, last, onSeek };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      const s = stepRef.current;
      s.onSeek(clamp(s.index + (e.key === "ArrowLeft" ? -1 : 1), 0, s.last));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const indexAt = (clientX: number): number => {
    const rect = railRef.current!.getBoundingClientRect();
    return clamp(Math.round(((clientX - rect.left) / rect.width) * last), 0, last);
  };
  const onRailDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    onSeek(indexAt(e.clientX));
    const move = (ev: PointerEvent): void => onSeek(indexAt(ev.clientX));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const cur = timeline[clamp(index, 0, last)];
  const pct = last === 0 ? 0 : (index / last) * 100;

  return (
    <div className="cogui-scrubber" data-testid="scrubber">
      <div
        ref={railRef}
        className="cogui-rail"
        onPointerDown={onRailDown}
        data-testid="scrub-rail"
      >
        {timeline.map((item, i) => (
          <div
            key={i}
            className={`cogui-tick${i === index ? " is-now" : ""}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSeek(i);
            }}
          >
            {renderMeta?.(item, i)}
          </div>
        ))}
        <div className="cogui-thumb" style={{ left: `${pct}%` }} />
      </div>

      <div className="cogui-transport">
        <button type="button" className="cogui-tbtn" aria-label="First" onClick={() => onSeek(0)}>
          ⏮
        </button>
        <button
          type="button"
          className="cogui-tbtn"
          aria-label="Previous"
          onClick={() => onSeek(clamp(index - 1, 0, last))}
        >
          ◀
        </button>
        {onTogglePlay && (
          <button
            type="button"
            className="cogui-tbtn is-wide"
            aria-label={playing ? "Pause" : "Play"}
            onClick={onTogglePlay}
          >
            {playing ? "❚❚" : "▶"}
          </button>
        )}
        <button
          type="button"
          className="cogui-tbtn"
          aria-label="Next"
          onClick={() => onSeek(clamp(index + 1, 0, last))}
        >
          ▶
        </button>
        <button type="button" className="cogui-tbtn" aria-label="Latest" onClick={() => onSeek(last)}>
          ⏭
        </button>

        <span className="cogui-spacer" />
        <span className={`cogui-live-dot${live ? " is-live" : " is-replay"}`} aria-label={live ? "live" : "replay"} />
        {cur !== undefined && renderReadout && <span className="cogui-readout">{renderReadout(cur, index)}</span>}
      </div>
    </div>
  );
}
