// Spectator (hero broadcast): a three-column stage — the income-per-tick
// leaderboard (#scorebug) and the wars-started ledger (#feed) on the left, the
// lattice in the centre, the turn log and the talk channels on the right. The side
// columns are drag-resizable; at <= 640px the CSS drops the whole thing to one
// stacked column.
import React, { useState } from "react";
import type { GameSnapshot } from "../../shared/snapshot";
import type { Message } from "../../shared/messages";
import type { StampedEvent } from "../net/feed";
import { Channels, TurnLog } from "../cg/panels";
import { ResizableColumns } from "../cg/ResizableColumns";
import { BoardPanel } from "./BoardPanel";
import { ScoreBug } from "./ScoreBug";
import { WarLedger } from "./WarLedger";
import { lastResolvedTurn } from "../cg/derive";

export function GlobalView({
  snapshot,
  events,
  messages,
  onSeekTurn,
}: {
  snapshot: GameSnapshot;
  events: StampedEvent[];
  messages: Message[];
  onSeekTurn?: (turn: number) => void;
}): React.ReactElement {
  // Clicking a scorebug plate spotlights that seat's territory on the board.
  const [focus, setFocus] = useState<number | null>(null);
  const toggleFocus = (seat: number): void => setFocus((f) => (f === seat ? null : seat));
  return (
    <div className="cg-view cg-spectator" data-testid="global-view">
      <ResizableColumns
        storageKey="territory.cols.spectator"
        defaultLeft={306}
        defaultRight={330}
        left={
          <div className="cg-col">
            <ScoreBug snapshot={snapshot} focus={focus} onToggleFocus={toggleFocus} />
            <WarLedger events={events} turn={lastResolvedTurn(snapshot)} />
          </div>
        }
        center={<BoardPanel snapshot={snapshot} events={events} highlight={focus} />}
        right={
          <div className="cg-col">
            <TurnLog snapshot={snapshot} events={events} />
            <Channels messages={messages} onSeekTurn={onSeekTurn} />
          </div>
        }
      />
    </div>
  );
}
