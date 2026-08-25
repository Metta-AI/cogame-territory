// TopBar — the shared header chrome every cogame hangs its top strip on (the
// agricogla/cognames layout: brand + seat tabs on the left, the phase strip in the
// middle, round/turn/connection bits on the right). It is pure layout — three
// slots over a flex header — so a game composes it from the other primitives:
//
//   <TopBar
//     left={<><Brand /><SeatBar players={...} selectedId={view} onSelect={...} statusOf={...} /></>}
//     center={<PhaseIndicator phases={PHASES} current={state.phase} />}
//     right={<RoundReadout ... />}
//   />
//
// The center slot grows (flex:1), so with only `left`/`right` given it still pushes
// them to opposite ends like a normal app bar.
import type { ReactNode } from "react";

export interface TopBarProps {
  /** Leading slot — brand + the SeatBar of seat tabs. */
  left?: ReactNode;
  /** Growing middle slot — typically the PhaseIndicator. */
  center?: ReactNode;
  /** Trailing slot — round/turn readouts, connection dot, operator controls. */
  right?: ReactNode;
}

export function TopBar({ left, center, right }: TopBarProps) {
  return (
    <header className="cogui-topbar" data-testid="topbar">
      <div className="cogui-topbar-left">{left}</div>
      <div className="cogui-topbar-center">{center}</div>
      <div className="cogui-topbar-right">{right}</div>
    </header>
  );
}
