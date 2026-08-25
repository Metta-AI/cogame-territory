// PlayerRoster<P> — one selectable card per player. The component owns the card
// chrome, name, selection highlight, and click-to-select; the GAME supplies the
// player's score and status via `renderScore`/`renderStatus`. It only needs each
// player to expose an `id` and `name`.
//
// `statusOf` is the game-agnostic shortcut ported from cognames: map a player to a
// @cogweb/protocol `SeatStatus` (via `seatStatusOf`) and the roster renders the
// shared pulsing-dot indicator — the card also pulses ember while that seat is the
// one the table is waiting on (thinking), so spectators see who is up at a glance.
import type { ReactNode } from "react";
import type { SeatStatus } from "@cogweb/protocol";
import { SeatStatusBadge } from "./SeatStatusBadge";

/** Minimal shape a player must satisfy; games extend it freely. */
export interface RosterPlayer {
  id: string | number;
  name: string;
}

export interface PlayerRosterProps<P extends RosterPlayer> {
  players: P[];
  selectedId?: string | number;
  onSelect?: (p: P) => void;
  /** Score slot for a player (e.g. hearts, points). */
  renderScore?: (p: P) => ReactNode;
  /** Custom status slot. Takes precedence over `statusOf` when both are given. */
  renderStatus?: (p: P) => ReactNode;
  /** The shared per-seat indicator: map a player to its live `SeatStatus` and the
   *  roster renders a pulsing-dot badge + highlights the seat being waited on. */
  statusOf?: (p: P) => SeatStatus;
}

export function PlayerRoster<P extends RosterPlayer>({
  players,
  selectedId,
  onSelect,
  renderScore,
  renderStatus,
  statusOf,
}: PlayerRosterProps<P>) {
  return (
    <div className="cogui-roster" data-testid="roster">
      {players.map((p) => {
        const selected = p.id === selectedId;
        const dimmed = selectedId !== undefined && !selected;
        const status = statusOf?.(p);
        const statusNode = renderStatus?.(p) ?? (status && <SeatStatusBadge status={status} />);
        const waiting = status === "acting" || status === "thinking";
        return (
          <button
            key={p.id}
            type="button"
            className={`cogui-roster-card${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}${
              status === "thinking" ? " is-thinking" : ""
            }${waiting ? " is-waiting-on" : ""}`}
            aria-pressed={selected}
            data-testid={`roster-${p.id}`}
            data-status={status}
            onClick={() => onSelect?.(p)}
          >
            <span className="cogui-roster-name">{p.name}</span>
            {statusNode && <span className="cogui-roster-status">{statusNode}</span>}
            {renderScore && <span className="cogui-roster-score">{renderScore(p)}</span>}
          </button>
        );
      })}
    </div>
  );
}
