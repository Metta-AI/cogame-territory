// ConsoleControls — the right-hand strip for the GameTopBar's `trailing` slot: the
// playback badge and, on a LIVE console only, the transport toggle. In replay mode
// (`replayUrl !== null`) the console shows NO operator affordances: a hosted
// replay is a recording, not a table you can steer.
import React from "react";
import type { ServerStatus } from "../../shared/protocol";

export function ConsoleControls({
  status,
  live,
  playing,
  onTogglePlay,
}: {
  status: ServerStatus | null;
  /** True for a live socket; false for a recording. */
  live: boolean;
  /** Replay only: whether playback is running. */
  playing: boolean;
  onTogglePlay: () => void;
}): React.ReactElement {
  return (
    <>
      {!live && (
        <button
          type="button"
          className="cg-tbtn"
          onClick={onTogglePlay}
          data-testid="playtoggle"
          data-tip={playing ? "pause playback" : "resume playback"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
      )}
      {live ? (
        <span className="conn conn-live" data-testid="live-badge">
          ● live{status?.ended ? " · over" : ""}
        </span>
      ) : (
        <span className="cg-live cg-replay" data-testid="replay-badge">
          ▷ REPLAY
        </span>
      )}
    </>
  );
}
