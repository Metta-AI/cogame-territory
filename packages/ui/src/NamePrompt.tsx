// Shared "pick a name" modal. Two use-sites, one component:
//  - the portal shows it as a first-run gate (no `onCancel` ⇒ no dismiss; naming
//    yourself is the price of admission);
//  - a game console shows it lazily when you take over a seat without a known name
//    (`onCancel` given ⇒ scrim/Esc back out of the claim).
// It pre-fills a random suggestion so the easy path is a single Continue, with a
// reroll for another. The chosen name is the viewer identity persisted via
// saveViewerName; this component only collects it and hands it to `onPick`.
import { useEffect, useRef, useState } from "react";

const ADJECTIVES = [
  "Clever", "Brave", "Sly", "Lucky", "Swift", "Quiet", "Bold", "Sunny",
  "Cosmic", "Mellow", "Plucky", "Witty", "Nimble", "Rogue", "Gentle", "Fierce",
];
const ANIMALS = [
  "Otter", "Falcon", "Badger", "Lynx", "Heron", "Fox", "Magpie", "Wolf",
  "Marten", "Raven", "Bison", "Gecko", "Mantis", "Newt", "Stoat", "Tapir",
];

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const suggestName = (): string => `${pick(ADJECTIVES)}${pick(ANIMALS)}`;

export interface NamePromptProps {
  /** Receives a trimmed, non-empty name. The only way out when `onCancel` is unset. */
  onPick: (name: string) => void;
  /** When given, the scrim and Esc dismiss the prompt (a cancellable, lazy prompt).
   *  Omit for a hard gate that must be answered. */
  onCancel?: () => void;
  title?: string;
  subtitle?: string;
}

export function NamePrompt({
  onPick,
  onCancel,
  title = "Pick a name",
  subtitle = "This is how you'll show up at the table.",
}: NamePromptProps) {
  const [draft, setDraft] = useState(suggestName);
  const inputRef = useRef<HTMLInputElement>(null);

  // Land focused with the suggestion selected, so typing replaces it in one stroke.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = draft.trim();
  const commit = (): void => {
    if (trimmed) onPick(trimmed);
  };

  return (
    <>
      <div className="cogui-nameprompt-scrim" onClick={onCancel} />
      <div
        className="cogui-nameprompt"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onCancel) onCancel();
        }}
      >
        <div className="cogui-nameprompt-head">
          <div className="cogui-nameprompt-title">{title}</div>
          <div className="cogui-nameprompt-sub">{subtitle}</div>
        </div>
        <div className="cogui-nameprompt-body">
          <input
            ref={inputRef}
            className="cogui-nameprompt-input"
            value={draft}
            maxLength={24}
            placeholder="Your name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
          <div className="cogui-nameprompt-actions">
            <button type="button" className="cogui-nameprompt-dice" onClick={() => setDraft(suggestName())}>
              🎲 surprise me
            </button>
            <button type="button" className="cogui-nameprompt-go" onClick={commit} disabled={!trimmed}>
              Continue
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
