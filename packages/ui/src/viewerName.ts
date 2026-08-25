// The viewer's display name — one browser-global identity persisted under a single
// key and shared by the portal and every game console, so the name you pick in the
// lobby is the name you take a seat under anywhere. `null` until you've named
// yourself; callers prompt (NamePrompt) when this returns null rather than inventing
// a placeholder like "You".
const VIEWER_NAME_KEY = "cogweb.name";

export function loadViewerName(): string | null {
  return localStorage.getItem(VIEWER_NAME_KEY);
}

export function saveViewerName(name: string): void {
  localStorage.setItem(VIEWER_NAME_KEY, name);
}
