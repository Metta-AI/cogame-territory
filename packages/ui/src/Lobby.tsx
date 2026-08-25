// Lobby — the shared, game-agnostic pre-game roster. It renders a @cogweb/protocol
// `LobbyState` and drives every mutation through a single `send(msg: ClientMessage)`
// prop, so a game wires it up by handing it the lobby frame and its websocket
// sender. Seat management (add/remove/clear), claiming a seat ("Sit"), filling one
// with a bot, copyable per-seat join links, per-seat bot steering, and Start/Reset
// all ride the wire contract. Game-specific shape arrives via opt-in render props:
// `seatLabel` (role/team labels instead of "#N"), `joinNameFor` (the name a seat is
// claimed with), and `models` (turns on a per-seat model dropdown + guidance box).
// A fixed-roster game (minPlayers === maxPlayers) hides Add/Remove automatically.
// Themeable via the cogui-* classes.
import { useState } from "react";
import type { ReactNode } from "react";
import type { ClientMessage, LobbyState, SeatInfo } from "@cogweb/protocol";
import { seatStatusOf, lobbyCanStart, type RunStatus } from "@cogweb/protocol";
import { SeatStatusBadge } from "./SeatStatusBadge";
import { AutoAdvanceSettings } from "./AutoAdvanceSettings";

export interface LobbyProps {
  /** The latest lobby frame to render. */
  lobby: LobbyState;
  /** Live run status, folded into each seat's indicator (null pre-game). */
  run?: RunStatus | null;
  /** Send a client message to the table (typically a websocket sender). */
  send: (msg: ClientMessage) => void;
  /** Roster bounds, surfaced from the game module so Add/Remove disable at the edges.
   *  When `minPlayers === maxPlayers` the roster is fixed and Add/Remove are hidden. */
  minPlayers: number;
  maxPlayers: number;
  /** Origin used to build per-seat join links; defaults to the page origin. */
  baseUrl?: string;
  /** Per-seat display label, replacing the default "#N" (e.g. seat => "Red Spymaster").
   *  Return styled JSX to carry per-seat identity (team colour, role, …). */
  seatLabel?: (seat: SeatInfo) => ReactNode;
  /** The name a seat is claimed with when an operator hits "Sit" (default: the typed
   *  name, else "Seat N"). A role-structured game derives it from the seat. When set,
   *  the free-text name field is hidden (the name comes from the seat, not the typist). */
  joinNameFor?: (seat: SeatInfo) => string;
  /** When provided, bot seats gain a model dropdown (this list) and a guidance box so
   *  autopilots can be steered from the lobby. Omitted → no per-seat bot editing here. */
  models?: string[];
}

/** Build the shareable per-seat join link: opening it pre-fills the seat + token. */
function joinLink(baseUrl: string, seat: SeatInfo): string {
  return `${baseUrl}/?seat=${seat.seat}&token=${seat.joinToken}`;
}

export function Lobby({ lobby, run = null, send, minPlayers, maxPlayers, baseUrl, seatLabel, joinNameFor, models }: LobbyProps) {
  const [name, setName] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  // Which bot seats have their guidance editor expanded (toggled by the gear icon).
  const [guidanceOpen, setGuidanceOpen] = useState<Set<number>>(() => new Set());
  const origin = baseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");

  const toggleGuidance = (seat: number): void =>
    setGuidanceOpen((open) => {
      const next = new Set(open);
      if (next.has(seat)) next.delete(seat);
      else next.add(seat);
      return next;
    });

  const fixedRoster = minPlayers === maxPlayers;
  const atMax = lobby.seats.length >= maxPlayers;
  const atMin = lobby.seats.length <= minPlayers;
  const live = lobby.phase !== "lobby";
  // Start is enabled only when every seat is filled and ready (the same gate the
  // server enforces). An empty or partially-filled table cannot start.
  const canStart = lobbyCanStart(lobby, minPlayers);

  const copyJoinLink = (seat: SeatInfo): void => {
    void navigator.clipboard.writeText(joinLink(origin, seat));
    setCopied(seat.seat);
    setTimeout(() => setCopied((s) => (s === seat.seat ? null : s)), 1500);
  };

  return (
    <div className="cogui-lobby" data-testid="lobby" data-phase={lobby.phase}>
      <div className="cogui-lobby-head">
        <span className="cogui-lobby-title">{lobby.gameId}</span>
        <span className="cogui-lobby-count">
          {lobby.seats.length}/{maxPlayers} seats
        </span>
        <span className="cogui-spacer" />
        {!fixedRoster && (
          <button
            type="button"
            className="cogui-btn"
            data-testid="add-seat"
            disabled={live || atMax}
            onClick={() => send({ type: "addSeat" })}
          >
            + Add player
          </button>
        )}
      </div>

      <div className="cogui-lobby-seats">
        {lobby.seats.map((seat) => {
          const status = seatStatusOf(seat, run);
          const canCopy = seat.kind === "open" || seat.kind === "human";
          // Fold the seat's actual model into the offered list so a model the server
          // is running but the client doesn't list still shows as selected.
          const modelList =
            models && seat.bot?.model && !models.includes(seat.bot.model) ? [seat.bot.model, ...models] : models;
          return (
            <div
              key={seat.seat}
              className="cogui-lobby-seat"
              data-testid={`lobby-seat-${seat.seat}`}
              data-kind={seat.kind}
            >
              <div className="cogui-lobby-seat-row">
                <span className="cogui-lobby-seat-label">
                  {seatLabel ? seatLabel(seat) : <span className="cogui-lobby-seat-no cogui-mono">#{seat.seat}</span>}
                </span>
                {seat.kind === "open" ? (
                  <span className="cogui-lobby-seat-name">(open)</span>
                ) : (
                  <input
                    type="text"
                    className="cogui-lobby-seat-name-input"
                    data-testid={`name-${seat.seat}`}
                    value={seat.name}
                    disabled={live}
                    aria-label={`name for seat ${seat.seat}`}
                    onChange={(e) => send({ type: "setName", seat: seat.seat, name: e.target.value })}
                  />
                )}
                <SeatStatusBadge status={status} />

                {modelList && seat.kind === "bot" && (
                  <>
                    <select
                      className="cogui-lobby-model"
                      data-testid={`model-${seat.seat}`}
                      aria-label="model"
                      value={seat.bot?.model ?? modelList[0] ?? ""}
                      disabled={live}
                      onChange={(e) => send({ type: "setModel", seat: seat.seat, model: e.target.value })}
                    >
                      {modelList.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={`cogui-btn cogui-icon-btn${(seat.bot?.guidance ?? "").trim() ? " is-set" : ""}`}
                      data-testid={`guidance-toggle-${seat.seat}`}
                      aria-label="bot guidance"
                      aria-expanded={guidanceOpen.has(seat.seat)}
                      title={(seat.bot?.guidance ?? "").trim() ? "Edit bot guidance (set)" : "Add bot guidance"}
                      onClick={() => toggleGuidance(seat.seat)}
                    >
                      ⚙
                    </button>
                  </>
                )}

                <span className="cogui-spacer" />

                {seat.kind === "open" && (
                  <button
                    type="button"
                    className="cogui-btn"
                    data-testid={`sit-${seat.seat}`}
                    disabled={live}
                    onClick={() =>
                      send({
                        type: "join",
                        name: joinNameFor ? joinNameFor(seat) : name || `Seat ${seat.seat}`,
                        seat: seat.seat,
                      })
                    }
                  >
                    Sit
                  </button>
                )}

                {seat.kind !== "bot" && (
                  <button
                    type="button"
                    className="cogui-btn"
                    data-testid={`add-bot-${seat.seat}`}
                    disabled={live}
                    onClick={() => send({ type: "addBot", seat: seat.seat, model: null })}
                  >
                    + Bot
                  </button>
                )}

                {seat.kind === "bot" && (
                  <button
                    type="button"
                    className="cogui-btn"
                    data-testid={`clear-${seat.seat}`}
                    disabled={live}
                    onClick={() => send({ type: "clearSeat", seat: seat.seat })}
                  >
                    Bot→Human
                  </button>
                )}

                {canCopy && (
                  <button
                    type="button"
                    className="cogui-btn"
                    data-testid={`copy-${seat.seat}`}
                    title="Copy a join link that claims this seat"
                    onClick={() => copyJoinLink(seat)}
                  >
                    {copied === seat.seat ? "Copied!" : "Copy join link"}
                  </button>
                )}

                {!fixedRoster && (
                  <button
                    type="button"
                    className="cogui-btn"
                    data-testid={`remove-${seat.seat}`}
                    disabled={live || atMin}
                    title={atMin ? `Table can't go below ${minPlayers} seats` : "Remove this seat"}
                    onClick={() => send({ type: "removeSeat", seat: seat.seat })}
                  >
                    Remove
                  </button>
                )}
              </div>

              {modelList && seat.kind === "bot" && guidanceOpen.has(seat.seat) && (
                <textarea
                  className="cogui-lobby-guidance"
                  data-testid={`guidance-${seat.seat}`}
                  rows={2}
                  placeholder="Guidance — steer this bot…"
                  value={seat.bot?.guidance ?? ""}
                  disabled={live}
                  onChange={(e) => send({ type: "setGuidance", seat: seat.seat, guidance: e.target.value })}
                />
              )}
            </div>
          );
        })}
      </div>

      <AutoAdvanceSettings config={lobby.autoAdvance} send={send} disabled={live} />

      <div className="cogui-lobby-foot">
        {!joinNameFor && (
          <input
            className="cogui-lobby-name"
            data-testid="lobby-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            aria-label="your name"
          />
        )}
        <span className="cogui-spacer" />
        <button
          type="button"
          className="cogui-btn"
          data-testid="start"
          disabled={live || !canStart}
          title={canStart ? "Start the game" : "Fill every seat (and ready up) to start"}
          onClick={() => send({ type: "start" })}
        >
          Start game
        </button>
        <button
          type="button"
          className="cogui-btn"
          data-testid="reset"
          onClick={() => send({ type: "reset" })}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
