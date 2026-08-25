// A tiny pub-sub channel for cross-panel tile highlighting: hovering a tile
// pill anywhere (Turn Log, Pending Actions) lights the tile up on the lattice.
type Listener = (tiles: string[]) => void;
let listeners: Listener[] = [];

export function publishTileHighlight(tiles: string[]): void {
  for (const l of listeners) l(tiles);
}
export function subscribeTileHighlight(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}
