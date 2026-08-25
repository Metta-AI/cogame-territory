// Imported image assets resolve to their (build-inlined) URL string. Cogherence's
// art is imported (not referenced by `public/` path) so the bundle inlines each PNG
// as a data URI — a path-relative `icons/*.png` 404s under the Observatory replay
// proxy and the static bundle's deep serving prefix, but a data URI renders
// everywhere. Mirrors coguire/agricogla (see LEAGUE.md §4).
declare module "*.png" {
  const src: string;
  export default src;
}
