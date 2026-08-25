// AutoAdvanceSettings — the pre-game (lobby) auto-advance panel: a toggle for the
// clock and a max-time field (the per-seat decision budget). It reads the lobby's
// config (LobbyState.autoAdvance) and sends `setAutoAdvance` / `setMaxTime` over
// the @cogweb/protocol wire. The shared <Lobby> renders it automatically; a game
// with its own lobby (e.g. cognames) can drop it in directly. The default is
// derived server-side (off once a human is seated); toggling here pins it.
import type { ClientMessage } from "@cogweb/protocol";

export interface AutoAdvanceSettingsProps {
  /** The lobby's current auto-advance config (from LobbyState.autoAdvance). */
  config: { enabled: boolean; maxTimeMs: number };
  /** Send a client message to the table (typically the websocket sender). */
  send: (msg: ClientMessage) => void;
  /** Lock the inputs once the table is live (only the in-game toggle applies then). */
  disabled?: boolean;
}

export function AutoAdvanceSettings({ config, send, disabled }: AutoAdvanceSettingsProps) {
  const seconds = Math.round(config.maxTimeMs / 1000);
  return (
    <div className="cogui-aa-settings" data-testid="autoadvance-settings">
      <label className="cogui-aa-row">
        <input
          type="checkbox"
          data-testid="autoadvance-enable"
          checked={config.enabled}
          disabled={disabled}
          onChange={(e) => send({ type: "setAutoAdvance", on: e.target.checked })}
        />
        <span className="cogui-aa-label">Auto-advance turns</span>
      </label>
      <label className="cogui-aa-row cogui-aa-maxtime" title="Seconds a seat has to act before the turn auto-advances">
        <span className="cogui-aa-label">Max time</span>
        <input
          type="number"
          className="cogui-aa-secs"
          data-testid="autoadvance-maxtime"
          min={1}
          max={600}
          value={seconds}
          disabled={disabled || !config.enabled}
          onChange={(e) => {
            const s = Number(e.target.value);
            if (Number.isFinite(s) && s > 0) send({ type: "setMaxTime", ms: Math.round(s * 1000) });
          }}
        />
        <span className="cogui-aa-unit">s</span>
      </label>
    </div>
  );
}
