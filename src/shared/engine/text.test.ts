// TEST 8 — STRICT-UTF-8 / RUNE TRUNCATION.
//
// A byte-boundary truncation renders fine in a browser and FAILS A STRICT PARSER —
// that is the failure this test exists to catch. A 300-emoji `text` must truncate
// to 200 code points; the serialized replay must decode under
// `new TextDecoder("utf-8", {fatal: true})` WITHOUT THROWING; and `JSON.parse` of
// the result must round-trip to the same object. No lone surrogate and no partial
// multi-byte sequence may survive truncation.
import { describe, it, expect } from "vitest";

import { capText, renderEvent, runeLength, truncateRunes } from "./text";
import { newGame, stepTurn } from "./game";
import { MAX_NOTE_LEN, MAX_SAY_LEN } from "./constants";
import { capNote, resolve } from "./resolve";
import { MAX_LINES } from "./constants";
import { SubmissionSchema } from "./orders";
import { toSnapshot } from "../snapshot";

const EMOJI = "\u{1F9F1}"; // 🧱 — a non-BMP code point, i.e. a surrogate PAIR
const CJK = "\u9818\u571F"; // 領土

/** True iff `s` contains a lone (unpaired) UTF-16 surrogate. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("truncateRunes", () => {
  it("slices by CODE POINT, never by UTF-16 code unit", () => {
    const s = EMOJI.repeat(300);
    // 300 emoji are 600 UTF-16 code units; a naive slice(0,200) would cut a pair.
    expect(s.length).toBe(600);
    const cut = truncateRunes(s, 200);
    expect(runeLength(cut)).toBe(200);
    expect(cut.length).toBe(400);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut).toBe(EMOJI.repeat(200));
  });

  it("leaves a short string alone and handles degenerate caps", () => {
    expect(truncateRunes("abc", 10)).toBe("abc");
    expect(truncateRunes("abc", 0)).toBe("");
    expect(truncateRunes("", 5)).toBe("");
  });

  it("capText stays WITHIN the cap, ellipsis included", () => {
    const long = `${CJK}${EMOJI}`.repeat(200);
    const capped = capText(long, MAX_SAY_LEN);
    expect(runeLength(capped)).toBe(MAX_SAY_LEN);
    expect(capped.endsWith("\u2026")).toBe(true);
    expect(hasLoneSurrogate(capped)).toBe(false);
    expect(capText("short", MAX_SAY_LEN)).toBe("short");
    expect(runeLength(capNote(long))).toBe(MAX_NOTE_LEN);
  });
});

describe("the recorded replay is strict UTF-8", () => {
  it("round-trips a 300-emoji talk line through a fatal TextDecoder and JSON.parse", () => {
    const base = newGame(7);
    const nasty = `${EMOJI.repeat(300)}${CJK.repeat(60)}`;
    const out = resolve(base, {
      0: { orders: [], messages: [{ to: null, text: nasty }] },
      1: { orders: [], messages: [{ to: "Sable", text: nasty }] },
    });
    const talk = out.events.filter((e) => e.kind === "talk");
    expect(talk).toHaveLength(2);
    for (const ev of talk) {
      if (ev.kind !== "talk") continue;
      expect(runeLength(ev.text)).toBe(MAX_SAY_LEN);
      expect(hasLoneSurrogate(ev.text)).toBe(false);
    }

    // The whole replay envelope, exactly as `writeReplay` serializes it.
    const stepped = stepTurn(base, {
      0: { orders: [], messages: [{ to: null, text: nasty }], note: nasty },
    });
    const replay = {
      protocol: "cogweb.replay.v1",
      frames: [
        { type: "snapshot", snapshot: { turn: 1, generation: 0, state: toSnapshot(stepped) } },
        ...stepped.log[0]!.events.map((ev) => ({
          type: "event",
          event: {
            turn: 1,
            seat: 0,
            kind: ev.kind,
            text: renderEvent(1, ev, (s) => `seat ${s}`),
            to: "public",
            data: ev,
          },
        })),
      ],
    };
    const bytes = Buffer.from(JSON.stringify(replay), "utf8");
    // FATAL: any partial multi-byte sequence throws here.
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(hasLoneSurrogate(decoded)).toBe(false);
    expect(JSON.parse(decoded)).toEqual(replay);
  });

  it("every rendered event line is strict-UTF-8 clean over a whole scripted game", () => {
    let s = newGame(9);
    for (let t = 0; t < 6; t++) {
      s = stepTurn(s, {
        [t % 9]: { orders: [], messages: [{ to: null, text: `${EMOJI.repeat(250)} ${CJK.repeat(80)}` }] },
      });
    }
    const lines = s.log.flatMap((rec) => rec.events.map((ev) => renderEvent(rec.turn, ev, (x) => `seat ${x}`)));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(hasLoneSurrogate(line)).toBe(false);
    const bytes = Buffer.from(JSON.stringify({ lines }), "utf8");
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
  });
});

describe("the reply schema applies its own caps at the parse boundary", () => {
  // The caps have to bite HERE, not only inside Resolve: the decision this schema
  // returns is what the host records in the `actPrompt` transcript, so the value
  // that reaches the replay is this one. Before this, `note` was capped into a
  // field nothing read, while the uncapped original rode the transcript.
  it("rune-caps `note`, rune-caps every talk line and drops the lines past MAX_LINES", () => {
    const nasty = `${EMOJI.repeat(300)}${CJK.repeat(60)}`;
    const parsed = SubmissionSchema.parse({
      orders: [],
      note: nasty,
      messages: Array.from({ length: MAX_LINES + 4 }, () => ({ text: nasty })),
    });
    expect(runeLength(parsed.note!)).toBe(MAX_NOTE_LEN);
    expect(hasLoneSurrogate(parsed.note!)).toBe(false);
    expect(parsed.messages).toHaveLength(MAX_LINES);
    for (const line of parsed.messages) {
      expect(runeLength(line.text)).toBe(MAX_SAY_LEN);
      expect(hasLoneSurrogate(line.text)).toBe(false);
      expect(line.to).toBeNull();
    }
    // The capped decision serializes clean under a FATAL decoder — this is the
    // string the transcript records.
    const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
    expect(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).toEqual(parsed);
  });

  it("leaves a short note and a short line exactly as sent, and an absent note absent", () => {
    const parsed = SubmissionSchema.parse({ orders: [], messages: [{ to: "Sable", text: "hold the ring" }] });
    expect("note" in parsed).toBe(false);
    expect(parsed.messages).toEqual([{ to: "Sable", text: "hold the ring" }]);
    expect(SubmissionSchema.parse({ note: "why I did this" }).note).toBe("why I did this");
  });
});
