// PhaseIndicator — a game-agnostic strip of phase chips for the TopBar (the
// agricogla stage strip / cogherence phase strip, generalized). The game owns the
// phase vocabulary: it passes the ordered `phases` and the `current` one, and the
// strip renders each chip as done (already passed), current (the live phase, glowing
// accent), or upcoming. State is opaque JSON to the platform, so the game maps its
// own state to these labels — the strip only knows order + which one is now.
export interface PhaseStep {
  /** Stable id matched against `current`. */
  id: string;
  /** Human label shown on the chip. */
  label: string;
}

export interface PhaseIndicatorProps {
  /** The full phase sequence, in order. */
  phases: PhaseStep[];
  /** Id of the phase the game is currently in. Unknown ids leave every chip upcoming. */
  current: string;
}

export function PhaseIndicator({ phases, current }: PhaseIndicatorProps) {
  const curIdx = phases.findIndex((p) => p.id === current);
  return (
    <div className="cogui-phases" data-testid="phases">
      {phases.map((ph, i) => {
        const state = curIdx < 0 || i > curIdx ? "upcoming" : i < curIdx ? "done" : "current";
        return (
          <span
            key={ph.id}
            className={`cogui-phase is-${state}`}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            {ph.label}
          </span>
        );
      })}
    </div>
  );
}
