// EventFeed<E> — a turn-grouped chat/event console. By default it renders
// FeedEvent-shaped items (turn header + seat-tagged text), but a game can swap
// in its own grouping (`groupBy`), per-event renderer (`renderEvent`), and group
// renderer (`renderGroup`). An optional `onSend` mounts a compose box.
import { useState } from "react";
import type { ReactNode } from "react";
import type { FeedEvent } from "@cogweb/protocol";

/** Default item shape: the wire FeedEvent. Games may use any `E`. */
export interface EventFeedProps<E = FeedEvent> {
  events: E[];
  /** Group key for an event (default: its `turn`). Consecutive equal keys merge. */
  groupBy?: (e: E) => string | number;
  /** Render one event (default: seat-tagged text line). */
  renderEvent?: (e: E) => ReactNode;
  /** Render a whole group given its key + items (default: a "Turn N" section). */
  renderGroup?: (key: string | number, items: E[]) => ReactNode;
  /** Mount a compose box that calls this with the typed text on submit. */
  onSend?: (text: string) => void;
}

/** Split the chronological stream into contiguous same-key groups. */
function group<E>(events: E[], key: (e: E) => string | number): { key: string | number; items: E[] }[] {
  const groups: { key: string | number; items: E[] }[] = [];
  for (const e of events) {
    const k = key(e);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.items.push(e);
    else groups.push({ key: k, items: [e] });
  }
  return groups;
}

const defaultGroupBy = (e: FeedEvent): number => e.turn;
const defaultRenderEvent = (e: FeedEvent): ReactNode => (
  <div className="cogui-feed-line">
    {e.seat !== null && <span className="cogui-feed-seat">#{e.seat}</span>}
    <span className="cogui-feed-text">{e.text}</span>
  </div>
);

export function EventFeed<E = FeedEvent>({
  events,
  groupBy,
  renderEvent,
  renderGroup,
  onSend,
}: EventFeedProps<E>) {
  // Defaults are typed against FeedEvent; cast the supplied accessors so a caller
  // that omits them (and is therefore using E = FeedEvent) gets the wire behavior.
  const keyOf = groupBy ?? (defaultGroupBy as unknown as (e: E) => string | number);
  const eventOf = renderEvent ?? (defaultRenderEvent as unknown as (e: E) => ReactNode);
  const groups = group(events, keyOf);

  const [draft, setDraft] = useState("");
  const submit = (): void => {
    const text = draft.trim();
    if (!text || !onSend) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="cogui-feed" data-testid="feed">
      <div className="cogui-feed-body">
        {events.length === 0 ? (
          <p className="cogui-feed-empty">No events yet.</p>
        ) : (
          groups.map((g) =>
            renderGroup ? (
              <div key={g.key}>{renderGroup(g.key, g.items)}</div>
            ) : (
              <section key={g.key} className="cogui-feed-group">
                <header className="cogui-feed-head">Turn {g.key}</header>
                <div className="cogui-feed-items">
                  {g.items.map((e, i) => (
                    <div key={i}>{eventOf(e)}</div>
                  ))}
                </div>
              </section>
            ),
          )
        )}
      </div>
      {onSend && (
        <div className="cogui-feed-compose">
          <input
            className="cogui-feed-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Say something…"
            aria-label="message"
          />
          <button type="button" className="cogui-btn" onClick={submit}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}
