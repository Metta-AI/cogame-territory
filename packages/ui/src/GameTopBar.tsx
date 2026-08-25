// GameTopBar — the unified in-game top bar every cogame mounts above its board
// (ported from the "Game Top Bar" claude.ai/design handoff). It replaces each
// game's hand-rolled header: a game-identity logo button with a dropdown menu
// (Feed view / Kick player / Return to lobby), the live roster as compact chips
// (name + a "YOU" / "SIT" / "KICK" tag + a fixed-width status slot that shows a
// spinning cog while the seat is thinking or a check once it has moved + the
// seat's score), a Comms button (with an unread badge, or a greyed "Comms off"
// chip when a game disables chat), and your-seat controls (autopilot toggle +
// a gear that opens the config popover) — or, when spectating, a "Take a seat"
// button.
//
// It is a controlled, slotted component: every datum and callback is a prop, so
// it speaks no game state directly. `status` is the @cogweb/protocol SeatStatus
// so the same chip serves every game. The feed drawer / autopilot popover are
// passed in via `overlay` and floated over the board with a scrim — mount the
// bar as the FIRST child of a `position: relative` console so they anchor below
// the bar.
import { useState, type ReactNode } from "react";
import type { SeatStatus } from "@cogweb/protocol";

export interface GameTopBarPlayer {
  /** Stable key (e.g. the seat's agent id). */
  id: string | number;
  name: string;
  /** Live per-seat status: `thinking` spins the cog; every other state shows a
   *  ready check. Drives the fixed-width status slot so the chip never resizes. */
  status: SeatStatus;
  /** This is the viewer's seat: an accent ring + a "YOU" tag + accent score. */
  isYou?: boolean;
  /** Optional name color — for intrinsic team coloring (e.g. Cognames RED/BLUE).
   *  Games are otherwise told apart by their logo, not color. */
  nameColor?: string;
  /** Fully-rendered score (e.g. `14♥`, colorable by the game). */
  score?: ReactNode;
  /** Tooltip (e.g. the seat's team + role). */
  title?: string;
  /** Observer pick-a-seat mode: render a dashed "SIT" tag + make the chip a claim
   *  button. The game sets this on the seats a spectator may take. */
  claimable?: boolean;
  onClaim?: () => void;
  /** Kick mode: render a red "KICK" tag + make the chip a kick button. The game
   *  sets this on the seats the operator may kick (never the viewer's own seat). */
  kickable?: boolean;
  onKick?: () => void;
  /** Inspect mode: when set, and the chip is neither claimable nor kickable,
   *  clicking the chip invokes this — the game opens a per-seat detail (e.g.
   *  Cognames reveals an operative's persona). Lower priority than claim/kick. */
  onSelect?: () => void;
}

export interface GameTopBarProps {
  /** Game identity. When `wordmark` is given (a game's styled brand lockup) it
   *  replaces the square logo box + the `name` text — the wordmark already carries
   *  the name. Otherwise the logo (`logoSrc`, or an empty badge) + `name` render.
   *  `phaseLine` is the compact phase/turn line shown beside the identity. */
  game: { name: string; logoSrc?: string; wordmark?: ReactNode; phaseLine?: ReactNode };
  /** Game chrome controls. `onFeedView` is the board ⇄ feed view switcher — a
   *  DISTINCT top-bar button (a game-display toggle), kept out of the logo menu so
   *  it doesn't sit beside navigation. `onKick` / `onReturnToLobby` are the logo
   *  dropdown's operator + navigation items; the logo is a plain (non-clickable)
   *  badge when neither is given (or `menu` is omitted). */
  menu?: {
    onFeedView?: () => void;
    /** When true, the feed overlay is open: the toggle reads "Game view" (a board
     *  icon) and `onFeedView` is expected to CLOSE the feed — i.e. a toggle. */
    feedOpen?: boolean;
    onKick?: () => void;
    onReturnToLobby?: () => void;
  };
  /** The live roster, left → right. */
  players: GameTopBarPlayer[];
  /** Comms (negotiation feed) control. `disabled` renders a greyed "Comms off"
   *  chip (no drawer, no unread) for games that turn chat off (e.g. Cognames). */
  comms?: { disabled?: boolean; unread?: number; open: boolean; onToggle: () => void };
  /** Your-seat autopilot control, shown when you hold a seat. */
  autopilot?: { on: boolean; onToggle: () => void; onConfigure: () => void };
  /** Spectator control, shown when you do not hold a seat: a "Take a seat" button.
   *  `picking` flips the label to "Pick a seat ↑" while a seat is being chosen. */
  observer?: { onTakeSeat: () => void; picking?: boolean; label?: string };
  /** A single floating overlay (the feed drawer or the autopilot config popover),
   *  rendered over the board with a dismiss scrim. Null hides it. */
  overlay?: ReactNode;
  /** Invoked when the overlay scrim is clicked (dismiss the overlay). */
  onCloseOverlay?: () => void;
  /** Extra content rendered in the LEFT cluster, between the game identity and the
   *  roster (e.g. a view switcher / extra nav). Most games omit it. */
  leading?: ReactNode;
  /** Extra content rendered at the END of the RIGHT cluster, after comms/autopilot
   *  (e.g. clocks, an operator menu, a live badge). Most games omit it. */
  trailing?: ReactNode;
}

const ICON = {
  caret: <path d="M6 9l6 6 6-6" />,
  feed: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  ),
  kick: (
    <>
      <circle cx="9" cy="7" r="4" />
      <path d="M3 21v-2a4 4 0 0 1 4-4h4" />
      <line x1="17" y1="8" x2="22" y2="13" />
      <line x1="22" y1="8" x2="17" y2="13" />
    </>
  ),
  lobby: (
    <>
      <path d="M3 12l9-9 9 9" />
      <path d="M9 21V12h6v9" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  board: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
} as const;

function Svg({ size, sw, children }: { size: number; sw: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function Chip({ p }: { p: GameTopBarPlayer }) {
  const thinking = p.status === "thinking";
  const pickMode = !!p.claimable;
  const kickMode = !!p.kickable;
  const selectable = !pickMode && !kickMode && !!p.onSelect;
  const onClick = kickMode ? p.onKick : pickMode ? p.onClaim : p.onSelect;
  const checkColor = p.isYou ? "var(--cogui-accent)" : p.status === "disconnected" ? "#e0533c" : "#5f8f78";
  const cls = [
    "cogui-gtb-chip",
    thinking ? "is-thinking" : "",
    p.isYou ? "is-you" : "",
    pickMode ? "is-pick" : "",
    kickMode ? "is-kick" : "",
    selectable ? "is-selectable" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} title={p.title} onClick={onClick} data-testid={`gtb-chip-${p.id}`} data-status={p.status}>
      <span className="cogui-gtb-chip-name" style={p.nameColor ? { color: p.nameColor } : undefined}>
        {p.name}
      </span>
      {pickMode && <span className="cogui-gtb-tag is-sit">SIT</span>}
      {kickMode && <span className="cogui-gtb-tag is-kick">KICK</span>}
      {p.isYou && <span className="cogui-gtb-tag is-you">YOU</span>}
      <span className="cogui-gtb-statusslot">
        {thinking ? (
          <span className="cogui-gtb-cog" title="thinking…">
            <Svg size={13} sw={2.2}>
              {ICON.gear}
            </Svg>
          </span>
        ) : (
          <span className="cogui-gtb-check" style={{ color: checkColor }} title="ready">
            <Svg size={13} sw={3}>
              {ICON.check}
            </Svg>
          </span>
        )}
      </span>
      {p.score !== undefined && <span className="cogui-gtb-score">{p.score}</span>}
    </div>
  );
}

export function GameTopBar({
  game,
  menu,
  players,
  comms,
  autopilot,
  observer,
  overlay,
  onCloseOverlay,
  leading,
  trailing,
}: GameTopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // The logo dropdown is now navigation/operator-only — the feed-view switcher is a
  // separate button, so the logo is clickable only when there's a nav/kick action.
  const menuable = !!menu && (!!menu.onKick || !!menu.onReturnToLobby);
  const run = (fn?: () => void): void => {
    setMenuOpen(false);
    fn?.();
  };

  return (
    <>
      <header className="cogui-gtb" data-testid="game-topbar">
        {/* left: game identity + menu */}
        <div className="cogui-gtb-identity">
          <button
            type="button"
            className={`cogui-gtb-logo${game.wordmark ? " has-wordmark" : ""}${menuable ? " is-menuable" : ""}${menuOpen ? " is-open" : ""}`}
            title={menuable ? "Game menu" : undefined}
            onClick={menuable ? () => setMenuOpen((o) => !o) : undefined}
            data-testid="gtb-logo"
          >
            {game.wordmark ? (
              <span className="cogui-gtb-wordmark">{game.wordmark}</span>
            ) : game.logoSrc ? (
              <img src={game.logoSrc} alt="" />
            ) : (
              <span aria-hidden />
            )}
            {menuable && (
              <span className="cogui-gtb-caret">
                <Svg size={8} sw={3}>
                  {ICON.caret}
                </Svg>
              </span>
            )}
          </button>
          <div className="cogui-gtb-id-text">
            {!game.wordmark && <span className="cogui-gtb-name">{game.name}</span>}
            {game.phaseLine !== undefined && <span className="cogui-gtb-phase">{game.phaseLine}</span>}
          </div>

          {menuOpen && (
            <>
              <div className="cogui-gtb-menu-scrim" onClick={() => setMenuOpen(false)} />
              <div className="cogui-gtb-menu" data-testid="gtb-menu">
                {menu?.onKick && (
                  <button type="button" className="cogui-gtb-menu-item" onClick={() => run(menu.onKick)}>
                    <Svg size={14} sw={2}>
                      {ICON.kick}
                    </Svg>
                    Kick player
                  </button>
                )}
                {menu?.onReturnToLobby && (
                  <>
                    <div className="cogui-gtb-menu-sep" />
                    <button type="button" className="cogui-gtb-menu-item" onClick={() => run(menu.onReturnToLobby)}>
                      <Svg size={14} sw={2}>
                        {ICON.lobby}
                      </Svg>
                      Return to lobby
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* board ⇄ feed view switcher — a distinct control, kept out of the logo's
            navigation dropdown so a game-display toggle never sits beside "Return
            to lobby". */}
        {menu?.onFeedView && (
          <button
            type="button"
            className={`cogui-gtb-viewtoggle${menu.feedOpen ? " is-on" : ""}`}
            onClick={menu.onFeedView}
            data-testid="gtb-viewtoggle"
            title={menu.feedOpen ? "Back to the game board" : "Open the full game feed"}
          >
            <Svg size={14} sw={2}>{menu.feedOpen ? ICON.board : ICON.feed}</Svg>
            {menu.feedOpen ? "Game view" : "Feed view"}
          </button>
        )}

        {leading}

        <div className="cogui-gtb-divider" />

        {/* center: live roster */}
        <div className="cogui-gtb-roster cogui-tbscroll" data-testid="gtb-roster">
          {players.map((p) => (
            <Chip key={p.id} p={p} />
          ))}
        </div>

        {/* right: comms + autopilot/observer */}
        <div className="cogui-gtb-right">
          {comms &&
            (comms.disabled ? (
              <div className="cogui-gtb-comms is-off" title="Comms are disabled in this game">
                <span style={{ position: "relative", display: "inline-flex" }}>
                  <Svg size={15} sw={2}>
                    {ICON.feed}
                    <line x1="2" y1="2" x2="22" y2="22" />
                  </Svg>
                </span>
                Comms off
              </div>
            ) : (
              <button
                type="button"
                className={`cogui-gtb-comms${comms.open ? " is-open" : ""}`}
                onClick={comms.onToggle}
                data-testid="gtb-comms"
              >
                <Svg size={15} sw={2}>
                  {ICON.feed}
                </Svg>
                Comms
                {!!comms.unread && comms.unread > 0 && <span className="cogui-gtb-unread">{comms.unread}</span>}
              </button>
            ))}

          {autopilot && (
            <div className={`cogui-gtb-auto${autopilot.on ? " is-on" : ""}`}>
              <button
                type="button"
                className="cogui-gtb-auto-toggle"
                onClick={autopilot.onToggle}
                aria-pressed={autopilot.on}
                data-state={autopilot.on ? "on" : "off"}
                title={
                  autopilot.on
                    ? "Autopilot is ON — click to take manual control of your seat"
                    : "Autopilot is OFF — click to let a bot play your seat"
                }
                data-testid="gtb-autopilot-toggle"
              >
                <span className="cogui-gtb-sw">
                  <span className="cogui-gtb-knob" />
                </span>
                Autopilot
                <span className="cogui-gtb-auto-state">{autopilot.on ? "ON" : "OFF"}</span>
              </button>
              <button
                type="button"
                className="cogui-gtb-auto-cfg"
                title="Configure autopilot"
                onClick={autopilot.onConfigure}
                data-testid="gtb-autopilot-config"
              >
                <Svg size={14} sw={2}>
                  {ICON.gear}
                </Svg>
              </button>
            </div>
          )}

          {observer && (
            <button
              type="button"
              className={`cogui-gtb-take${observer.picking ? " is-picking" : ""}`}
              onClick={observer.onTakeSeat}
              data-testid="gtb-take-seat"
            >
              {observer.label ?? (observer.picking ? "Pick a seat ↑" : "Take a seat")}
            </button>
          )}

          {trailing}
        </div>
      </header>

      {overlay && (
        <>
          <div className="cogui-gtb-scrim" onClick={onCloseOverlay} data-testid="gtb-overlay-scrim" />
          <div className="cogui-gtb-overlay">{overlay}</div>
        </>
      )}
    </>
  );
}
