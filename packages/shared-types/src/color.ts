import type { Rgba } from "./snapshot.js";

export function rgbaToHex(c: Rgba, withAlpha = false): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
  return withAlpha && c.a < 1 ? `${base}${h(c.a).toUpperCase()}` : base;
}

export function hexToRgba(hex: string): Rgba {
  const m = hex.replace("#", "").trim();
  const full = m.length === 3 || m.length === 4 ? [...m].map((ch) => ch + ch).join("") : m;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) throw new Error(`invalid hex color: ${hex}`);
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 };
}

/** Colors are "identical" when every 8-bit channel matches. */
export function sameColor(a: Rgba, b: Rgba): boolean {
  return rgbaToHex(a, true) === rgbaToHex(b, true);
}
