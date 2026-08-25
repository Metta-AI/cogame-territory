// FinalScorePanel — the shared end-of-game score panel every game shows on its
// synthetic FINAL turn (the 🏁 tile <GameScrubberBar> appends after the last
// snapshot). It is NOT a modal: there is no scrim and no close button. It fills
// the game's board region (`position:absolute; inset:0` over a relative <main>),
// so the top bar and the scrubber stay visible — you scrub one tick back to the
// final board and back to FINAL to see the score, no special dismiss UI. It owns
// the reusable chrome (the "Final scoring" heading, the headline result line, and
// a primary "Play again"); the game supplies only its own score breakdown as
// `children` (a category table, a ranking, …) and the headline `summary`. Theming
// comes from the cogui-* / --cogui-accent tokens the game already sets.
import type { ReactNode } from "react";

export interface FinalScorePanelProps {
  /** Panel heading. Default "Final scoring". */
  title?: string;
  /** The headline result line, e.g. "Alice wins with 26 points after 14 rounds." */
  summary: ReactNode;
  /** The game-specific score body: a breakdown table, a ranking list, etc. */
  children: ReactNode;
  /** Start a fresh game. */
  onPlayAgain: () => void;
  /** Label for the primary action. Default "Play again". */
  playAgainLabel?: ReactNode;
}

export function FinalScorePanel({
  title = "Final scoring",
  summary,
  children,
  onPlayAgain,
  playAgainLabel = "Play again",
}: FinalScorePanelProps) {
  return (
    <div className="cogui-fs" data-testid="final-score-panel">
      <div className="cogui-fs-panel">
        <div className="cogui-fs-head">
          <h2 className="cogui-fs-title">{title}</h2>
        </div>
        <p className="cogui-fs-summary">{summary}</p>
        <div className="cogui-fs-body">{children}</div>
        <button type="button" className="cogui-fs-again" data-testid="play-again" onClick={onPlayAgain}>
          {playAgainLabel}
        </button>
      </div>
    </div>
  );
}
