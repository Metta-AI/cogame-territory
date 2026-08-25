// SeatBar<P> — the same seat roster as PlayerRoster, but laid out as a horizontal
// strip of compact tabs meant to live in a TopBar (the agricogla/cognames pattern:
// one tab per seat across the header, click to focus that seat's view). It shares
// PlayerRoster's data contract (id/name + the slotted score/status/`statusOf`) so a
// game can swap the vertical roster for the top strip without rewiring its props.
//
// On top of that it carries live-control affordances ported from agricogla: each
// tab shows whether the seat is a human or a bot, marks the seat the viewer is
// driving with a "YOU" pill, and right-clicks open a menu to take over a bot seat
// (`onControl`) or hand a controlled seat back to its AI (`onObserve`). A seat held
// by another human is never offered for takeover.
//
// The same menu is the single home for a seat's autopilot: when `autopilotFor`
// returns props for a seat, the menu gains an "Autopilot" item that floats that
// seat's AutopilotPanel in a popover. This is why a game no longer drops a
// standalone AutopilotPanel onto the board — per-seat autopilot lives here.
import { useState, type ReactNode } from "react";
import type { SeatStatus } from "@cogweb/protocol";
import type { RosterPlayer } from "./PlayerRoster";
import { SeatStatusBadge } from "./SeatStatusBadge";
import { AutopilotPanel, type AutopilotPanelProps } from "./AutopilotPanel";

/** How a seat is currently piloted, for the human/bot indicator + menu actions. */
export type SeatPilotKind = "human" | "bot" | "open";

export interface SeatBarProps<P extends RosterPlayer> {
  players: P[];
  selectedId?: string | number;
  onSelect?: (p: P) => void;
  /** Score slot for a seat (e.g. hearts, points), shown after the name. */
  renderScore?: (p: P) => ReactNode;
  /** Custom status slot. Takes precedence over `statusOf` when both are given. */
  renderStatus?: (p: P) => ReactNode;
  /** The shared per-seat indicator: map a seat to its live `SeatStatus` and the bar
   *  renders a pulsing-dot badge + highlights the seat being waited on. */
  statusOf?: (p: P) => SeatStatus;
  /** The seat the current viewer is driving by hand; rendered with a "YOU" pill. */
  controllingId?: string | number;
  /** Per-seat pilot kind, for the human/bot marker and which menu actions apply. */
  pilotOf?: (p: P) => SeatPilotKind;
  /** Right-click a bot seat → "Control this seat" (take over to drive by hand). */
  onControl?: (p: P) => void;
  /** Right-click the seat you control → "Observe — release to AI". */
  onObserve?: (p: P) => void;
  /** Per-seat autopilot props, or null when the seat has no autopilot (open/human).
   *  When non-null, the seat's right-click menu gains an "Autopilot" item that opens
   *  that seat's AutopilotPanel in a popover — the single home for autopilot. */
  autopilotFor?: (p: P) => AutopilotPanelProps | null;
  /** Freeze the right-click menu (e.g. while reviewing a past turn). */
  menuDisabled?: boolean;
}

interface MenuState {
  id: string | number;
  x: number;
  y: number;
}

export function SeatBar<P extends RosterPlayer>({
  players,
  selectedId,
  onSelect,
  renderScore,
  renderStatus,
  statusOf,
  controllingId,
  pilotOf,
  onControl,
  onObserve,
  autopilotFor,
  menuDisabled = false,
}: SeatBarProps<P>) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [panel, setPanel] = useState<MenuState | null>(null);
  const menuEnabled = !menuDisabled && (!!onControl || !!onObserve || !!autopilotFor);

  return (
    <div className="cogui-seatbar" data-testid="seatbar" role="tablist">
      {players.map((p) => {
        const selected = p.id === selectedId;
        const dimmed = selectedId !== undefined && !selected;
        const status = statusOf?.(p);
        const statusNode = renderStatus?.(p) ?? (status && <SeatStatusBadge status={status} dotOnly />);
        const waiting = status === "acting" || status === "thinking";
        const mine = controllingId !== undefined && p.id === controllingId;
        const pilot = pilotOf?.(p);
        // The 🤖 indicator doubles as a shortcut: clicking it opens that seat's
        // autopilot popover directly (the right-click menu's "Autopilot…" still works).
        const canOpenAutopilot = !menuDisabled && pilot === "bot" && !!autopilotFor?.(p);
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            className={`cogui-seat-tab${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}${
              status === "thinking" ? " is-thinking" : ""
            }${waiting ? " is-waiting-on" : ""}${mine ? " is-controlling" : ""}`}
            aria-selected={selected}
            data-testid={`seat-tab-${p.id}`}
            data-status={status}
            data-pilot={pilot}
            onClick={() => onSelect?.(p)}
            onContextMenu={
              menuEnabled
                ? (e) => {
                    e.preventDefault();
                    setMenu({ id: p.id, x: e.clientX, y: e.clientY });
                  }
                : undefined
            }
            title={menuEnabled ? "right-click for seat actions (autopilot / control)" : undefined}
          >
            {mine ? (
              <span className="cogui-seat-you" title="you are controlling this seat">
                YOU
              </span>
            ) : pilot && pilot !== "open" ? (
              <span
                className={`cogui-seat-pilot is-${pilot}${canOpenAutopilot ? " is-clickable" : ""}`}
                title={canOpenAutopilot ? "open autopilot" : pilot === "bot" ? "autopilot" : "human player"}
                onClick={
                  canOpenAutopilot
                    ? (e) => {
                        e.stopPropagation();
                        setPanel({ id: p.id, x: e.clientX, y: e.clientY });
                      }
                    : undefined
                }
              >
                {pilot === "bot" ? "🤖" : "🧑"}
              </span>
            ) : null}
            {statusNode && <span className="cogui-seat-tab-status">{statusNode}</span>}
            <span className="cogui-seat-tab-name">{p.name}</span>
            {renderScore && <span className="cogui-seat-tab-score">{renderScore(p)}</span>}
          </button>
        );
      })}

      {menu &&
        (() => {
          const p = players.find((x) => x.id === menu.id);
          if (!p) return null;
          const mine = controllingId !== undefined && p.id === menu.id;
          const pilot = pilotOf?.(p);
          const hasAutopilot = !!autopilotFor?.(p);
          const canObserve = mine && !!onObserve;
          const canControl = !mine && pilot === "bot" && !!onControl;
          const close = (): void => setMenu(null);
          return (
            <>
              <div
                className="cogui-seatmenu-scrim"
                onClick={close}
                onContextMenu={(e) => {
                  e.preventDefault();
                  close();
                }}
              />
              <div
                className="cogui-seatmenu"
                style={{ left: Math.min(menu.x, window.innerWidth - 200), top: menu.y }}
                data-testid="seatmenu"
              >
                <div className="cogui-seatmenu-head">{p.name}</div>
                {hasAutopilot && (
                  <button
                    type="button"
                    className="cogui-seatmenu-item"
                    data-testid="seatmenu-autopilot"
                    onClick={() => {
                      setPanel(menu);
                      close();
                    }}
                  >
                    Autopilot…
                  </button>
                )}
                {canObserve && (
                  <button
                    type="button"
                    className="cogui-seatmenu-item"
                    onClick={() => {
                      onObserve!(p);
                      close();
                    }}
                  >
                    Observe — release to AI
                  </button>
                )}
                {canControl && (
                  <button
                    type="button"
                    className="cogui-seatmenu-item"
                    onClick={() => {
                      onControl!(p);
                      close();
                    }}
                  >
                    Control this seat
                  </button>
                )}
                {!hasAutopilot && !canObserve && !canControl && (
                  <div className="cogui-seatmenu-note">Controlled by a player</div>
                )}
              </div>
            </>
          );
        })()}

      {panel &&
        (() => {
          const p = players.find((x) => x.id === panel.id);
          const ap = p ? autopilotFor?.(p) ?? null : null;
          if (!p || !ap) return null;
          const close = (): void => setPanel(null);
          return (
            <>
              <div
                className="cogui-seatmenu-scrim"
                onClick={close}
                onContextMenu={(e) => {
                  e.preventDefault();
                  close();
                }}
              />
              <div
                className="cogui-seat-appop"
                style={{
                  left: Math.max(8, Math.min(panel.x, window.innerWidth - 360)),
                  top: Math.max(8, Math.min(panel.y, window.innerHeight - 80)),
                }}
                data-testid="seat-autopilot-popover"
              >
                <div className="cogui-seat-appop-head">
                  <span className="cogui-seat-appop-name">{p.name}</span>
                  <button
                    type="button"
                    className="cogui-seat-appop-close"
                    aria-label="close autopilot"
                    onClick={close}
                  >
                    ×
                  </button>
                </div>
                <AutopilotPanel {...ap} />
              </div>
            </>
          );
        })()}
    </div>
  );
}
