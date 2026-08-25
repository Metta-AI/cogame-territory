// Where the spectator/player WebSocket lives, derived from the viewer's own page
// location. The cogweb hub serves a game instance at /<moduleId>/<instanceId>/ and
// routes that instance's socket upgrade by the same path prefix; a standalone
// single-game server (local dev, or a directly exposed container) serves at the
// root, where the socket is /ws. Deriving the socket URL from the page path keeps
// it pointed at the right instance under the hub without the client knowing which
// instance it is. Pure + framework-free so it stays unit-testable.

/** The page-location fields needed to locate the WebSocket. */
export interface PageLocation {
  protocol: string;
  host: string;
  pathname: string;
  search?: string;
}

/** The instance base path the page is served under ("" at the root). The hub
 *  serves /<moduleId>/<instanceId>/; we strip a trailing slash so the base is a
 *  clean prefix the socket (and relative assets) hang off. */
export function instanceBasePath(pathname: string): string {
  return pathname.replace(/\/+$/, "");
}

/** The WebSocket URL for the instance the page is showing.
 *
 *  Three serving shapes, in order:
 *  1. The hosted Observatory proxies a coworld viewer under a deep prefix
 *     (`<prefix>/client/{replay,global,player}`) and proxies the spectator socket
 *     at the *sibling* `<prefix>/{replay,global}` — the game-owned route the replay
 *     host serves frames on. The console enters at `/client/<view>` but must open the
 *     sibling socket, so map the page path to it (the player shell still spectates
 *     the global feed). Connecting to the `/client/...` page path itself never reaches
 *     the game container (the host rejects that upgrade) — the "waiting for the table"
 *     hang. See `runCoworldReplay` (`@cogweb/coworld`) for the `/replay`+`/global` paths.
 *  2. The cogweb hub serves `/<moduleId>/<instanceId>/` and routes the upgrade by that
 *     same prefix.
 *  3. A standalone single-game server serves at the root with the socket at `/ws`. */
export function spectatorWsUrl(loc: PageLocation): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  const proxied = loc.pathname.match(/^(.*)\/client\/(replay|global|player)(\/.*)?$/);
  if (proxied) {
    const feed = proxied[2] === "player" ? "global" : proxied[2];
    return `${proto}://${loc.host}${proxied[1]}/${feed}${proxied[3] ?? ""}`;
  }
  const base = instanceBasePath(loc.pathname);
  return `${proto}://${loc.host}${base || "/ws"}`;
}

/** Whether the page is showing a recorded REPLAY (vs a live spectator/global feed
 *  or the player shell). The replay host serves its console at `<prefix>/client/replay`
 *  (the hosted Observatory embed) or `/replay` (a standalone `coworld replay` server);
 *  the live console is `/client/global` or the instance root, and the agent shell is
 *  `/client/player`. A console can read this to default into a replay-appropriate view
 *  (e.g. open the full-bleed game feed instead of the board). Mirrors the view-segment
 *  parsing in {@link spectatorWsUrl} so the two stay in lockstep. */
export function isReplayView(loc: PageLocation): boolean {
  if (new URLSearchParams(loc.search ?? "").has("replay")) return true;
  const proxied = loc.pathname.match(/^(.*)\/client\/(replay|global|player)(\/.*)?$/);
  if (proxied) return proxied[2] === "replay";
  return /^\/replay\/?$/.test(loc.pathname);
}

/** The browser feed source for either a content-addressed static viewer
 *  (`?replay=<artifact URL>`) or the existing live/container WebSocket path. */
export function viewerFeedSource(loc: PageLocation): { replayUrl: string } | { socketUrl: string } {
  const replayUrl = new URLSearchParams(loc.search ?? "").get("replay");
  return replayUrl === null ? { socketUrl: spectatorWsUrl(loc) } : { replayUrl };
}

/** When a per-game console is served UNDER the cogweb hub (path
 *  `/<moduleId>/<instanceId>/…`), the URL of the ONE shared portal lobby for that
 *  table — so the console hands lobby-phase traffic to the unified lobby instead of
 *  rendering its own. Returns null at the root, where a standalone single-game
 *  server keeps its own lobby. Any `?seat=&token=` is carried through so an invite
 *  link still lands on its reserved seat. */
export function portalLobbyUrl(loc: PageLocation & { search?: string }): string | null {
  const parts = instanceBasePath(loc.pathname).split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const moduleId = parts[0]!;
  const instanceId = parts[1]!;
  const incoming = new URLSearchParams(loc.search ?? "");
  const out = new URLSearchParams({ game: moduleId, id: instanceId });
  const seat = incoming.get("seat");
  const token = incoming.get("token");
  if (seat !== null) out.set("seat", seat);
  if (token !== null) out.set("token", token);
  return `${loc.protocol}//${loc.host}/?${out.toString()}`;
}
