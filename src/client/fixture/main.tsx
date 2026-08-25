// THE RENDERER FIXTURE (test 14).
//
// It mounts the REAL ScoreBug, WarLedger and Channels components over a REAL
// played scenario — nine seats, full-cap (200-rune, CJK + emoji) talk lines on
// every seat, long policy names — and exposes `window.__territoryFixtureCheck()`,
// which self-checks DOM legibility: `scrollWidth <= clientWidth` on every row, no
// zero-height text node, and — the check that keeps the other two honest — that the
// strings it mounted are STILL FULL-LENGTH IN THE DOM. One quietly shortened
// remark, or a scenario that stops emitting talk, would otherwise leave this page
// reporting `ok: true` over an empty Channels panel, testing nothing.
//
// `tools/ci/renderer_fixture.mjs` opens this page at 360 / 720 / 1280 px and calls
// the check at each width. This is the SUBSTITUTE for
// `viewer_smoke.mjs --strict-text-bounds`: this lineage's viewer draws text in
// SVG/DOM, not canvas, so `viewer_smoke`'s `canvas_text` counters read 0 here and
// prove nothing — stated so nobody reads that zero as a pass. It exists because
// `docker_smoke` runs KEYLESS, so every replay CI produces carries zero LLM text
// and nothing else would ever exercise the talk chrome.
import React from "react";
import { createRoot } from "react-dom/client";
import "@cogweb/ui/styles.css";
import "../styles.css";
import { setPolicyNames } from "../colors";
import { Channels } from "../cg/panels";
import { ScoreBug } from "../ui/ScoreBug";
import { WarLedger } from "../ui/WarLedger";
import { FIXTURE_POLICY_NAMES, fullCapLine, playScenario } from "./scenario";
import { lastResolvedTurn } from "../cg/derive";
import { MAX_SAY_LEN, SEATS } from "../../shared/engine/constants";
import { runeLength } from "../../shared/engine/text";

const ROW_SELECTORS = [".plate", ".warledger-row", ".cg-msg", ".cg-msg-head", ".cg-panel-head"];

/** The scenario this page mounts, and the exact talk lines it handed the chrome.
 *  Module level so the self-check can compare the DOM against them. */
const scenario = playScenario(7, 7);
const EXPECTED_LINES = scenario.messages.map((m) => m.text);

export interface FixtureFinding {
  selector: string;
  index: number;
  problem: string;
  detail: string;
}

/** Self-check the mounted DOM: no row overflows its box, no text is invisible. */
function checkDom(): { ok: boolean; width: number; rows: number; findings: FixtureFinding[] } {
  const findings: FixtureFinding[] = [];
  let rows = 0;
  for (const selector of ROW_SELECTORS) {
    document.querySelectorAll<HTMLElement>(selector).forEach((el, index) => {
      rows += 1;
      // A row that scrolls horizontally is a row whose content has nowhere to go.
      if (el.scrollWidth > el.clientWidth + 1) {
        findings.push({
          selector,
          index,
          problem: "overflows",
          detail: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`,
        });
      }
    });
  }
  // No zero-height text node: a leaf element carrying visible text must have box.
  // An element the 360px media query DELIBERATELY hides (`display: none` — the
  // /tick figure, the policy name, the rail's phase pips) is not "invisible text",
  // it is removed text, so it is skipped. What this catches is text that is still
  // laid out and still has nowhere to go.
  document.querySelectorAll<HTMLElement>("#fixture-root *").forEach((el, index) => {
    if (el.children.length > 0) return;
    const text = (el.textContent ?? "").trim();
    if (!text) return;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    const box = el.getBoundingClientRect();
    if (box.height <= 0) {
      findings.push({ selector: el.className || el.tagName, index, problem: "zero-height text", detail: text.slice(0, 40) });
    }
  });
  findings.push(...checkStrings());
  return { ok: findings.length === 0, width: window.innerWidth, rows, findings };
}

/**
 * THE FIXTURE ASSERTS ITS OWN STRINGS. Every line it mounted must still be at the
 * 200-rune cap AND present, whole, in the rendered DOM — plus the generator that
 * produces them, and the count of full-length lines actually laid out. Without
 * this, shortening `fullCapLine` or dropping the scenario's messages leaves the
 * geometry checks above passing over nothing at all.
 */
function checkStrings(): FixtureFinding[] {
  const findings: FixtureFinding[] = [];
  const at = (problem: string, detail: string, index = 0): void => {
    findings.push({ selector: "#fixture-root", index, problem, detail });
  };
  const rendered = (document.getElementById("fixture-root")?.textContent ?? "").normalize();

  if (runeLength(fullCapLine(0)) !== MAX_SAY_LEN) {
    at("short generator", `fullCapLine() is ${runeLength(fullCapLine(0))} runes, cap is ${MAX_SAY_LEN}`);
  }
  if (EXPECTED_LINES.length < SEATS) {
    at("too few talk lines", `the scenario emitted ${EXPECTED_LINES.length}; the chrome needs one per seat`);
  }
  EXPECTED_LINES.forEach((line, index) => {
    if (runeLength(line) !== MAX_SAY_LEN) {
      at("short string", `${runeLength(line)} runes, cap is ${MAX_SAY_LEN}`, index);
    } else if (!rendered.includes(line.normalize())) {
      at("string missing from the DOM", `${line.slice(0, 24)}…`, index);
    }
  });
  // And the rows really are carrying them: count the message bodies at full cap.
  const bodies = Array.from(document.querySelectorAll<HTMLElement>(".cg-msg-body"));
  const full = bodies.filter((el) => runeLength((el.textContent ?? "").trim()) === MAX_SAY_LEN).length;
  if (full < SEATS) {
    at("too few full-length rows", `${full} of ${bodies.length} .cg-msg-body rows are at the ${MAX_SAY_LEN}-rune cap`);
  }
  return findings;
}

declare global {
  interface Window {
    __territoryFixtureCheck?: () => ReturnType<typeof checkDom>;
  }
}

function Fixture(): React.ReactElement {
  const turn = lastResolvedTurn(scenario.snapshot);
  return (
    <div className="app">
      <div className="cg-stage">
        <div className="cg-view">
          <div className="cg-grid" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
            <div className="cg-col">
              <ScoreBug snapshot={scenario.snapshot} />
              <WarLedger events={scenario.events} turn={turn} />
              <Channels messages={scenario.messages} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const host = document.getElementById("fixture-root");
if (host) {
  setPolicyNames(FIXTURE_POLICY_NAMES);
  createRoot(host).render(<Fixture />);
  window.__territoryFixtureCheck = checkDom;
  requestAnimationFrame(() => {
    document.documentElement.dataset.replayLoaded = "true";
  });
}
