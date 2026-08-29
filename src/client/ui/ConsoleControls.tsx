// ConsoleControls — the right-hand strip for the GameTopBar's `trailing` slot: the
// playback badge and, on a RECORDING, the transport (a play/pause toggle plus the
// 0.5× / 1× / 2× speed chips). A LIVE console has no playback to steer, so it shows
// the connection badge alone.
//
// The chips and the toggle live HERE, in the game block, not in the shared chrome:
// `packages/ui/src/**` is byte-pinned by chrome-manifest.test.ts, so every Territory
// affordance is appended into the `trailing` slot instead of edited into the chrome.
import React from "react";
import type { ServerStatus } from "../../shared/protocol";

/** The offered playback rates, in order. 1 is the default; the dwell between
 *  snapshots is PLAYBACK_MS / speed, so 0.5 is half speed. */
const SPEEDS = [0.5, 1, 2] as const;

export function ConsoleControls({
  status,
  live,
  playing,
  onTogglePlay,
  speed,
  onSpeed,
}: {
  status: ServerStatus | null;
  /** True for a live socket; false for a recording. */
  live: boolean;
  /** Replay only: whether playback is running. */
  playing: boolean;
  onTogglePlay: () => void;
  /** Replay only: the current playback rate, one of SPEEDS. */
  speed: number;
  onSpeed: (speed: number) => void;
}): React.ReactElement {
  return (
    <>
      {!live && (
        <button
          type="button"
          className="cg-tbtn"
          onClick={onTogglePlay}
          data-testid="playtoggle"
          data-tip={playing ? "pause playback (Space)" : "resume playback (Space)"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
      )}
      {!live && (
        <span className="cg-tspeed" data-testid="speedchips">
          {SPEEDS.map((rate) => (
            <button
              key={rate}
              type="button"
              className={`cg-tchip${rate === speed ? " on" : ""}`}
              onClick={() => onSpeed(rate)}
              data-testid={`speed-${rate}`}
              data-active={rate === speed ? "1" : "0"}
              data-tip={`play at ${rate}× speed`}
            >
              {rate}×
            </button>
          ))}
        </span>
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
