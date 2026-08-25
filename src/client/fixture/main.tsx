// THE RENDERER FIXTURE (test 14).
//
// It mounts the REAL ScoreBug, WarLedger and Channels components over a REAL
// played scenario — nine seats, full-cap (200-rune, CJK + emoji) talk lines on
// every seat, long policy names — and exposes `window.__territoryFixtureCheck()`,
// which self-checks DOM legibility: `scrollWidth <= clientWidth` on every row and
// no zero-height text node.
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
import { FIXTURE_POLICY_NAMES, playScenario } from "./scenario";
import { lastResolvedTurn } from "../cg/derive";

const ROW_SELECTORS = [".plate", ".warledger-row", ".cg-msg", ".cg-msg-head", ".cg-panel-head"];

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
  return { ok: findings.length === 0, width: window.innerWidth, rows, findings };
}

declare global {
  interface Window {
    __territoryFixtureCheck?: () => ReturnType<typeof checkDom>;
  }
}

function Fixture(): React.ReactElement {
  const scenario = React.useMemo(() => playScenario(7, 7), []);
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
