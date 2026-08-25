// AutopilotPanel — the shared control for one LLM-piloted seat: an on/off
// toggle, a model dropdown, a guidance textarea (debounced ~450ms so we don't
// POST on every keystroke), a live status line, and a collapsible "what the
// model saw & decided" accordion over the seat's ActPromptWire transcripts
// (each showing its attempts + the fallback flag). `readOnly` freezes every
// edit — used when the board is scrubbed off the live head.
import { useEffect, useRef, useState } from "react";
import type { ActPromptWire } from "@cogweb/protocol";

const GUIDANCE_DEBOUNCE_MS = 450;

export interface AutopilotPanelProps {
  on: boolean;
  thinking: boolean;
  /** This seat is the pending actor but its pilot has not begun yet — the table is
   *  about to wait on it. Surfaced distinctly from `thinking` (mid-composition). */
  acting?: boolean;
  finished: boolean;
  guidance: string;
  onGuidance: (text: string) => void;
  model: string;
  models: string[];
  onSetModel: (model: string) => void;
  /** Toggle autopilot on/off. Omit to render the toggle disabled (display-only). */
  onToggle?: () => void;
  /** Act-prompt transcripts for this seat, newest last. */
  prompts: ActPromptWire[];
  /** Freeze every edit (e.g. viewing a past turn). */
  readOnly?: boolean;
  placeholder?: string;
}

export function AutopilotPanel({
  on,
  thinking,
  acting = false,
  finished,
  guidance,
  onGuidance,
  model,
  models,
  onSetModel,
  onToggle,
  prompts,
  readOnly = false,
  placeholder = "Guidance — steers every decision this seat makes.",
}: AutopilotPanelProps) {
  const [draft, setDraft] = useState(guidance);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  // Adopt server-sent guidance unless the user is mid-edit (debounce pending).
  useEffect(() => {
    if (!dirty.current) setDraft(guidance);
  }, [guidance]);

  // Flush any pending debounce on unmount so a fast close doesn't drop an edit.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const editGuidance = (text: string): void => {
    setDraft(text);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dirty.current = false;
      onGuidance(text);
    }, GUIDANCE_DEBOUNCE_MS);
  };

  let statusText: string;
  let statusClass: string;
  if (!on) {
    statusText = "Off — manual control.";
    statusClass = "is-off";
  } else if (finished) {
    statusText = "Game over.";
    statusClass = "is-off";
  } else if (thinking) {
    statusText = "● Thinking — querying the model…";
    statusClass = "is-thinking";
  } else if (acting) {
    statusText = "● Up — composing the next move…";
    statusClass = "is-thinking";
  } else {
    statusText = "Active — autopilot is steering.";
    statusClass = "is-active";
  }

  const recent = [...prompts].slice(-12).reverse();

  return (
    <div className={`cogui-autopilot${on ? " is-on" : ""}`} data-testid="autopilot">
      <div className="cogui-ap-head">
        <span className="cogui-ap-title">Autopilot</span>
        <select
          className="cogui-ap-model"
          value={model}
          onChange={(e) => onSetModel(e.target.value)}
          disabled={readOnly}
          aria-label="autopilot model"
          title="Model that drives this seat's autopilot"
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="cogui-spacer" />
        <button
          type="button"
          className={`cogui-switch${on ? " on" : ""}`}
          aria-label="toggle autopilot"
          aria-pressed={on}
          disabled={readOnly || !onToggle}
          onClick={onToggle}
        >
          <span className="cogui-knob" />
        </button>
      </div>

      <textarea
        className="cogui-ap-guidance"
        data-testid="guidance"
        value={draft}
        onChange={(e) => editGuidance(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        rows={3}
      />

      <div className={`cogui-ap-status ${statusClass}`}>{statusText}</div>

      {recent.length > 0 && (
        <div className="cogui-ap-transcript" data-testid="transcript">
          <div className="cogui-ap-transcript-label">What the model saw &amp; decided</div>
          {recent.map((p, i) => (
            <details key={`${p.turn}-${p.seat}-${i}`} className="cogui-ap-entry">
              <summary>
                <span className="cogui-mono">T{p.turn}</span>
                {p.phase ? ` · ${p.phase}` : ""} decision
                {p.usedFallback && <span className="cogui-ap-fallback"> · fallback</span>}
              </summary>
              {p.attempts.map((a, j) => (
                <div key={j} className="cogui-ap-attempt">
                  <div className="cogui-ap-attempt-head">
                    attempt {j + 1}
                    {a.error && <span className="cogui-ap-error"> · rejected: {a.error}</span>}
                  </div>
                  <pre className="cogui-ap-prompt">{a.prompt}</pre>
                  <pre className="cogui-ap-response">{a.response}</pre>
                </div>
              ))}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
