// The per-seat console (`/client/player?slot=N`, and `/seat/N`). It is NOT
// reachable from the replay page — but it must keep BUILDING and the route must
// keep answering 200: the certifier's HTTP contract check probes
// `GET /client/player` and `GET /client/global` BEFORE any player pod starts, and
// a 404 on either fails the episode (lantern 0.1.1).
//
// Everything it shows is spectator-side: the same public snapshot, focused on one
// seat, plus that seat's autopilot transcript. Nothing here is ever fed back to a
// model.
import React from "react";
import type { GameSnapshot } from "../../shared/snapshot";
import type { Message } from "../../shared/messages";
import type { ActPromptFrame, StampedEvent } from "../net/feed";
import { policyName, seatAlias, seatColor } from "../colors";
import { CGIcon, Swatch } from "../cg/atoms";
import { Channels } from "../cg/panels";
import { ResizableColumns } from "../cg/ResizableColumns";
import { BoardPanel } from "./BoardPanel";
import { homeRingKeys, perTick, tileKey } from "../cg/derive";

function SeatCard({ snapshot, seat }: { snapshot: GameSnapshot; seat: number }): React.ReactElement {
  const cog = snapshot.cogs.find((c) => c.seat === seat);
  const mine = snapshot.tiles.filter((t) => t.owner === seat);
  const ring = homeRingKeys(snapshot, seat);
  const held = mine.filter((t) => ring.has(tileKey(t.q, t.r))).length;
  return (
    <div className="cg-panel" data-testid="seat-card">
      <div className="cg-panel-head">
        <span className="cg-panel-title">
          <Swatch seat={seat} /> {seatAlias(seat)}
        </span>
        <span className="cg-mono cg-panel-note">{policyName(seat) || `seat ${seat}`}</span>
      </div>
      <div className="cg-panel-body cg-col-gap">
        {!cog ? (
          <div className="cg-mono cg-quiet">no such seat in this episode.</div>
        ) : (
          <>
            <div className="cg-seatstat">
              <span className="cg-label">score</span>
              <span className="cg-num" style={{ color: seatColor(seat) }}>
                {cog.banked}
              </span>
            </div>
            <div className="cg-mono cg-seatline">
              paint {cog.paint} · walls {cog.walls} · income {cog.incomeLastTurn}/turn (
              {perTick(cog.incomeLastTurn, snapshot.ticksPerTurn)}/tick) · razes {cog.razesMade}
            </div>
            <div className="cg-mono cg-seatline">
              home ring: {held} of {ring.size} coordinates still held
              {cog.life === "staggered" && <b style={{ color: "var(--stagger)" }}> · STAGGERED</b>}
              {cog.life === "eliminated" && (
                <b style={{ color: "var(--raze)" }}>
                  {" "}
                  <CGIcon name="skull" size={12} /> ELIMINATED
                </b>
              )}
            </div>
            <div className="cg-mono cg-seatline">
              fallbacks so far: {cog.fallbacks}
              {cog.fallbacks > 0 && <span className="cg-quiet"> (a fallback turn was not a thought)</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Transcript({ prompts }: { prompts: ActPromptFrame[] }): React.ReactElement {
  const shown = prompts.slice(-6).reverse();
  return (
    <div className="cg-panel cg-flex" data-testid="transcript">
      <div className="cg-panel-head">
        <span className="cg-panel-title">What the model saw</span>
        <span className="cg-mono cg-panel-note">{shown[0]?.model ?? "scripted"}</span>
      </div>
      <div className="cg-panel-body cg-scroll cg-col-gap">
        {shown.length === 0 && <div className="cg-mono cg-quiet">no transcript in this replay.</div>}
        {shown.map((p, i) => (
          <div key={i} className="cg-transcript">
            <div className="cg-mono cg-transcript-head">
              T{String(p.turn).padStart(2, "0")}
              {p.usedFallback && <b style={{ color: "var(--raze)" }}> · FALLBACK</b>}
            </div>
            <pre className="cg-mono cg-transcript-body">{p.content}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CogView({
  snapshot,
  seat,
  events,
  messages,
  prompts,
  onSeekTurn,
}: {
  snapshot: GameSnapshot;
  seat: number;
  events: StampedEvent[];
  messages: Message[];
  prompts: ActPromptFrame[];
  onSeekTurn?: (turn: number) => void;
}): React.ReactElement {
  return (
    <div className="cg-view cg-seatview" data-testid="seat-view">
      <ResizableColumns
        storageKey="territory.cols.seat"
        defaultLeft={306}
        defaultRight={330}
        left={
          <div className="cg-col">
            <SeatCard snapshot={snapshot} seat={seat} />
            <Channels messages={messages} onSeekTurn={onSeekTurn} />
          </div>
        }
        center={<BoardPanel snapshot={snapshot} events={events} highlight={seat} />}
        right={
          <div className="cg-col">
            <Transcript prompts={prompts} />
          </div>
        }
      />
    </div>
  );
}
