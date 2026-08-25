// FeedDrawer — the in-game negotiation-feed drawer floated from the GameTopBar's
// Comms button (ported from the "Game Top Bar" design). It shows the public
// message stream + ember "whisper" DMs with an All / Whispers filter, and (when
// the viewer holds a seat) a composer with a To-all ⇄ Whisper toggle so you can
// talk to the table. It is presentational: messages + the send callback are
// props, so a game maps its FeedEvent stream onto FeedDrawerMessage and wires
// `onSend` to a `say` ClientMessage.
import { useState } from "react";

export interface FeedDrawerMessage {
  id: string | number;
  /** Speaker display name. */
  name: string;
  /** Speaker color (e.g. the seat's team/accent color). */
  nameColor?: string;
  text: string;
  /** A private DM (rendered ember; surfaced under the Whispers filter). */
  whisper?: boolean;
  /** Authored by the viewer (accent-tinted bubble). */
  mine?: boolean;
}

export interface FeedDrawerProps {
  messages: FeedDrawerMessage[];
  /** Dismiss the drawer (the × and, upstream, the GameTopBar scrim). */
  onClose: () => void;
  /** The composer, shown only when the viewer holds a seat. `whisperTo` is the
   *  current To-all ⇄ Whisper mode; `onSend` receives the text + that mode. When
   *  whispering, an optional `recipients` list renders a DM-target picker so the
   *  game can send a real 1:1 whisper (omit it for a table-wide whisper). */
  compose?: {
    whisperTo: boolean;
    onToggleWhisperTo: () => void;
    recipients?: { id: string | number; name: string }[];
    recipient?: string | number;
    onRecipient?: (id: string) => void;
    onSend: (text: string, whisper: boolean) => void;
    placeholder?: string;
  };
  /** Header label (default "Comms"). */
  title?: string;
}

export function FeedDrawer({ messages, onClose, compose, title = "Comms" }: FeedDrawerProps) {
  const [tab, setTab] = useState<"all" | "whispers">("all");
  const [draft, setDraft] = useState("");
  const shown = tab === "all" ? messages : messages.filter((m) => m.whisper);

  const send = (): void => {
    const text = draft.trim();
    if (!text || !compose) return;
    compose.onSend(text, compose.whisperTo);
    setDraft("");
  };

  return (
    <div className="cogui-fd" data-testid="feed-drawer">
      <div className="cogui-fd-head">
        <span className="cogui-fd-title">{title}</span>
        <span className="cogui-spacer" />
        <div className="cogui-fd-tabs">
          <button
            type="button"
            className={`cogui-fd-tab${tab === "all" ? " is-on" : ""}`}
            onClick={() => setTab("all")}
          >
            All
          </button>
          <button
            type="button"
            className={`cogui-fd-tab${tab === "whispers" ? " is-on" : ""}`}
            onClick={() => setTab("whispers")}
          >
            Whispers
          </button>
        </div>
        <button type="button" className="cogui-fd-close" aria-label="close comms" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="cogui-fd-body cogui-tbscroll">
        {shown.length === 0 ? (
          <p className="cogui-fd-empty">{tab === "whispers" ? "No whispers yet." : "No messages yet."}</p>
        ) : (
          shown.map((m) => (
            <div key={m.id} className="cogui-fd-msg">
              <div className="cogui-fd-msg-head">
                <span className="cogui-fd-name" style={{ color: m.nameColor }}>
                  {m.name}
                </span>
                <span className={`cogui-fd-to${m.whisper ? " is-whisper" : ""}`}>{m.whisper ? "whisper" : "all"}</span>
              </div>
              <div className={`cogui-fd-bubble${m.mine ? " is-mine" : ""}`}>{m.text}</div>
            </div>
          ))
        )}
      </div>

      {compose && (
        <div className="cogui-fd-compose">
          <button
            type="button"
            className={`cogui-fd-toggle${compose.whisperTo ? " is-whisper" : ""}`}
            onClick={compose.onToggleWhisperTo}
            title={
              compose.whisperTo
                ? "Whispering privately — click to speak to everyone"
                : "Speaking to everyone — click to whisper privately to one player"
            }
          >
            {compose.whisperTo ? "Whisper to" : "To all ▾"}
          </button>
          {compose.whisperTo && compose.recipients && compose.onRecipient && (
            <select
              className="cogui-fd-toggle"
              value={compose.recipient ?? ""}
              onChange={(e) => compose.onRecipient!(e.target.value)}
              aria-label="whisper recipient"
            >
              {compose.recipients.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <textarea
            className="cogui-fd-input"
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter sends; plain Enter inserts a newline (multi-line compose).
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={compose.placeholder ?? "Say something to the table… (⌘/Ctrl+Enter)"}
            aria-label="message"
          />
          <button type="button" className="cogui-fd-send" onClick={send}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}
