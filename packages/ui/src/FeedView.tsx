// FeedView — the full-bleed "Game feed" (ported from the "Game Top Bar" design).
// This is NOT the comms drawer: it is a global, read-only history of EVERYTHING
// that has happened in the game, grouped by turn (oldest → newest), with a
// timeline of typed events — moves, table talk, score changes, and system
// events — type filters (All / Moves / Talk / Events), and your autopilot's
// reasoning folded inline. It fills the board region (the host renders it inside
// a `position: relative` container) and is DRIVEN BY THE SCRUBBER: it opens on
// the live turn and auto-scrolls to (and highlights) whatever turn the playhead
// sits on, with a live/replay status pill that mirrors the scrubber.
//
// Each game maps its own event stream onto FeedViewEvent — the component is
// game-agnostic and owns only the layout, grouping, filtering, and scroll-sync.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type FeedEventType = "move" | "say" | "score" | "event";

export interface FeedViewEvent {
  /** Stable key (e.g. the source event's index). */
  id: string | number;
  /** The turn this event belongs to (groups the timeline). */
  turn: number;
  type: FeedEventType;
  /** Actor display name; empty/undefined renders as "System". */
  actor?: string;
  /** Actor name color (e.g. the seat's color). */
  actorColor?: string;
  text: string;
  /** Phase label shown after the type tag (e.g. "Negotiate"). */
  phase?: string;
  /** A private DM — rendered ember and surfaced under the Talk filter. */
  whisper?: boolean;
  /** Authored by the viewer (tags become "YOUR MOVE" / "YOU SAID"). */
  mine?: boolean;
  /** Optional reasoning/detail, shown as a left-bordered block (e.g. a decision). */
  detail?: string;
  /** Optional score-delta badge (e.g. "+3♥"). */
  delta?: ReactNode;
  /** Optional per-event marker (e.g. an emoji) rendered in the timeline node
   *  instead of the default {@link NODE_ICON} for the event's type — so a game
   *  can give its moves result-aware glyphs (✅/❌/☠️) matching its own feed. */
  icon?: ReactNode;
}

export interface FeedViewProps {
  /** Game name for the header subtitle. */
  gameName: string;
  /** The full event stream; grouped internally by turn (ascending). */
  events: FeedViewEvent[];
  /** Phase vocabulary in order, for the per-turn pips. */
  phases: { id: string; label: string }[];
  /** The live turn's current phase index (drives the live-turn pips). */
  currentPhaseIndex?: number;
  /** Word for the turn labels ("Turn" / "Round"). */
  phaseWord?: string;
  liveTurn: number;
  /** The scrubber's focused turn: the auto-scroll target + the highlighted group. */
  viewTurn: number;
  maxTurns?: number;
  /** Replaying a past turn — the status pill turns red + offers "Jump to live". */
  decoupled?: boolean;
  onSnapLive?: () => void;
  onClose: () => void;
}

const FILTERS: { key: "all" | "move" | "say" | "event"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "move", label: "Moves" },
  { key: "say", label: "Talk" },
  { key: "event", label: "Events" },
];

const NODE_ICON: Record<FeedEventType, ReactNode> = {
  move: <path d="M20 6 9 17l-5-5" />,
  say: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  ),
  score: (
    <>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </>
  ),
  event: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
};

function tagFor(e: FeedViewEvent): string {
  if (e.type === "move") return e.mine ? "YOUR MOVE" : "MOVE";
  if (e.type === "say") return e.whisper ? "WHISPER" : e.mine ? "YOU SAID" : "SAYS";
  if (e.type === "score") return "SCORE";
  return "EVENT";
}

export function FeedView({
  gameName,
  events,
  phases,
  currentPhaseIndex = 0,
  phaseWord = "Turn",
  liveTurn,
  viewTurn,
  maxTurns,
  decoupled = false,
  onSnapLive,
  onClose,
}: FeedViewProps) {
  const [filter, setFilter] = useState<"all" | "move" | "say" | "event">("all");
  const scrollRef = useRef<HTMLDivElement>(null);

  const allow: FeedEventType[] | null =
    filter === "move" ? ["move"] : filter === "say" ? ["say"] : filter === "event" ? ["score", "event"] : null;

  // Group into contiguous turns (ascending). Filtered, then empty turns dropped.
  const byTurn = new Map<number, FeedViewEvent[]>();
  for (const e of events) {
    if (allow && !allow.includes(e.type)) continue;
    const list = byTurn.get(e.turn) ?? [];
    list.push(e);
    byTurn.set(e.turn, list);
  }
  const groups = [...byTurn.entries()].sort((a, b) => a[0] - b[0]).filter(([, evs]) => evs.length > 0);

  // Drive the scroll from the scrubber: land on the focused turn whenever it (or
  // the filter, which reflows the list) changes.
  useLayoutEffect(() => {
    const cont = scrollRef.current;
    if (!cont) return;
    const el = cont.querySelector<HTMLElement>(`[data-feed-turn="${viewTurn}"]`);
    if (!el) return;
    cont.scrollTop += el.getBoundingClientRect().top - cont.getBoundingClientRect().top - 4;
  }, [viewTurn, filter, groups.length]);

  const pillColor = decoupled ? "#ff6a6a" : "var(--cogui-accent)";
  const pad = (n: number): string => String(n).padStart(2, "0");

  return (
    <div className="cogui-fv" data-testid="feed-view">
      <div className="cogui-fv-head">
        <span className="cogui-fv-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </span>
        <div className="cogui-fv-titles">
          <span className="cogui-fv-title">Game feed</span>
          <span className="cogui-fv-sub">
            Everything that's happened in {gameName} · grouped by {phaseWord.toLowerCase()}
          </span>
        </div>
        <span className="cogui-spacer" />

        <div className="cogui-fv-pill" style={{ borderColor: decoupled ? "rgba(255,106,106,.4)" : "color-mix(in srgb, var(--cogui-accent) 40%, transparent)" }}>
          <span className="cogui-fv-pilldot" style={{ background: pillColor, boxShadow: `0 0 6px ${pillColor}` }} />
          <span className="cogui-fv-pilltext" style={{ color: pillColor }}>
            {phaseWord.toUpperCase()} {pad(viewTurn)}
            {maxTurns != null && <span className="cogui-fv-pillmax">/{maxTurns}</span>}
          </span>
          {decoupled && onSnapLive && (
            <button type="button" className="cogui-fv-jump" onClick={onSnapLive}>
              JUMP TO LIVE
            </button>
          )}
        </div>

        <div className="cogui-fv-filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`cogui-fv-filter${filter === f.key ? " is-on" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <button type="button" className="cogui-fv-close" title="Close feed" onClick={onClose} data-testid="feed-view-close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div ref={scrollRef} className="cogui-fv-body cogui-tbscroll">
        <div className="cogui-fv-inner">
          {groups.length === 0 ? (
            <p className="cogui-fv-empty">No activity yet.</p>
          ) : (
            groups.map(([turn, evs]) => {
              const isLive = turn === liveTurn;
              const focused = turn === viewTurn;
              return (
                <div
                  key={turn}
                  data-feed-turn={turn}
                  className="cogui-fv-group"
                  style={{ borderLeftColor: focused ? "var(--cogui-accent)" : "transparent" }}
                >
                  <div className="cogui-fv-turnhead">
                    <span className="cogui-fv-turnnum" style={{ color: focused ? "var(--cogui-accent)" : "#e9ebf1" }}>
                      {phaseWord.toUpperCase()} {turn}
                    </span>
                    <div className="cogui-fv-pips">
                      {phases.map((ph, pi) => {
                        let bg: string;
                        if (turn < liveTurn) bg = "color-mix(in srgb, var(--cogui-accent) 50%, transparent)";
                        else if (pi < currentPhaseIndex) bg = "color-mix(in srgb, var(--cogui-accent) 50%, transparent)";
                        else if (pi === currentPhaseIndex) bg = "var(--cogui-accent)";
                        else bg = "#2a2e3a";
                        return <span key={ph.id} className="cogui-fv-pip" style={{ background: bg }} title={ph.label} />;
                      })}
                    </div>
                    {isLive && (
                      <span className="cogui-fv-live">
                        <span className="cogui-fv-livedot" />
                        LIVE
                      </span>
                    )}
                    {focused && !isLive && <span className="cogui-fv-viewing">VIEWING</span>}
                    <span className="cogui-spacer" />
                    <span className="cogui-fv-summary">
                      {evs.length} {evs.length === 1 ? "event" : "events"}
                    </span>
                  </div>

                  <div className="cogui-fv-events">
                    {evs.map((e) => {
                      const ember = e.type === "say" && e.whisper;
                      const accentNode = e.type === "move" || e.type === "score";
                      const nodeColor = ember ? "var(--cogui-ember)" : accentNode ? "var(--cogui-accent)" : "#aeb3bf";
                      const nodeBg = ember
                        ? "color-mix(in srgb, var(--cogui-ember) 14%, transparent)"
                        : accentNode
                          ? "color-mix(in srgb, var(--cogui-accent) 14%, transparent)"
                          : "#1a1d26";
                      const nodeBorder = ember
                        ? "color-mix(in srgb, var(--cogui-ember) 45%, transparent)"
                        : accentNode
                          ? "color-mix(in srgb, var(--cogui-accent) 45%, transparent)"
                          : "#2a2e3a";
                      const tagColor = ember ? "var(--cogui-ember)" : accentNode ? "var(--cogui-accent)" : "#9aa0ad";
                      const tagBg = ember
                        ? "color-mix(in srgb, var(--cogui-ember) 12%, transparent)"
                        : accentNode
                          ? "color-mix(in srgb, var(--cogui-accent) 12%, transparent)"
                          : "#1a1d26";
                      const sw = e.type === "move" ? 3 : e.type === "score" ? 2.2 : 2;
                      return (
                        <div key={e.id} className="cogui-fv-ev">
                          <div className="cogui-fv-rail">
                            <span
                              className="cogui-fv-node"
                              style={
                                e.icon != null
                                  ? { background: "#1a1d26", borderColor: "#2a2e3a" }
                                  : { background: nodeBg, borderColor: nodeBorder, color: nodeColor }
                              }
                            >
                              {e.icon != null ? (
                                <span style={{ fontSize: "12px", lineHeight: 1 }}>{e.icon}</span>
                              ) : (
                                <svg
                                  width="11"
                                  height="11"
                                  viewBox="0 0 24 24"
                                  fill={e.type === "event" ? "currentColor" : "none"}
                                  stroke={e.type === "event" ? "none" : "currentColor"}
                                  strokeWidth={sw}
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  {NODE_ICON[e.type]}
                                </svg>
                              )}
                            </span>
                            <span className="cogui-fv-connector" />
                          </div>
                          <div className="cogui-fv-evbody">
                            <div className="cogui-fv-evline">
                              <span className="cogui-fv-actor" style={{ color: e.actor ? e.actorColor : "#7c8090" }}>
                                {e.actor || "System"}
                              </span>
                              <span className="cogui-fv-text">{e.text}</span>
                              {e.delta != null && (
                                <span className="cogui-fv-delta">{e.delta}</span>
                              )}
                            </div>
                            {e.detail && <div className="cogui-fv-detail">{e.detail}</div>}
                            <div className="cogui-fv-meta">
                              <span className="cogui-fv-tag" style={{ color: tagColor, background: tagBg }}>
                                {tagFor(e)}
                              </span>
                              {e.phase && <span className="cogui-fv-phase">{e.phase}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
