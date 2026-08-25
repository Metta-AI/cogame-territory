// URL <-> view mapping for the console. Views switch by navigation (the page
// reloads and reconnects to the right ws endpoint), so this stays a pure parser.
//
// Territory is served three ways: the Coworld container at "/" (plus the
// /client/{global,player,replay} viewer shells the certifier probes), the
// Observatory STATIC replay bundle at
// /v2/coworlds/replays/static/<cow_id>/<sha>/index.html?replay=…, and a local
// vite dev server. Every host-absolute path the client builds therefore hangs off
// whatever prefix the page is served under.
export type View = "global" | "feed" | "seat";

export interface DashLocation {
  view: View;
  seat: number | null;
  /** Replay viewer that auto-plays and loops (the Coworld `/client/replay` surface). */
  replayLoop?: boolean;
}

const INTERNAL_ROUTE = /(?:\/client\/(?:global|player|replay)|\/seat\/\d+|\/feed)$/;

/** The prefix the page is served under: "" at the instance root. */
export function instancePrefix(pathname: string): string {
  return pathname.replace(/\/+$/, "").replace(INTERNAL_ROUTE, "");
}

export function parseLocation(loc: { pathname: string; search: string }): DashLocation {
  const params = new URLSearchParams(loc.search);
  const path = loc.pathname.slice(instancePrefix(loc.pathname).length) || "/";
  if (path === "/client/global") return { view: "global", seat: null };
  if (path === "/client/player") {
    const slot = Number(params.get("slot"));
    return { view: "seat", seat: Number.isInteger(slot) && slot >= 0 ? slot : null };
  }
  if (path === "/client/replay") return { view: "global", seat: null, replayLoop: true };
  const m = path.match(/^\/seat\/(\d+)/);
  if (m) return { view: "seat", seat: Number(m[1]) };
  if (path.startsWith("/feed")) return { view: "feed", seat: null };
  const v = params.get("view");
  if (v === "feed") return { view: "feed", seat: null };
  if (v === "seat" && params.get("seat") !== null) return { view: "seat", seat: Number(params.get("seat")) };
  return { view: "global", seat: null };
}

export function viewHref(view: View, seat: number | null): string {
  if (view === "feed") return "/feed";
  if (view === "seat" && seat !== null) return `/seat/${seat}`;
  return "/";
}

/** The absolute same-origin URL for a view, hung off the instance prefix. Always
 *  absolute because embedded previews block root-relative hrefs from navigating. */
export function navUrl(loc: { pathname: string; href: string }, view: View, seat: number | null): string {
  return new URL(instancePrefix(loc.pathname) + viewHref(view, seat), loc.href).href;
}

/**
 * The feed WebSocket URL for the view the page is showing, hung off the instance
 * prefix. An https:// page must use wss:// (browsers block a mixed-content ws://).
 * The Coworld HOST serves only `/global` (live, and the per-slot agent view) and
 * `/replay` (a recording), so the container's `/client/*` routes map there.
 */
export function liveFeedWsUrl(loc: { protocol: string; host: string; pathname: string }): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  const prefix = instancePrefix(loc.pathname);
  const coworld = loc.pathname.match(/\/client\/(global|player|replay)$/);
  if (coworld) return `${proto}://${loc.host}${prefix}${coworld[1] === "replay" ? "/replay" : "/global"}`;
  return `${proto}://${loc.host}${prefix}/global`;
}
