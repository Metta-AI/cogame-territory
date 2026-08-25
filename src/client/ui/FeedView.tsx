// The talk feed: every line the Cogs sent — public broadcasts and (spectator-side
// only) DMs — as a chat console, grouped under a per-turn header.
import React from "react";
import type { Message } from "../../shared/messages";
import { ChannelMessage } from "../cg/panels";

/** Split the chronological stream into per-turn groups. */
function groupByTurn(messages: Message[]): { turn: number; msgs: Message[] }[] {
  const groups: { turn: number; msgs: Message[] }[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && last.turn === m.turn) last.msgs.push(m);
    else groups.push({ turn: m.turn, msgs: [m] });
  }
  return groups;
}

export function FeedView({ messages }: { messages: Message[] }): React.ReactElement {
  const groups = groupByTurn(messages);
  return (
    <div className="cg-view cg-feed" data-testid="feed-view">
      <div className="cg-panel cg-feed-panel">
        <div className="cg-panel-head">
          <span className="cg-panel-title">Cheap talk</span>
          <span className="cg-mono cg-panel-note">public + every DM (spectators only)</span>
        </div>
        <div className="cg-panel-body cg-scroll cg-feed-body">
          {messages.length === 0 ? (
            <p className="cg-mono cg-quiet">No lines yet — the Cogs haven’t spoken.</p>
          ) : (
            groups.map((g) => (
              <section key={g.turn} className="cg-feed-group">
                <header className="cg-feed-turn">Turn {g.turn}</header>
                <div className="cg-col-gap">
                  {g.msgs.map((m) => (
                    <ChannelMessage key={m.seq} m={m} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
