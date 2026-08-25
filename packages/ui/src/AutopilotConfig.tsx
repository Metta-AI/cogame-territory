// AutopilotConfig — the autopilot popover floated from the GameTopBar's gear
// (ported from the "Game Top Bar" design). Collapsed it is a compact card: the
// model and the active guidance, plus a "Configure & review reasoning" button.
// Expanded it widens into an "Autopilot console" with two tabs:
//   • Reasoning      — the per-turn observation → decision log, read straight off
//                      the seat's ActPromptWire transcripts (newest first).
//   • Prompt library — saved guidance presets for this game; click Use to load one
//                      into the active guidance, Save preset to keep the current
//                      one, Delete to drop a custom preset. The library is local
//                      session state (optionally persisted via `libraryKey`).
// The on/off toggle lives on the bar, not here; the header just reflects state.
// Guidance edits are debounced (~450ms) so we don't POST on every keystroke.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActPromptWire } from "@cogweb/protocol";

const GUIDANCE_DEBOUNCE_MS = 450;

export interface AutopilotPreset {
  name: string;
  text: string;
  /** User-created (deletable); seeded presets are not. */
  custom?: boolean;
}

export interface AutopilotConfigProps {
  /** Whether autopilot is currently on (header state line only). */
  on: boolean;
  /** Dismiss the popover. */
  onClose: () => void;
  model: string;
  models: string[];
  onSetModel: (model: string) => void;
  guidance: string;
  onGuidance: (text: string) => void;
  /** This seat's act-prompt transcripts (newest last); drives the Reasoning tab. */
  prompts: ActPromptWire[];
  /** Phase word for the reasoning turn labels ("Turn" / "Round"). */
  phaseWord?: string;
  /** Seeded prompt-library presets for this game. Omit to hide the library tab. */
  presets?: AutopilotPreset[];
  /** When set, the library (seeds + saved customs) persists under this localStorage key. */
  libraryKey?: string;
  /** Freeze every edit (e.g. while reviewing a past turn). */
  readOnly?: boolean;
  /** "Take the next move myself" — hand this one move back to the human. */
  onStepIn?: () => void;
}

interface ReasoningEntry {
  id: string;
  turnLabel: string;
  phase: string | null;
  move: string;
  observation: string;
  decision: string;
  /** The seat played its baseline fallback (LLM errored / no model decision). */
  fallback: boolean;
}

/** One-line summary of a decision for the collapsed reasoning row. Strips the
 *  outer JSON braces/quotes a structured response carries and trims to a glance. */
function summarize(decision: string): string {
  const firstLine = decision.split("\n").find((l) => l.trim().length > 0) ?? decision;
  const cleaned = firstLine.replace(/^[\s{["']+|[\s}\],"']+$/g, "").trim();
  return cleaned.length > 90 ? `${cleaned.slice(0, 89)}…` : cleaned || "decision";
}

export function AutopilotConfig({
  on,
  onClose,
  model,
  models,
  onSetModel,
  guidance,
  onGuidance,
  prompts,
  phaseWord = "Turn",
  presets,
  libraryKey,
  readOnly = false,
  onStepIn,
}: AutopilotConfigProps) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"reasoning" | "library">("reasoning");
  const [openEntries, setOpenEntries] = useState<Record<string, boolean>>({});

  // Debounced guidance (mirrors AutopilotPanel): adopt server-sent guidance unless
  // the user is mid-edit; flush a pending edit on unmount.
  const [draft, setDraft] = useState(guidance);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(guidance);
  }, [guidance]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const editGuidance = (text: string): void => {
    setDraft(text);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dirty.current = false;
      onGuidance(text);
    }, GUIDANCE_DEBOUNCE_MS);
  };

  // Prompt library: seed from `presets`, persist customs under `libraryKey`.
  const [customs, setCustoms] = useState<AutopilotPreset[]>(() => {
    if (!libraryKey || typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(libraryKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AutopilotPreset[]) : [];
  });
  const persistCustoms = (next: AutopilotPreset[]): void => {
    setCustoms(next);
    if (libraryKey && typeof localStorage !== "undefined") localStorage.setItem(libraryKey, JSON.stringify(next));
  };
  const library = useMemo(() => [...(presets ?? []), ...customs], [presets, customs]);
  const saveCurrent = (): void => {
    const text = draft.trim();
    if (!text || library.some((p) => p.text === text)) return;
    persistCustoms([...customs, { name: `Custom ${customs.length + 1}`, text, custom: true }]);
  };

  const reasoning: ReasoningEntry[] = useMemo(
    () =>
      [...prompts].reverse().map((p, i) => {
        const last = p.attempts[p.attempts.length - 1];
        const observation = last?.prompt ?? "";
        const decision = last?.response ?? "";
        return {
          id: `${p.turn}-${p.seat}-${i}`,
          turnLabel: `${phaseWord} ${p.turn}`,
          phase: p.phase,
          move: decision.trim() ? summarize(decision) : p.usedFallback ? "baseline fallback" : "no decision",
          observation,
          decision,
          fallback: p.usedFallback,
        };
      }),
    [prompts, phaseWord],
  );

  return (
    <div className={`cogui-apc${expanded ? " is-expanded" : ""}`} data-testid="autopilot-config">
      <div className="cogui-apc-head">
        <span className="cogui-apc-icon">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </span>
        <span className="cogui-apc-title">{expanded ? "Autopilot console" : "Autopilot"}</span>
        <span className={`cogui-apc-state${on ? " is-on" : ""}`}>{on ? "On" : "Off"}</span>
        <span className="cogui-spacer" />
        {expanded && (
          <button type="button" className="cogui-apc-expand" title="Collapse" onClick={() => setExpanded(false)}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 3H3v6" />
              <path d="M15 21h6v-6" />
              <path d="M3 3l7 7" />
              <path d="M21 21l-7-7" />
            </svg>
          </button>
        )}
        <button type="button" className="cogui-apc-close" aria-label="close autopilot" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="cogui-apc-body">
        {/* settings column */}
        <div className="cogui-apc-settings cogui-tbscroll">
          <div>
            <div className="cogui-apc-label">Model</div>
            <select
              className="cogui-apc-select"
              value={model}
              onChange={(e) => onSetModel(e.target.value)}
              disabled={readOnly}
              aria-label="autopilot model"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="cogui-apc-labelrow">
              <span className="cogui-apc-label">{expanded ? "Active guidance" : "Guidance"}</span>
              <span className="cogui-spacer" />
              {expanded && presets && (
                <button type="button" className="cogui-apc-save" onClick={saveCurrent} disabled={readOnly}>
                  ＋ Save preset
                </button>
              )}
            </div>
            <textarea
              className="cogui-apc-guidance"
              value={draft}
              onChange={(e) => editGuidance(e.target.value)}
              placeholder="Steer your autopilot — tone, strategy, red lines."
              readOnly={readOnly}
              rows={expanded ? 5 : 2}
              data-testid="apc-guidance"
            />
          </div>

          {!expanded && (
            <button
              type="button"
              className="cogui-apc-expandbtn"
              onClick={() => setExpanded(true)}
              data-testid="apc-expand"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" />
                <line x1="9" y1="8" x2="15" y2="8" />
                <line x1="17" y1="16" x2="23" y2="16" />
              </svg>
              Configure &amp; review reasoning
            </button>
          )}
          {expanded && onStepIn && (
            <button type="button" className="cogui-apc-stepbtn" onClick={onStepIn} disabled={readOnly}>
              Take the next move myself
            </button>
          )}
        </div>

        {/* expanded: reasoning + prompt library */}
        {expanded && (
          <div className="cogui-apc-console">
            <div className="cogui-apc-consolehead">
              <div className="cogui-apc-tabs">
                <button
                  type="button"
                  className={`cogui-apc-tab${tab === "reasoning" ? " is-on" : ""}`}
                  onClick={() => setTab("reasoning")}
                >
                  Reasoning
                </button>
                {presets && (
                  <button
                    type="button"
                    className={`cogui-apc-tab${tab === "library" ? " is-on" : ""}`}
                    onClick={() => setTab("library")}
                  >
                    Prompt library
                  </button>
                )}
              </div>
            </div>

            {tab === "reasoning" && (
              <div className="cogui-apc-scroll cogui-tbscroll" data-testid="apc-reasoning">
                {reasoning.length === 0 ? (
                  <p className="cogui-fd-empty">No decisions yet.</p>
                ) : (
                  reasoning.map((r) => {
                    const open = openEntries[r.id] ?? false;
                    return (
                      <div key={r.id} className="cogui-apc-entry">
                        <button
                          type="button"
                          className="cogui-apc-entry-head"
                          onClick={() => setOpenEntries((s) => ({ ...s, [r.id]: !open }))}
                        >
                          <span className="cogui-apc-turn">{r.turnLabel}</span>
                          {r.phase && <span className="cogui-apc-ephase">{r.phase}</span>}
                          <span className="cogui-apc-move">{r.move}</span>
                          <span className="cogui-apc-caret">{open ? "–" : "+"}</span>
                        </button>
                        {open && (
                          <div className="cogui-apc-detail">
                            <div>
                              <div className="cogui-apc-sublabel">Observation</div>
                              <div className="cogui-apc-obs">{r.observation}</div>
                            </div>
                            <div className="cogui-apc-dec">
                              <div className="cogui-apc-sublabel">Decision</div>
                              {r.decision.trim() ? (
                                <div className="cogui-apc-dectext">{r.decision}</div>
                              ) : (
                                <div className="cogui-apc-dectext cogui-apc-nodecision">
                                  {r.fallback
                                    ? "Played the baseline move — the autopilot fell back (LLM error or no model credentials)."
                                    : "No model decision was recorded for this turn."}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {tab === "library" && presets && (
              <div className="cogui-apc-scroll cogui-tbscroll" data-testid="apc-library">
                <div className="cogui-apc-libhint">
                  Saved prompts for this game. Click one to load it into active guidance, then edit on the left.
                </div>
                {library.map((p, i) => {
                  const active = p.text === draft;
                  const customIdx = i - (presets?.length ?? 0);
                  return (
                    <div key={`${p.name}-${i}`} className={`cogui-apc-librow${active ? " is-active" : ""}`}>
                      <div className="cogui-apc-libmain">
                        <div className="cogui-apc-libtop">
                          <span className="cogui-apc-libname">{p.name}</span>
                          {active && <span className="cogui-apc-libactive">ACTIVE</span>}
                        </div>
                        <div className="cogui-apc-libtext">{p.text}</div>
                      </div>
                      <div className="cogui-apc-libbtns">
                        <button
                          type="button"
                          className="cogui-apc-use"
                          onClick={() => editGuidance(p.text)}
                          disabled={readOnly}
                        >
                          Use
                        </button>
                        {p.custom && (
                          <button
                            type="button"
                            className="cogui-apc-del"
                            onClick={() => persistCustoms(customs.filter((_, j) => j !== customIdx))}
                            disabled={readOnly}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
