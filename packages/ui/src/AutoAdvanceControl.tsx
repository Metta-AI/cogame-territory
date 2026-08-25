// AutoAdvanceControl — the in-game auto-advance surface: an ON/OFF toggle plus a
// live countdown to the moment the acting seat will be moved on. It speaks only
// the @cogweb/protocol wire: it reads RunStatus.{autoAdvance,deadline} and sends
// a `setAutoAdvance` toggle. Drop it in a game's TopBar (or near the scrubber).
// "Auto" = the table keeps moving on the clock; "Manual" = it waits for the seat.
import { useEffect, useState } from "react";
import type { ClientMessage, RunStatus } from "@cogweb/protocol";

export interface AutoAdvanceControlProps {
  /** Live run status (carries `autoAdvance` and the `deadline` to count down to). */
  status: RunStatus | null;
  /** Send a client message to the table (typically the websocket sender). */
  send: (msg: ClientMessage) => void;
}

export function AutoAdvanceControl({ status, send }: AutoAdvanceControlProps) {
  // Re-render a few times a second so the countdown ticks down. We compare against
  // the server's absolute `deadline`, so a missed tick or small clock skew never
  // drifts the displayed value.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, []);

  if (!status) return null;
  const on = status.autoAdvance;
  const remainingMs = on && status.deadline !== null ? Math.max(0, status.deadline - now) : null;

  return (
    <div className="cogui-aa-control" data-testid="autoadvance-control" data-on={on}>
      <button
        type="button"
        className="cogui-aa-btn"
        data-testid="autoadvance-toggle"
        aria-pressed={on}
        title={
          on
            ? "Auto-advance is on — a turn advances when its timer runs out. Click to wait for players."
            : "Auto-advance is off — the table waits for each player. Click to advance turns on a timer."
        }
        onClick={() => send({ type: "setAutoAdvance", on: !on })}
      >
        {on ? "⏱ Auto" : "⏸ Manual"}
      </button>
      {remainingMs !== null && (
        <span className="cogui-aa-count" data-testid="autoadvance-countdown" aria-live="off">
          {Math.ceil(remainingMs / 1000)}s
        </span>
      )}
    </div>
  );
}
