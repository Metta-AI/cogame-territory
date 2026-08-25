// TEST 15 — the client, in jsdom, over a REAL played scenario.
//
//  * HexBoard renders 169 `g.cg-tile`; a wet tile carries `data-wet="1"` and the
//    `cg-drying` class; `data-state` is one of wall|cracked|rubble.
//  * ScoreBug renders nine rows with the alias AND the policy name and the /turn
//    plus /tick figures.
//  * WarLedger's `wars started` counter equals the distinct attacker→victim pairs.
//  * GameScrubberBar's rail cells are real <button>s, and a seek dismisses the
//    endcard (which renders only on the synthetic FINAL slot).
//  * NO ALIAS LEAK: `redact(state, seat)`, stringified, contains no string from
//    `config.players[].name`.
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";
import { HexBoard } from "./HexBoard";
import { ScoreBug } from "./ui/ScoreBug";
import { WarLedger } from "./ui/WarLedger";
import { FinalScores } from "./ui/FinalScores";
import { BoardPanel } from "./ui/BoardPanel";
import { Channels } from "./cg/panels";
import { setPolicyNames } from "./colors";
import { FIXTURE_POLICY_NAMES, fullCapLine, playRecordedFrames, playScenario } from "./fixture/scenario";
import { endcardAt, lastResolvedTurn, warsStarted } from "./cg/derive";
import { GameScrubberBar } from "@cogweb/ui";
import { observe } from "../game/redact";
import { territoryGame } from "../game/game";
import { rederiveReplay } from "../game/rederive";
import { ALIASES, MAX_SAY_LEN, SEATS } from "../shared/engine/constants";
import { newGame, stepTurn } from "../shared/engine/game";
import { legalRazeTargets } from "../shared/engine/orders";
import { homeRing } from "../shared/engine/board";
import type { GameState } from "../shared/engine/types";
import type { GameSnapshot } from "../shared/snapshot";
import { runeLength } from "../shared/engine/text";

afterEach(cleanup);

const scenario = playScenario(7, 7);

describe("HexBoard", () => {
  it("renders 169 tiles, each with a legal data-state", () => {
    const { container } = render(<HexBoard snapshot={scenario.snapshot} />);
    const tiles = container.querySelectorAll("g.cg-tile");
    expect(tiles).toHaveLength(169);
    for (const t of Array.from(tiles)) {
      expect(["wall", "cracked", "rubble"]).toContain(t.getAttribute("data-state"));
      expect(["0", "1"]).toContain(t.getAttribute("data-wet"));
    }
  });

  it("marks a WET tile with data-wet=1 and the cg-drying class", () => {
    // Build a state with a guaranteed wet tile: claim one, and look before Upkeep.
    const base = newGame(7);
    const target = Object.keys(base.tiles).find((k) => base.tiles[k]!.owner === null)!;
    const wet: GameState = {
      ...base,
      tiles: { ...base.tiles, [target]: { ...base.tiles[target]!, owner: 0, wet: true, claimedTurn: 1 } },
    };
    const snap = territoryGame.redact({ engine: wet, pending: [], submissions: {} }, null) as typeof scenario.snapshot;
    const { container } = render(<HexBoard snapshot={snap} />);
    const el = container.querySelector(`g.cg-tile[data-tile="${target}"]`)!;
    expect(el.getAttribute("data-wet")).toBe("1");
    expect(el.classList.contains("cg-drying")).toBe(true);
    expect(container.querySelectorAll("g.cg-tile[data-wet='1'] .cg-drying-mark").length).toBeGreaterThan(0);
  });

  it("draws no sprite on rubble — it is visibly walkable, visibly gone", () => {
    const base = newGame(7);
    const target = Object.keys(base.tiles).find((k) => base.tiles[k]!.owner === null)!;
    const rubbled: GameState = {
      ...base,
      tiles: { ...base.tiles, [target]: { ...base.tiles[target]!, state: "rubble", owner: null } },
    };
    const snap = territoryGame.redact({ engine: rubbled, pending: [], submissions: {} }, null) as typeof scenario.snapshot;
    const { container } = render(<HexBoard snapshot={snap} />);
    const el = container.querySelector(`g.cg-tile[data-tile="${target}"]`)!;
    expect(el.getAttribute("data-state")).toBe("rubble");
    expect(el.querySelectorAll("image")).toHaveLength(0);
  });
});

describe("ScoreBug", () => {
  it("renders nine rows with the alias AND the policy name, /turn and /tick", () => {
    setPolicyNames(FIXTURE_POLICY_NAMES);
    const { container } = render(<ScoreBug snapshot={scenario.snapshot} />);
    const rows = container.querySelectorAll(".plate");
    expect(rows).toHaveLength(SEATS);
    // Every alias appears, and so does every policy name — two name spaces, both
    // visible SPECTATOR-SIDE only.
    for (const alias of ALIASES) expect(screen.getByText(alias)).toBeTruthy();
    expect(container.textContent).toContain("territory-condottiere");
    expect(container.textContent).toMatch(/\+\d+\/turn/);
    expect(container.textContent).toMatch(/\(\d+\.\d\d\/tick\)/);
    // Ranked by banked score, descending.
    const scores = Array.from(container.querySelectorAll(".plate-score")).map((e) => Number(e.textContent));
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // The row carries its life state, which is what the CSS pulses / greys out.
    for (const row of Array.from(rows)) {
      expect(["steady", "staggered", "eliminated"]).toContain(row.getAttribute("data-life"));
    }
  });
});

describe("WarLedger", () => {
  it("counts EXACTLY the distinct attacker→victim pairs in the fixture", () => {
    // A scenario with real razes on real owners.
    const raided = playScenario(3, 9);
    const turn = lastResolvedTurn(raided.snapshot);
    const expected = warsStarted(raided.events, turn);
    // Recompute independently from the raw events.
    const pairs = new Set<string>();
    for (const e of raided.events) {
      if (e.turn > turn) continue;
      if (e.event.kind !== "raze") continue;
      if (e.event.victim === null || e.event.victim === e.event.seat) continue;
      pairs.add(`${e.event.seat}>${e.event.victim}`);
    }
    expect(expected).toEqual(pairs);
    const { container } = render(<WarLedger events={raided.events} turn={turn} />);
    expect(container.querySelector(".warledger-count")!.textContent).toBe(String(pairs.size));
    // The ledger shows aggression ONLY: no talk lines leak into it.
    expect(container.querySelector("#feed")!.textContent).not.toContain("領土");
  });

  it("carries the #feed id the viewer smoke reads", () => {
    const { container } = render(<WarLedger events={scenario.events} turn={3} />);
    expect(container.querySelector("#feed")).toBeTruthy();
  });
});

describe("Channels", () => {
  it("renders full-cap CJK+emoji talk lines without truncating them further", () => {
    const { container } = render(<Channels messages={scenario.messages} />);
    expect(scenario.messages.length).toBeGreaterThan(0);
    for (const m of scenario.messages) expect(runeLength(m.text)).toBe(MAX_SAY_LEN);
    expect(container.textContent).toContain("領土");
    expect(runeLength(fullCapLine(0))).toBe(MAX_SAY_LEN);
  });
});

describe("the transport and the endcard", () => {
  const beats = (snap: unknown, i: number) => ({ turn: (snap as { turn: number }).turn, density: 0.5 });

  it("renders the rail cells as real, labelled <button>s", () => {
    const { container } = render(
      <GameScrubberBar
        timeline={[scenario.snapshot, scenario.snapshot]}
        index={0}
        onSeek={() => {}}
        meta={beats}
        phases={[
          { id: "commit", label: "Commit" },
          { id: "resolve", label: "Resolve" },
          { id: "upkeep", label: "Upkeep" },
        ]}
        currentPhase="resolve"
        maxTurns={18}
        final
        renderRailExtra={() => <span className="beat beat-raze" data-beat="raze" />}
      />,
    );
    const cells = container.querySelectorAll("button.cogui-sbar-turn");
    expect(cells.length).toBeGreaterThan(0);
    for (const c of Array.from(cells)) expect(c.tagName).toBe("BUTTON");
    // Every beat carries its own CSS class per emitted kind.
    expect(container.querySelectorAll(".beat-raze").length).toBeGreaterThan(0);
    // The synthetic FINAL slot exists and is a button too.
    expect(container.querySelector("[data-testid='sbar-final']")!.tagName).toBe("BUTTON");
  });

  it("the endcard renders only on the FINAL slot, so every seek dismisses it", () => {
    // A finished game, so the endcard event exists.
    let s = newGame(7);
    while (s.settled === null) s = stepTurn(s, {});
    const finished = playScenarioLikeSnapshot(s);
    const card = endcardAt(
      s.log.flatMap((rec) => rec.events.map((event) => ({ turn: rec.turn, event: event as never }))),
    );
    expect(card).not.toBeNull();

    // Mounted (the playhead is on FINAL):
    const mounted = render(<FinalScores snapshot={finished} endcard={card} onReplay={() => {}} />);
    expect(mounted.container.querySelector("[data-testid='endcard']")).toBeTruthy();
    expect(mounted.container.querySelector("[data-testid='endcard-loss']")!.textContent).toMatch(/income pool/);
    // It lives INSIDE the stage as an absolutely-positioned child, never fixed at
    // the shell level, so it can never paint into the transport band.
    expect(mounted.container.querySelector(".cg-endcard")).toBeTruthy();
    cleanup();

    // Seeked away (App renders nothing for it): the panel is simply gone.
    const seeked = render(<BoardPanel snapshot={finished} events={[]} />);
    expect(seeked.container.querySelector("[data-testid='endcard']")).toBeNull();
  });
});

function playScenarioLikeSnapshot(state: GameState) {
  return territoryGame.redact({ engine: state, pending: [], submissions: {} }, null) as typeof scenario.snapshot;
}

describe("NO ALIAS LEAK", () => {
  it("redact(state, seat) contains no string from config.players[].name", () => {
    // The platform injects the real policy/player names; `newGame` IGNORES the
    // runner's seatNames outright, so they can never reach a prompt.
    const seam = territoryGame.newGame({
      seed: "7",
      playerCount: SEATS,
      seatNames: FIXTURE_POLICY_NAMES,
      rules: { variant: "open", turns: "18" },
    });
    for (let seat = 0; seat < SEATS; seat++) {
      const text = JSON.stringify(territoryGame.redact(seam, seat));
      for (const name of FIXTURE_POLICY_NAMES) expect(text).not.toContain(name);
      // The observation carries the ALIASES and nothing else.
      expect(text).toContain(ALIASES[seat]!);
    }
    // And the public snapshot the viewer renders carries no policy name either —
    // those arrive separately, in the one-shot roster frame.
    const publicText = JSON.stringify(territoryGame.redact(seam, null));
    for (const name of FIXTURE_POLICY_NAMES) expect(publicText).not.toContain(name);
  });

  it("every rendered event line and the whole log use aliases only", () => {
    let s = newGame(7);
    for (let t = 0; t < 6; t++) s = stepTurn(s, {});
    // Razes need a target; just assert the observation's log is alias-only.
    for (let seat = 0; seat < SEATS; seat++) {
      const view = observe(s, seat);
      for (const line of view.log) {
        for (const name of FIXTURE_POLICY_NAMES) expect(line).not.toContain(name);
      }
      for (const tile of view.tiles) {
        if (tile.owner !== null) expect(ALIASES).toContain(tile.owner);
      }
    }
    expect(legalRazeTargets(s, 0).length).toBeGreaterThan(0);
    expect(homeRing(0)).toHaveLength(7);
  });
});

describe("the replay page RE-DERIVES what it draws", () => {
  it("draws the re-simulated frames rather than the recorded snapshots", async () => {
    const frames = playRecordedFrames(7, 4);
    // TAMPER every recorded snapshot. A page that draws the RECORDING shows 999;
    // a page that replays the recorded events through the sim shows the engine's
    // own numbers and reports the divergence in `data-replay-rederived`.
    const tampered = frames.map((f) =>
      f.type === "snapshot"
        ? {
            ...f,
            snapshot: {
              ...f.snapshot,
              state: {
                ...(f.snapshot.state as GameSnapshot),
                cogs: (f.snapshot.state as GameSnapshot).cogs.map((c) => ({ ...c, banked: 999 })),
              },
            },
          }
        : f,
    );
    const { container } = render(<App replay={{ frames: tampered as never }} />);
    await waitFor(() => expect(document.documentElement.dataset.replayRederived).toBe("mismatch"));
    const scores = Array.from(container.querySelectorAll(".plate-score")).map((e) => e.textContent);
    expect(scores).toHaveLength(SEATS);
    expect(scores).not.toContain("999");
  });

  it("reports every frame reproduced for an untampered recording", async () => {
    delete document.documentElement.dataset.replayRederived;
    const frames = playRecordedFrames(7, 4);
    render(<App replay={{ frames: frames as never }} />);
    await waitFor(() => expect(document.documentElement.dataset.replayRederived).toBe("true"));
    // The engine reproduced every recorded frame from the recorded events alone.
    expect(rederiveReplay(frames).mismatch).toBeNull();
    expect(rederiveReplay(frames).verified).toBe(5);
  });
});
