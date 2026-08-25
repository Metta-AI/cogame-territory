// Pure axial(q,r) -> pixel geometry for pointy-top hexes. No React, no DOM.
export interface Point {
  x: number;
  y: number;
}

/** Center of hex (q,r) for a given circumradius `size`. Origin hex sits at (0,0). */
export function axialToPixel(q: number, r: number, size: number): Point {
  return { x: size * Math.sqrt(3) * (q + r / 2), y: size * (3 / 2) * r };
}

/** The 6 corner points of a pointy-top hex centered at (cx,cy). */
export function hexCorners(cx: number, cy: number, size: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(a), y: cy + size * Math.sin(a) });
  }
  return pts;
}

/** Format corners as an SVG <polygon points="..."> string. */
export function polygonPoints(corners: Point[]): string {
  return corners.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}
