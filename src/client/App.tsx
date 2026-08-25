// The console shell + router. Reads the URL (global / feed / seat/:n), connects to
// the matching feed source (a recorded replay artifact, or the live ws endpoint),
// and renders the inherited chrome: a <GameTopBar> over <div class="cg-stage">
// over <GameScrubberBar>. One snapshot list drives every view.
//
// STRUCTURE IS LOAD-BEARING. `.app` is `position: fixed; inset: 0; display: flex;
// flex-direction: column` with exactly three flex children — the top bar, the
// stage (`flex: 1; min-height: 0`), and the transport row. The transport band is
// therefore a FLEX ROW THAT CANNOT BE OVERLAID: it owns its own height and nothing
// can paint into it. Every overlay Territory adds (the endcard, the tooltip layer,
// the tile hover card) mounts INSIDE `.cg-stage`, never `position: fixed` at the
// shell level.
//
// THE LOAD SIGNAL is the one addition to the page: after the first frame has been
// applied AND committed, a requestAnimationFrame callback sets
// `data-replay-loaded="true"` on <html> and only THEN posts the `coworld-replay`
// bridge `{type:"ready"}` — posting `ready` before the attribute lets the
// softmax.com embed sample an unpainted shell (chorus 3c11c953). On failure it
// sets `data-replay-error` and posts `{type:"error"}`.
//
// REPLAY MODE RE-DERIVES. In replay mode the page does not draw the recorded
// snapshots: it replays the recorded EVENTS through the same sim the host ran
// (`rederiveReplay`, the engine compiled into THIS bundle by vite) and draws the
// re-derivation, cross-checking it frame by frame against the recorded snapshots
// at load time. `data-replay-rederived` reports the outcome — `"true"` every frame
// reproduced, `"mismatch"` the re-derivation stands but a frame differed (worth
// investigating; the state drawn is still the sim's), `"false"` the recording is
// not re-derivable (no `actPrompt` frames) and the recorded snapshots stand.
import React, { useCallback, useEffect, useRef, useState } from "react";
import "@cogweb/ui/styles.css";
import "./styles.css";
import { GameTopBar, GameScrubberBar, loadReplayFrames } from "@cogweb/ui";
import type { GameTopBarPlayer } from "@cogweb/ui";
import type { ServerMessage as CogwebMessage } from "@cogweb/protocol";
import type { Replay } from "../shared/replay";
import { rederiveReplay } from "../game/rederive";
import { applyFrame, connectLiveFeed, emptyStore, type FeedStore } from "./net/feed";
import { makeCogwebDecoder } from "./net/cogweb-feed";
import { makeWorldSocket } from "./net/world-socket";
import { liveFeedWsUrl, parseLocation } from "./ui/nav";
import { TooltipLayer } from "./cg/Tooltip";
import { GlobalView } from "./ui/GlobalView";
import { FeedView } from "./ui/FeedView";
import { CogView } from "./ui/CogView";
import { FinalScores } from "./ui/FinalScores";
import { ViewSwitcher } from "./ui/ViewSwitcher";
import { ConsoleControls } from "./ui/ConsoleControls";
import { seatAlias, seatColor } from "./colors";
import { Wordmark } from "./cg/atoms";
import {
  beatKindAt,
  EVENT_W,
  endcardAt,
  eliminationAt,
  lastResolvedTurn,
  leaderSeat,
  razeCountAt,
  wallShare,
} from "./cg/derive";
import { MAX_TURNS } from "../shared/engine/constants";
import type { GameSnapshot } from "../shared/snapshot";
import logoIcon from "./icons/transparent/logo.png";

/** The three phases exposed to the chrome, in order. */
const PHASES = [
  { id: "commit", label: "Commit" },
  { id: "resolve", label: "Resolve" },
  { id: "upkeep", label: "Upkeep" },
];

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Tell the embed we are painted. The ATTRIBUTE first, the bridge second. */
function signalLoaded(): void {
  document.documentElement.dataset.replayLoaded = "true";
  try {
    window.parent.postMessage({ src: "coworld-replay", type: "ready" }, "*");
  } catch {
    // A sandboxed frame may refuse; the attribute is the primary signal.
  }
}

function signalError(message: string): void {
  document.documentElement.dataset.replayError = message;
  try {
    window.parent.postMessage({ src: "coworld-replay", type: "error", message }, "*");
  } catch {
    /* the attribute is the primary signal */
  }
}

/**
 * Replay the recorded events through the sim and DRAW THE RE-DERIVATION: the
 * store's snapshot timeline is replaced by the states the engine reproduced, so
 * every panel reads a re-simulated frame rather than a recorded one. Sets (and
 * returns) `data-replay-rederived` — see the header. Never throws: a recording
 * this build cannot re-derive keeps the recorded frames and says so.
 */
function adoptRederivation(store: FeedStore, frames: readonly CogwebMessage[]): string {
  const outcome = ((): string => {
    let derived;
    try {
      derived = rederiveReplay(frames);
    } catch {
      return "false";
    }
    if (derived.snapshots.length === 0 || derived.snapshots.length !== store.snapshots.length) return "false";
    store.snapshots = derived.snapshots;
    return derived.mismatch === null ? "true" : "mismatch";
  })();
  // Reported the moment it is known (a load-time fact, not a paint-time one), so
  // a harness can read it without waiting on the first frame.
  if (typeof document !== "undefined") document.documentElement.dataset.replayRederived = outcome;
  return outcome;
}

/** The per-turn rail detail: a stacked territory share bar, a ✖N destruction
 *  count and a ☠ on any turn with an elimination. Each beat carries the CSS class
 *  for its kind (`.beat-raze` / `.beat-elim` / `.beat-smear` / `.beat-quiet`). */
function railExtra(snap: GameSnapshot, razes: number, elim: boolean, kind: string): React.ReactElement {
  const parts = wallShare(snap);
  const owned = parts.reduce((s, p) => s + p.n, 0);
  return (
    <span className={`beat beat-${kind}`} data-beat={kind}>
      <span className="beat-share">
        {parts.map((p) => (
          <span key={p.seat} style={{ width: `${(p.n / Math.max(1, owned)) * 100}%`, background: seatColor(p.seat) }} />
        ))}
      </span>
      {razes > 0 && <span className="beat-razes">✖{razes}</span>}
      {elim && <span className="beat-skull">☠</span>}
    </span>
  );
}

export function App({ replay: injected }: { replay?: Replay } = {}): React.ReactElement {
  const loc =
    typeof window !== "undefined" ? parseLocation(window.location) : { view: "global" as const, seat: null };
  const replayUrl =
    injected || typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("replay");
  // A static Coworld viewer gets the replay artifact URL in the page query; the
  // container's /client/replay route streams a recording; everything else is live.
  const replayMode = loc.replayLoop === true || replayUrl !== null || Boolean(injected);
  const liveMode = !replayMode;

  const storeRef = useRef<FeedStore>(
    (() => {
      const s = emptyStore();
      if (injected) for (const f of injected.frames) applyFrame(s, f as never);
      return s;
    })(),
  );
  // Once, on the first render: an injected replay is re-derived exactly like a
  // fetched one (a `useRef` argument would re-run this on every render).
  const rederived = useRef(false);
  if (injected && !rederived.current) {
    rederived.current = true;
    adoptRederivation(storeRef.current, injected.frames);
  }
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);
  const [index, setIndex] = useState(0);
  const [follow, setFollow] = useState(liveMode);
  const [playing, setPlaying] = useState(replayMode);
  const [loadError, setLoadError] = useState<string | null>(null);
  const signalled = useRef(false);

  // Load a recorded replay artifact in-browser and decode it into the same store
  // the live socket fills, so both paths render identically.
  useEffect(() => {
    if (injected || replayUrl === null) return;
    const abort = new AbortController();
    storeRef.current = emptyStore();
    setLoadError(null);
    void loadReplayFrames(replayUrl, abort.signal).then(
      (frames) => {
        if (abort.signal.aborted) return;
        const decode = makeCogwebDecoder();
        for (const frame of frames) for (const message of decode(frame)) applyFrame(storeRef.current, message);
        // Draw the re-derivation, not the recording.
        adoptRederivation(storeRef.current, frames);
        rerender();
      },
      (reason: unknown) => {
        if (abort.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setLoadError(`Replay failed to load: ${message}`);
        signalError(message);
      },
    );
    return () => abort.abort();
  }, [injected, replayUrl, rerender]);

  // Live / container-replay socket.
  useEffect(() => {
    if (injected || replayUrl !== null || typeof window === "undefined") return;
    storeRef.current = emptyStore();
    const conn = connectLiveFeed(
      storeRef.current,
      () => makeWorldSocket(liveFeedWsUrl(window.location)),
      rerender,
      makeCogwebDecoder,
    );
    return () => conn.stop();
  }, [injected, replayUrl, liveMode, rerender]);

  const store = storeRef.current;
  const snaps = store.snapshots;
  const endcard = endcardAt(store.events);
  // The game is over when the endcard has landed (or the status says so). Once
  // over, the playhead's head is the synthetic FINAL slot — the endcard.
  const over = endcard !== null || (store.status?.ended ?? false);
  const lastSlot = Math.max(0, snaps.length - 1) + (over ? 1 : 0);

  useEffect(() => {
    if ((follow || playing) && snaps.length) setIndex(follow && over ? lastSlot : snaps.length - 1);
  }, [snaps.length, follow, playing, over, lastSlot]);

  // Playback: one snapshot per 250 ms, LOOPING in replay mode so a short cert
  // replay outlasts a 15 s viewer soak.
  useEffect(() => {
    if (!playing || liveMode || snaps.length === 0) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1 < snaps.length ? i + 1 : replayMode ? 0 : (setPlaying(false), i))),
      250,
    );
    return () => clearInterval(id);
  }, [playing, liveMode, snaps.length, replayMode]);

  const snapshot: GameSnapshot | null = snaps.length ? snaps[Math.min(index, snaps.length - 1)]! : null;
  const viewingFinal = over && index > snaps.length - 1;

  // THE LOAD SIGNAL. Fires once, after the first frame has been applied AND
  // committed — a requestAnimationFrame callback runs after the browser has had
  // the chance to paint this commit.
  useEffect(() => {
    if (signalled.current || snapshot === null) return;
    signalled.current = true;
    const raf = requestAnimationFrame(() => signalLoaded());
    return () => cancelAnimationFrame(raf);
  }, [snapshot]);

  const turnNow = snapshot ? snapshot.turn : 0;
  const resolved = snapshot ? lastResolvedTurn(snapshot) : 0;
  const visibleEvents = store.events.filter((e) => e.turn <= resolved);
  const visibleMessages = store.messages.filter((m) => m.turn <= turnNow);
  const maxTurns = snapshot?.turns ?? MAX_TURNS;
  const phase = snapshot?.phase ?? "commit";

  const seekTurn = (turn: number): void => {
    const i = snaps.findIndex((s) => s.turn === turn);
    if (i >= 0) {
      setFollow(false);
      setIndex(i);
    }
  };
  const onSeek = (i: number): void => {
    setFollow(liveMode && i >= lastSlot);
    setIndex(i);
  };

  const roster: GameTopBarPlayer[] = (snapshot?.cogs ?? []).map((c) => ({
    id: c.seat,
    name: seatAlias(c.seat),
    status: c.life === "eliminated" ? "disconnected" : "ready",
    nameColor: seatColor(c.seat),
    title: `${seatAlias(c.seat)} — ${c.banked} paint earned`,
    score: <span style={{ color: seatColor(c.seat) }}>{c.banked}</span>,
  }));

  // Scrubber overview density + per-turn beats.
  const weightByTurn = new Map<number, number>();
  for (const { turn, event } of store.events) {
    weightByTurn.set(turn, (weightByTurn.get(turn) ?? 0) + (EVENT_W[event.kind] ?? 1));
  }
  const maxW = Math.max(1, ...weightByTurn.values());

  return (
    <div className="app">
      <TooltipLayer />
      <GameTopBar
        game={{
          name: "Territory",
          logoSrc: logoIcon,
          // The generated gear-as-O TERRITORY lockup; it replaces the logo box +
          // name text, and the phase line (#clock) still rides beside it.
          wordmark: <Wordmark small />,
          // #clock — the string the smoke's 0 % / 50 % / 100 % scrub readouts and
          // the --soak advance check compare. Digits, never notation.
          phaseLine: (
            <span id="clock">
              {snapshot ? `Turn ${Math.min(turnNow, maxTurns)} / ${maxTurns} · ${cap(phase)}` : "Loading…"}
            </span>
          ),
        }}
        players={roster}
        leading={
          replayUrl === null && !injected ? (
            <ViewSwitcher view={loc.view} seat={loc.seat} seats={(snapshot?.cogs ?? []).map((c) => c.seat)} />
          ) : undefined
        }
        trailing={
          <ConsoleControls
            status={store.status}
            live={liveMode}
            playing={playing}
            onTogglePlay={() => setPlaying((p) => !p)}
          />
        }
      />
      {!snapshot ? (
        <p className="loading">{loadError ?? (liveMode ? "Waiting for the live game…" : "Loading replay…")}</p>
      ) : (
        <>
          {/* THE STAGE. Every overlay lives in here, so nothing can paint into
              the transport band below. */}
          <div className="cg-stage">
            {loc.view === "global" && (
              <GlobalView
                snapshot={snapshot}
                events={visibleEvents}
                messages={visibleMessages}
                onSeekTurn={seekTurn}
              />
            )}
            {loc.view === "feed" && <FeedView messages={visibleMessages} />}
            {loc.view === "seat" && loc.seat !== null && (
              <CogView
                snapshot={snapshot}
                seat={loc.seat}
                events={visibleEvents}
                messages={visibleMessages}
                prompts={store.actPrompts[loc.seat] ?? []}
                onSeekTurn={seekTurn}
              />
            )}
            {/* The endcard renders ONLY on the synthetic FINAL slot, so every seek
                dismisses it by construction. */}
            {viewingFinal && (
              <FinalScores
                snapshot={snaps[snaps.length - 1] ?? snapshot}
                endcard={endcard}
                onReplay={() => {
                  setFollow(false);
                  setIndex(0);
                  setPlaying(true);
                }}
              />
            )}
          </div>
          {/* #scrub — the wrapper the viewer smoke clicks at 50 % and 100 %. Its
              per-turn rail cells are the real, labelled <button>s. */}
          <div id="scrub">
            <GameScrubberBar
              timeline={snaps}
              index={Math.min(index, lastSlot)}
              onSeek={onSeek}
              meta={(snap) => {
                const t = snap.turn - 1;
                return {
                  turn: Math.min(snap.turn, maxTurns),
                  density: (weightByTurn.get(t) ?? 0) / maxW,
                  leaderColor: seatColor(leaderSeat(snap)),
                  key: razeCountAt(store.events, t) > 0 || eliminationAt(store.events, t),
                };
              }}
              phases={PHASES}
              currentPhase={phase}
              phaseWord="Turn"
              maxTurns={maxTurns}
              final={over}
              renderRailExtra={(snap) => {
                const t = snap.turn - 1;
                return railExtra(
                  snap,
                  razeCountAt(store.events, t),
                  eliminationAt(store.events, t),
                  beatKindAt(store.events, t),
                );
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
