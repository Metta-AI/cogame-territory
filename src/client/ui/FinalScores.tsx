// THE ENDCARD — the panel that renders on the synthetic FINAL slot.
//
// Mounted INSIDE `.cg-stage` (never over the transport row, which is the local
// form of "the endcard stops at var(--band)"), and because it renders only while
// the playhead is on that slot, EVERY SEEK DISMISSES IT by construction.
//
// It shows the final scores, the reason (complete / elimination / deadline),
// walls destroyed, and `income pool 149 → 121 (−19 %)` — the deadweight loss in
// one line. Everything it needs comes off the `endcard` event, so the panel
// derives nothing.
import React from "react";
import { FinalScorePanel } from "@cogweb/ui";
import type { GameSnapshot } from "../../shared/snapshot";
import type { ClientTurnEvent } from "../../shared/protocol";
import { seatAlias, seatColor } from "../colors";
import { CGIcon, SeatName, Swatch } from "../cg/atoms";

type Endcard = Extract<ClientTurnEvent, { kind: "endcard" }>;

const REASON_TEXT: Record<Endcard["reason"], string> = {
  complete: "all turns played",
  elimination: "one Cog left standing",
  deadline: "settled on the wall clock",
};

export function FinalScores({
  snapshot,
  endcard,
  onReplay,
}: {
  snapshot: GameSnapshot;
  endcard: Endcard | null;
  /** Restart playback from the first frame (the panel's only affordance). */
  onReplay: () => void;
}): React.ReactElement {
  const scores = endcard?.scores ?? snapshot.cogs.map((c) => c.banked);
  const razes = snapshot.cogs.map((c) => c.razesMade);
  const poolStart = endcard?.poolStart ?? snapshot.poolStart;
  const poolEnd = endcard?.poolEnd ?? snapshot.poolEnd;
  const destroyed = endcard?.destroyed ?? snapshot.destroyed;
  const wars = endcard?.warsStarted ?? snapshot.warsStarted;
  const reason = endcard?.reason ?? snapshot.settled ?? "complete";
  const loss = poolStart > 0 ? Math.round(((poolStart - poolEnd) / poolStart) * 100) : 0;

  // Displayed tie-break (cosmetic; the ladder only sees the score):
  // higher score -> fewer razes committed -> lower seat index.
  const ranked = snapshot.cogs
    .map((c) => ({ ...c, score: scores[c.seat] ?? c.banked, razes: razes[c.seat] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.razes - b.razes || a.seat - b.seat);
  const top = ranked[0];
  const winners = ranked.filter((c) => c.score === (top?.score ?? 0));
  const summary = top
    ? `${winners.map((w) => seatAlias(w.seat)).join(" & ")} ${winners.length > 1 ? "tie" : "wins"} with ${top.score} paint earned — ${REASON_TEXT[reason]}.`
    : "no Cogs on the board.";

  return (
    <div className="cg-endcard" data-testid="endcard">
      <FinalScorePanel title="Final standings" summary={summary} onPlayAgain={onReplay} playAgainLabel="↻ Watch again">
        <div className="cg-endcard-rows">
          {ranked.map((c, i) => (
            <div
              key={c.seat}
              className={`cg-endcard-row is-${c.life}`}
              style={{ borderLeftColor: seatColor(c.seat) }}
            >
              <span className="cg-num cg-endcard-rank">{i + 1}</span>
              <Swatch seat={c.seat} />
              <SeatName seat={c.seat} />
              <span className="cg-mono cg-endcard-walls">▮×{c.walls}</span>
              <span className="cg-mono cg-endcard-razes">✖{c.razes}</span>
              {c.life === "eliminated" && <CGIcon name="skull" size={13} title="eliminated" />}
              <span className="cg-num cg-endcard-score" style={{ color: seatColor(c.seat) }}>
                {c.score}
              </span>
            </div>
          ))}
        </div>
        <div className="cg-endcard-loss" data-testid="endcard-loss">
          income pool {poolStart} → {poolEnd} ({loss >= 0 ? "−" : "+"}
          {Math.abs(loss)} %) · {destroyed} walls destroyed · {wars} wars started
        </div>
      </FinalScorePanel>
    </div>
  );
}
