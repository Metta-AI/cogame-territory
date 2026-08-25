// GameScrubberBar — the unified bottom bar every cogame mounts below its board
// (ported from the "Game Top Bar" design; modeled on cogherence's Scrubber). It
// is the richer sibling of <Scrubber>: over the same snapshot timeline it draws
//   • a full-game OVERVIEW band — one activity bar per snapshot (height = the
//     game's per-turn density), a leader-color ribbon, ◆ key-turn marks, a
//     draggable lens WINDOW for long games, and a playhead. Click to jump. A
//     chevron collapses the band (it reclaims the space below it).
//   • a per-turn RAIL — the windowed turns as clickable blocks (number, phase
//     pips, a live dot), the viewed turn highlighted.
//   • a PHASE strip — the game's phases with the current one pulsing and a live
//     countdown, an AUTO-ADVANCE toggle, and the TURN/ROUND N/max readout.
// ←/→ scrub the playhead (ignored while typing). Everything game-specific (the
// per-turn density/leader/key, the phase vocabulary, the horizon) arrives via
// props, so the bar knows nothing about any one game.
import { useEffect, useRef, useState, type ReactNode } from "react";

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
/** How many turns the rail shows at once; longer games scan via the lens window. */
const WIN = 14;

export interface ScrubberMeta {
  /** The turn/round number for this snapshot (shown on the rail + readout). */
  turn: number;
  /** Activity height 0..1 for the overview bar (e.g. message density this turn). */
  density?: number;
  /** Leader/dominant color for the ribbon under this turn's overview bar. */
  leaderColor?: string;
  /** Flag a pivotal turn — a ◆ on the overview + rail. */
  key?: boolean;
}

export interface GameScrubberBarProps<T> {
  /** Ordered timeline (the game's snapshots). The playhead sits at `index`. */
  timeline: T[];
  index: number;
  onSeek: (i: number) => void;
  /** Per-snapshot overview/rail metadata. */
  meta: (item: T, i: number) => ScrubberMeta;
  /** Phase vocabulary in order + which is current (like PhaseIndicator). */
  phases: { id: string; label: string }[];
  currentPhase: string;
  /** Word for the readout/labels ("Turn" / "Round"). */
  phaseWord?: string;
  /** The game's turn horizon for the `N / max` readout (e.g. config.rounds). */
  maxTurns?: number;
  /** The game is over: append one synthetic 🏁 FINAL tile after the last snapshot.
   *  Its index is `timeline.length` (one past the last real snapshot); selecting it
   *  is what the game reads (index === timeline.length) as "show the final score
   *  panel" instead of a board, so the score becomes a scrubbable terminal turn. */
  final?: boolean;
  /** Auto-advance control (wire-driven). Omit to hide the toggle + countdown.
   *  `deadline` is the epoch-ms the acting seat is moved on (RunStatus.deadline). */
  autoAdvance?: { on: boolean; onToggle: () => void; deadline?: number | null };
  /** Optional readout suffix shown after `N / max` (e.g. a board-state badge). */
  trailing?: ReactNode;
  /** Optional per-turn detail rendered inside each rail cell, below the phase pips
   *  (e.g. a leader heart + a stacked territory bar). Receives the timeline item. */
  renderRailExtra?: (item: T, i: number) => ReactNode;
}

export function GameScrubberBar<T>({
  timeline,
  index,
  onSeek,
  meta,
  phases,
  currentPhase,
  phaseWord = "Turn",
  maxTurns,
  final = false,
  autoAdvance,
  trailing,
  renderRailExtra,
}: GameScrubberBarProps<T>) {
  const n = timeline.length;
  // `slots` is the index space the playhead lives in: the real snapshots plus one
  // synthetic 🏁 FINAL tile when the game is over (index === n). `n` stays the count
  // of real snapshots so every per-snapshot lookup (metas[i], renderRailExtra) is
  // still in-bounds; only the geometry/transport reaches the FINAL slot.
  const slots = n + (final ? 1 : 0);
  const last = Math.max(0, slots - 1);
  const viewIdx = clamp(index, 0, last);
  const live = viewIdx >= last;
  const onFinal = final && viewIdx >= n;

  // The overview band exists to scan a game too long for the rail to show at once,
  // so keep it minimized until the timeline actually overflows the rail (slots > WIN) —
  // a short game keeps it tucked away, and it pops open the moment it's useful. The
  // effect below tracks that threshold; the chevron is still a manual override
  // between transitions.
  const overflow = slots > WIN;
  const [ovOpen, setOvOpen] = useState(false);
  const [winStart, setWinStart] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const ovRef = useRef<HTMLDivElement>(null);

  const metas = timeline.map((t, i) => meta(t, i));
  const liveTurn = metas[n - 1]?.turn ?? 0;
  const viewTurn = onFinal ? liveTurn : metas[viewIdx]?.turn ?? 0;
  // Only show "/ max" when the game has a fixed horizon; open-ended games (e.g.
  // Cognames, which ends on a board condition) show just the turn number.
  const horizon = maxTurns != null ? Math.max(maxTurns, liveTurn) : null;

  // Keep the viewed index inside the window as the playhead moves.
  useEffect(() => {
    setWinStart((ws) => {
      const maxStart = Math.max(0, slots - WIN);
      if (viewIdx < ws) return clamp(viewIdx, 0, maxStart);
      if (viewIdx > ws + WIN - 1) return clamp(viewIdx - WIN + 1, 0, maxStart);
      return clamp(ws, 0, maxStart);
    });
  }, [viewIdx, slots]);

  // Minimized by default; pop the overview open once the timeline overflows the rail,
  // and tuck it back when it no longer does (e.g. a fresh game's first few turns).
  useEffect(() => {
    setOvOpen(overflow);
  }, [overflow]);

  // ←/→ step the playhead one snapshot (latest state via a ref so the listener
  // never goes stale). Ignored while typing in an input/textarea.
  const stepRef = useRef({ viewIdx, last, onSeek });
  stepRef.current = { viewIdx, last, onSeek };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      const s = stepRef.current;
      s.onSeek(clamp(s.viewIdx + (e.key === "ArrowLeft" ? -1 : 1), 0, s.last));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Live phase-deadline countdown (ticks while auto-advance is on).
  const [now, setNow] = useState(() => 0);
  useEffect(() => {
    if (!autoAdvance?.on || autoAdvance.deadline == null) return;
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [autoAdvance?.on, autoAdvance?.deadline]);
  const remainingMs =
    autoAdvance?.on && autoAdvance.deadline != null && now > 0 ? Math.max(0, autoAdvance.deadline - now) : null;
  const timerText = remainingMs == null ? null : `${Math.ceil(remainingMs / 1000)}s`;

  const indexAtX = (clientX: number, el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    return clamp(Math.round(((clientX - r.left) / r.width) * last), 0, last);
  };
  const onOvDown = (e: React.PointerEvent): void => {
    onSeek(indexAtX(e.clientX, e.currentTarget as HTMLElement));
  };
  const startLensDrag = (e: React.PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const ov = ovRef.current;
    if (!ov) return;
    const maxStart = Math.max(0, slots - WIN);
    const grabbed = indexAtX(e.clientX, ov);
    const offset = grabbed - winStart;
    const move = (ev: PointerEvent): void => setWinStart(clamp(indexAtX(ev.clientX, ov) - offset, 0, maxStart));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const accent = "var(--cogui-accent)";
  const accentSoft = "color-mix(in srgb, var(--cogui-accent) 50%, transparent)";
  const curPhaseIdx = phases.findIndex((p) => p.id === currentPhase);

  const railEnd = Math.min(winStart + WIN - 1, last);
  const lensLeft = slots === 0 ? 0 : (winStart / slots) * 100;
  const lensWidth = slots === 0 ? 100 : (Math.min(WIN, slots) / slots) * 100;
  const playheadLeft = slots <= 1 ? 0 : ((viewIdx + 0.5) / slots) * 100;

  return (
    <div className="cogui-sbar" data-testid="game-scrubber-bar">
      {ovOpen && (
        <div className="cogui-sbar-ovwrap">
          <div ref={ovRef} className="cogui-sbar-ov" onPointerDown={onOvDown} data-testid="sbar-overview">
            <div className="cogui-sbar-bars">
              {metas.map((m, i) => {
                const den = m.density ?? 0.4;
                return (
                  <div key={i} className="cogui-sbar-barcol">
                    <div
                      className="cogui-sbar-bar"
                      style={{
                        height: `${3 + Math.round(den * 19)}px`,
                        background: m.key ? "rgba(255,90,44,.45)" : "rgba(120,130,160,.3)",
                      }}
                    />
                    <div className="cogui-sbar-ribbon" style={{ background: m.leaderColor ?? "#1a1d26" }} />
                  </div>
                );
              })}
              {final && (
                <div key="final" className="cogui-sbar-barcol">
                  <div className="cogui-sbar-bar" style={{ height: "22px", background: accentSoft }} />
                  <div className="cogui-sbar-ribbon" style={{ background: accent }} />
                </div>
              )}
            </div>
            {metas.map((m, i) =>
              m.key ? (
                <div
                  key={`k${i}`}
                  className="cogui-sbar-key"
                  style={{ left: `${slots <= 1 ? 0 : (i / (slots - 1)) * 100}%` }}
                />
              ) : null,
            )}
            <div
              className="cogui-sbar-lens"
              onPointerDown={startLensDrag}
              title="drag to scan"
              style={{ left: `${lensLeft}%`, width: `${lensWidth}%` }}
            />
            <div
              className="cogui-sbar-playhead"
              style={{
                left: `${playheadLeft}%`,
                background: live ? accent : "#ff6a6a",
                boxShadow: `0 0 6px ${live ? accent : "#ff6a6a"}`,
              }}
            />
          </div>
        </div>
      )}

      {/* per-turn rail (always shown); its chevron collapses the overview above. */}
      <div className="cogui-sbar-railwrap">
        <div className="cogui-sbar-chevrow">
          <button
            type="button"
            className="cogui-sbar-ovtoggle"
            title={ovOpen ? "Hide full-game window" : "Show full-game window"}
            onClick={() => setOvOpen((o) => !o)}
            data-testid="sbar-overview-toggle"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: ovOpen ? "rotate(0deg)" : "rotate(180deg)" }}
            >
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </button>
        </div>
        <div ref={railRef} className="cogui-sbar-rail cogui-tbscroll" data-testid="sbar-rail">
          {Array.from({ length: railEnd - winStart + 1 }, (_, j) => winStart + j).map((i) => {
            const isNow = i === viewIdx;
            const isLive = i === last;
            // The synthetic FINAL tile (i === n): the score-panel turn, not a board.
            if (i === n) {
              return (
                <button
                  key="final"
                  type="button"
                  className={`cogui-sbar-turn cogui-sbar-final${isNow ? " is-now" : ""}`}
                  onClick={() => onSeek(i)}
                  data-testid="sbar-final"
                >
                  <div className="cogui-sbar-turn-top">
                    <span className="cogui-sbar-turn-num">🏁</span>
                    <span className="cogui-spacer" />
                    {isLive && <span className="cogui-sbar-turn-live" />}
                  </div>
                  <div className="cogui-sbar-final-label">FINAL</div>
                </button>
              );
            }
            const m = metas[i]!;
            return (
              <button
                key={i}
                type="button"
                className={`cogui-sbar-turn${isNow ? " is-now" : ""}`}
                onClick={() => onSeek(i)}
                data-testid={`sbar-turn-${i}`}
              >
                <div className="cogui-sbar-turn-top">
                  <span className="cogui-sbar-turn-num">{String(m.turn).padStart(2, "0")}</span>
                  {m.key && <span className="cogui-sbar-turn-key">◆</span>}
                  <span className="cogui-spacer" />
                  {isLive && <span className="cogui-sbar-turn-live" />}
                </div>
                <div className="cogui-sbar-pips">
                  {phases.map((ph, pi) => {
                    let bg: string;
                    if (i < last) bg = accentSoft;
                    else if (pi < curPhaseIdx) bg = accentSoft;
                    else if (pi === curPhaseIdx) bg = accent;
                    else bg = "#2a2e3a";
                    return <div key={ph.id} className="cogui-sbar-pip" style={{ background: bg }} title={ph.label} />;
                  })}
                </div>
                {renderRailExtra && <div className="cogui-sbar-railextra">{renderRailExtra(timeline[i]!, i)}</div>}
              </button>
            );
          })}
        </div>
      </div>

      {/* phases + countdown + auto-advance + readout */}
      <div className={`cogui-sbar-foot${ovOpen ? " has-border" : ""}`}>
        <span className="cogui-sbar-scrubhint">
          <span className="cogui-sbar-key-cap">←</span>
          <span className="cogui-sbar-key-cap">→</span>
          scrub
        </span>

        <div className="cogui-sbar-phases">
          {phases.map((ph, pi) => {
            const state =
              !live || curPhaseIdx < 0
                ? "done"
                : pi < curPhaseIdx
                  ? "done"
                  : pi === curPhaseIdx
                    ? "current"
                    : "upcoming";
            const showTimer = state === "current" && live && timerText != null;
            return (
              <div key={ph.id} className={`cogui-sbar-phase is-${state}`}>
                <span className="cogui-sbar-pdot" />
                <span className="cogui-sbar-plabel">{ph.label}</span>
                {showTimer && <span className="cogui-sbar-timer">{timerText}</span>}
              </div>
            );
          })}
        </div>

        <span className="cogui-spacer" />

        {autoAdvance && (
          <button
            type="button"
            className={`cogui-sbar-aa${autoAdvance.on ? " is-on" : ""}`}
            onClick={autoAdvance.onToggle}
            title={
              autoAdvance.on
                ? "Turns auto-advance at the phase deadline — click to wait for every cog"
                : "Turns wait for every cog — click to auto-advance at the deadline"
            }
            data-testid="sbar-autoadvance"
          >
            <span className="cogui-sbar-aasw">
              <span className="cogui-sbar-aaknob" />
            </span>
            AUTO-ADVANCE
          </button>
        )}

        <div className="cogui-sbar-readout">
          {onFinal ? (
            <span className="cogui-sbar-rnum">🏁 FINAL</span>
          ) : (
            <>
              <span className="cogui-sbar-rword">{phaseWord.toUpperCase()}</span>
              <span className="cogui-sbar-rnum">{String(viewTurn).padStart(2, "0")}</span>
              {horizon != null && <span className="cogui-sbar-rmax">/{horizon}</span>}
            </>
          )}
          {trailing}
        </div>
      </div>
    </div>
  );
}
