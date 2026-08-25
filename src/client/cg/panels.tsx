// Territory observatory chrome: the Turn Log, the public/DM Channels, and the
// tile inspector. Re-labelled from coworld-cogherence's panels; the CSS class
// vocabulary is inherited unchanged. All read the recorded snapshot + event
// streams and nothing else.
import React, { useState } from "react";
import type { GameSnapshot } from "../../shared/snapshot";
import type { Message } from "../../shared/messages";
import type { ClientTurnEvent } from "../../shared/protocol";
import type { StampedEvent } from "../net/feed";
import { seatAlias, seatColor } from "../colors";
import {
  CLAIM_COST,
  RAZE_COST,
  RAZE_HOME_COST,
  SALVAGE_MULT,
  TRANSFER_FEE,
} from "../../shared/engine/constants";
import { CGIcon, Swatch, TilePill } from "./atoms";
import { homeRingKeys, lastResolvedTurn, neighbors, tileKey, tileMap, tileStatus } from "./derive";
import { tileSprite } from "../Icon";

const alias = (seat: number): string => seatAlias(seat);

// ===== Turn log ===========================================================
// Two dense sections per turn: ACTIONS (every order a seat played, paired with
// its consequence) and UPKEEP (per-seat income + walls, and the life changes).

interface LogLine {
  seat: number;
  verb: string;
  tone: string;
  action: React.ReactNode;
  outcome: string;
  failed: boolean;
}

function Section({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="cg-section">
      <div className="cg-section-head">
        <span className="cg-label">{label}</span>
        {right != null && <span className="cg-mono cg-section-right">{right}</span>}
      </div>
      {children}
    </div>
  );
}

const Quiet = ({ text }: { text: string }): React.ReactElement => (
  <div className="cg-mono cg-quiet">{text}</div>
);

/** The consequence of one order, joined from the turn's other events. */
function outcomeOf(seat: number, order: ClientTurnEvent, evs: ClientTurnEvent[]): { outcome: string; failed: boolean } {
  const rejected = evs.find((e) => e.kind === "rejected" && e.seat === seat);
  if (rejected && rejected.kind === "rejected") return { outcome: `rejected, ${rejected.reason}`, failed: true };
  if (order.kind !== "order") return { outcome: "", failed: false };
  const o = order.order;
  if (o.type === "claim") {
    const claim = evs.find((e) => e.kind === "claim" && e.seat === seat && e.tile === o.tile);
    if (claim && claim.kind === "claim") return { outcome: `wet paint down, ${claim.yield}/turn from next turn`, failed: false };
    const smear = evs.find((e) => e.kind === "smear" && e.tile === o.tile);
    if (smear && smear.kind === "smear")
      return { outcome: `smeared with ${smear.seats.filter((s) => s !== seat).map(alias).join(", ")} — nobody holds it`, failed: true };
    const void_ = evs.find((e) => e.kind === "voided" && e.seat === seat && e.tile === o.tile);
    if (void_ && void_.kind === "voided")
      return { outcome: void_.reason === "rubble" ? "void — razed to rubble first" : "void — already held", failed: true };
    return { outcome: "no effect", failed: true };
  }
  if (o.type === "raze") {
    const raze = evs.find((e) => e.kind === "raze" && e.seat === seat && e.tile === o.tile);
    if (raze && raze.kind === "raze") {
      const salvage = evs.find((e) => e.kind === "salvage" && e.seat === seat && e.tile === o.tile);
      return {
        outcome:
          `${raze.from_state} → ${raze.to_state}, yield ${raze.yield_before}→${raze.yield_after} forever` +
          (raze.victim !== null && raze.victim !== seat ? ` (${alias(raze.victim)} stripped)` : "") +
          (salvage && salvage.kind === "salvage" ? ` · +${salvage.paint} salvage` : ""),
        failed: false,
      };
    }
    return { outcome: "no effect — already rubble", failed: true };
  }
  const tr = evs.find((e) => e.kind === "transfer" && e.from === seat);
  if (tr && tr.kind === "transfer") return { outcome: `delivered, −${TRANSFER_FEE} fee`, failed: false };
  return { outcome: "no effect", failed: true };
}

function orderLine(order: Extract<ClientTurnEvent, { kind: "order" }>): { verb: string; tone: string; action: React.ReactNode } {
  const o = order.order;
  if (o.type === "claim")
    return { verb: "CLAIM", tone: "claim", action: <>Claim(<TilePill k={o.tile} />) · {order.cost} paint</> };
  if (o.type === "raze")
    return { verb: "RAZE", tone: "raze", action: <>Raze(<TilePill k={o.tile} />) · {order.cost} paint</> };
  return { verb: "TRANSFER", tone: "transfer", action: `Transfer(${o.amount} → ${o.to}) · ${order.cost} paint` };
}

export function TurnLog({ snapshot, events }: { snapshot: GameSnapshot; events: StampedEvent[] }): React.ReactElement {
  const turn = lastResolvedTurn(snapshot);
  const evs: ClientTurnEvent[] = events.filter((e) => e.turn === turn).map((e) => e.event);

  const actions: LogLine[] = [];
  for (const e of evs) {
    if (e.kind !== "order") continue;
    const { verb, tone, action } = orderLine(e);
    const { outcome, failed } = outcomeOf(e.seat, e, evs);
    actions.push({ seat: e.seat, verb, tone, action, outcome, failed });
  }
  actions.sort((a, b) => a.seat - b.seat);

  const income = evs.filter((e): e is Extract<ClientTurnEvent, { kind: "income" }> => e.kind === "income");
  const lives = evs.filter((e) => e.kind === "struck" || e.kind === "recovered" || e.kind === "eliminated");

  return (
    <div className="cg-panel cg-flex" data-testid="turn-log">
      <div className="cg-panel-head">
        <span className="cg-panel-title">Turn log</span>
        <span className="cg-mono cg-panel-note">
          {turn >= 1 ? `T${String(turn).padStart(2, "0")}` : "awaiting the first turn"}
        </span>
      </div>
      <div className="cg-panel-body cg-scroll cg-col-gap">
        {turn < 1 ? (
          <Quiet text="nothing has resolved yet." />
        ) : (
          <>
            <Section label="Actions" right={`${actions.length}`}>
              {actions.length === 0 && <Quiet text="no orders — everyone held." />}
              {actions.map((l, i) => (
                <div key={i} className="cg-logrow">
                  <span className={`cg-verb ${l.tone}`}>{l.verb}</span>
                  <span className="cg-mono cg-logtext">
                    <Swatch seat={l.seat} size={7} />
                    <b style={{ color: seatColor(l.seat) }}> {alias(l.seat)}: </b>
                    {l.action}
                    <span style={{ color: l.failed ? "var(--raze)" : "var(--paint)" }}> ⇒ {l.outcome}</span>
                  </span>
                </div>
              ))}
            </Section>

            <Section label="Life" right={lives.length > 0 ? `${lives.length}` : "quiet"}>
              {lives.length === 0 && <Quiet text="nobody's home ring was touched." />}
              {lives.map((e, i) => (
                <div key={i} className="cg-mono cg-logline">
                  {e.kind === "struck" && (
                    <>
                      <b style={{ color: seatColor(e.seat) }}>{alias(e.seat)}</b> struck by {e.by.map(alias).join(", ")}
                    </>
                  )}
                  {e.kind === "recovered" && (
                    <>
                      <b style={{ color: seatColor(e.seat) }}>{alias(e.seat)}</b> recovered
                    </>
                  )}
                  {e.kind === "eliminated" && (
                    <>
                      <CGIcon name="skull" size={12} />{" "}
                      <b style={{ color: seatColor(e.seat) }}>{alias(e.seat)}</b> eliminated · {e.tilesReverted} tiles
                      reverted
                    </>
                  )}
                </div>
              ))}
            </Section>

            <Section label="Upkeep">
              {income.length === 0 && <Quiet text="no income this turn." />}
              <div className="cg-incomegrid">
                {income
                  .slice()
                  .sort((a, b) => b.paint - a.paint || a.seat - b.seat)
                  .map((e) => (
                    <React.Fragment key={e.seat}>
                      <span className="cg-mono cg-incomename">
                        <Swatch seat={e.seat} size={7} />
                        <b style={{ color: seatColor(e.seat) }}> {alias(e.seat)}</b>
                      </span>
                      <span className="cg-mono cg-incomeval">+{e.paint}</span>
                      <span className="cg-mono cg-incomewalls">▮×{e.walls}</span>
                    </React.Fragment>
                  ))}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ===== Channels (public + DMs) ============================================

export function ChannelMessage({ m, onSeekTurn }: { m: Message; onSeekTurn?: (turn: number) => void }): React.ReactElement {
  const isPublic = m.to === "public";
  return (
    <div className={`cg-msg${isPublic ? "" : " is-dm"}`} style={{ borderLeftColor: seatColor(m.from) }}>
      <div className="cg-msg-head">
        <Swatch seat={m.from} />
        <span className="cg-msg-from" style={{ color: seatColor(m.from) }}>
          {alias(m.from)}
        </span>
        {isPublic ? (
          <span className="cg-mono cg-msg-scope is-public">PUBLIC</span>
        ) : (
          <span className="cg-mono cg-msg-scope is-dm">🔒 → {alias(m.to as number)}</span>
        )}
        <button onClick={() => onSeekTurn?.(m.turn)} className="cg-mono cg-turnjump" type="button">
          T{String(m.turn).padStart(2, "0")}
        </button>
      </div>
      <div className="cg-mono cg-msg-body">{m.text}</div>
    </div>
  );
}

export function Channels({ messages, onSeekTurn }: { messages: Message[]; onSeekTurn?: (turn: number) => void }): React.ReactElement {
  const [tab, setTab] = useState<"all" | "public" | "dm">("all");
  let msgs = messages;
  if (tab === "public") msgs = msgs.filter((m) => m.to === "public");
  if (tab === "dm") msgs = msgs.filter((m) => m.to !== "public");
  msgs = msgs.slice(-40).reverse();
  return (
    <div className="cg-panel cg-flex" data-testid="channels">
      <div className="cg-panel-head">
        <span className="cg-panel-title">Channels</span>
        <div className="cg-seg">
          {([["all", "All"], ["public", "Public"], ["dm", "DMs"]] as const).map(([k, l]) => (
            <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="cg-panel-body cg-scroll cg-col-gap">
        {msgs.length === 0 && <div className="cg-mono cg-quiet">silence on the wire.</div>}
        {msgs.map((m) => (
          <ChannelMessage key={m.seq} m={m} onSeekTurn={onSeekTurn} />
        ))}
      </div>
    </div>
  );
}

// ===== Tile inspector (hover card — follows the cursor, nothing pinned) ====

export function TileInspector({ tileKey: k, snapshot }: { tileKey: string; snapshot: GameSnapshot }): React.ReactElement | null {
  const map = tileMap(snapshot);
  const t = map.get(k);
  if (!t) return null;
  const ownerColor = t.owner === null ? "var(--muted)" : seatColor(t.owner);
  const status = tileStatus(t, ownerColor);
  const nb = neighbors(t.q, t.r, map);
  const mineNb = t.owner === null ? 0 : nb.filter((n) => n.owner === t.owner).length;
  const foeNb = nb.filter((n) => n.owner !== null && n.owner !== t.owner).length;
  const homeOf = snapshot.cogs.find((c) => homeRingKeys(snapshot, c.seat).has(k));
  const sprite = tileSprite(t.state, t.yield);
  const row = (label: string, value: React.ReactNode): React.ReactElement => (
    <tr key={label}>
      <td className="cg-label cg-insp-label">{label}</td>
      <td className="cg-mono cg-insp-value">{value}</td>
    </tr>
  );
  return (
    <div className="cg-panel cg-inspector" data-testid="tile-inspector">
      <div className="cg-panel-head cg-insp-head">
        <span className="cg-panel-title cg-insp-title">Tile {k}</span>
        {sprite && <CGIcon name={sprite} size={20} />}
      </div>
      <div className="cg-panel-body cg-insp-body">
        <div className="cg-insp-owner">
          <div className="cg-insp-chip" style={{ background: t.owner === null ? "var(--panel-2)" : ownerColor }} />
          <div>
            <div className="cg-insp-name" style={{ color: ownerColor }}>
              {t.owner === null ? "Unclaimed" : alias(t.owner)}
            </div>
            <div className="cg-mono cg-insp-status" style={{ color: status.tone }}>
              {status.label}
            </div>
          </div>
        </div>
        <table className="cg-insp-table">
          <tbody>
            {row("state", <span style={{ color: status.tone }}>{t.state}</span>)}
            {row(
              "yield",
              t.effYield === t.yield ? (
                <span data-tip="base yield 0..3; income per turn equals it exactly">{t.yield}</span>
              ) : (
                <span data-tip="razed once: the yield is halved forever, for whoever holds it next">
                  <s style={{ color: "var(--muted-2)" }}>{t.yield}</s>{" "}
                  <span style={{ color: "var(--raze)" }}>{t.effYield}</span>
                </span>
              ),
            )}
            {row("income", t.owner === null ? "—" : t.wet ? "0 (wet)" : `${t.effYield}/turn`)}
            {row(
              "claim cost",
              t.owner === null && t.state !== "rubble"
                ? `${CLAIM_COST(1)} at range 1 · ${CLAIM_COST(2)} at range 2`
                : "unclaimable",
            )}
            {row(
              "raze cost",
              t.state === "rubble" ? "already rubble" : homeOf ? `${RAZE_HOME_COST} (home ring)` : `${RAZE_COST}`,
            )}
            {row(
              "salvage",
              t.owner === null || t.state !== "wall" ? "—" : `${SALVAGE_MULT * t.effYield} to its owner`,
            )}
            {row("hearth", t.hearthOf === null ? (homeOf ? `${alias(homeOf.seat)}'s home ring` : "—") : `${alias(t.hearthOf)}'s hearth`)}
            {row("neighbours", `${mineNb} ally · ${foeNb} foe · ${nb.length - mineNb - foeNb} open`)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
