// SeatStatusBadge — the shared per-seat indicator ported from cognames' per-player
// tabs (a team-colored dot that pulses ember while the table waits on that seat,
// steady otherwise). It renders one @cogweb/protocol `SeatStatus` as a dot + label;
// the `thinking` dot pulses so a spectator sees who the table is waiting on. Every
// game gets the same indicator on its roster cards and lobby seat rows.
import type { SeatStatus } from "@cogweb/protocol";

/** Human label for each status, shown beside the dot. */
const LABELS: Record<SeatStatus, string> = {
  open: "Open",
  disconnected: "Disconnected",
  joined: "Joined",
  ready: "Ready",
  waiting: "Waiting",
  acting: "Up",
  thinking: "Thinking",
};

export interface SeatStatusBadgeProps {
  status: SeatStatus;
  /** Hide the text label, leaving just the dot (compact roster cards / tabs). */
  dotOnly?: boolean;
}

export function SeatStatusBadge({ status, dotOnly = false }: SeatStatusBadgeProps) {
  return (
    <span
      className={`cogui-seat-status is-${status}`}
      data-status={status}
      data-testid="seat-status"
      title={LABELS[status]}
    >
      <span className="cogui-seat-dot" />
      {!dotOnly && <span className="cogui-seat-label">{LABELS[status]}</span>}
    </span>
  );
}
