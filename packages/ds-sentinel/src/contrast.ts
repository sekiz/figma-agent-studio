import type { NodeSnapshot, PaintSnapshot, Rgba } from "@figma-studio/shared-types";

/** WCAG 2.x relative luminance of an sRGB color (alpha ignored). */
export function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Source-over compositing of `top` onto an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

export function isLargeText(fontSize: number, fontWeight: number | null | undefined): boolean {
  return fontSize >= 24 || (fontSize >= 18.66 && (fontWeight ?? 400) >= 700);
}

export function requiredRatio(fontSize: number, fontWeight: number | null | undefined): number {
  return isLargeText(fontSize, fontWeight) ? 3 : 4.5;
}

/** Topmost visible paint of a node, flattened to a color with effective alpha; null when non-solid. */
export function topPaint(paints: PaintSnapshot[] | undefined): { color: Rgba } | { nonSolid: string } | null {
  const visible = (paints ?? []).filter((p) => p.visible && p.opacity > 0);
  const top = visible[visible.length - 1];
  if (!top) return null;
  if (top.type !== "SOLID" || !top.color) return { nonSolid: top.type };
  return { color: { ...top.color, a: top.color.a * top.opacity } };
}

const contains = (outer: NodeSnapshot, inner: { x: number; y: number; width: number; height: number }) =>
  outer.x <= inner.x + 0.5 &&
  outer.y <= inner.y + 0.5 &&
  outer.x + outer.width >= inner.x + inner.width - 0.5 &&
  outer.y + outer.height >= inner.y + inner.height - 0.5;

export type BackgroundResult =
  | { kind: "solid"; color: Rgba; assumedCanvas: boolean }
  | { kind: "unverifiable"; reason: string };

/**
 * Resolves the effective background behind `ancestors[last] → node` by walking up the tree:
 * at each level, earlier siblings that fully cover the node (rectangles behind text) count first,
 * then the parent's own fill. Stops at the first opaque layer; falls back to a white canvas.
 */
export function resolveBackground(node: NodeSnapshot, ancestors: NodeSnapshot[]): BackgroundResult {
  const layers: Rgba[] = [];
  let current: NodeSnapshot = node;
  let box = { x: node.x, y: node.y, width: node.width, height: node.height };

  for (let level = ancestors.length - 1; level >= 0; level--) {
    const parent = ancestors[level]!;
    const siblings = parent.children ?? [];
    const idx = siblings.indexOf(current);
    // In an Auto-Layout flow siblings sit side by side, so only absolute layers can lie underneath.
    const stacked = parent.layoutMode !== "HORIZONTAL" && parent.layoutMode !== "VERTICAL";
    for (let i = idx - 1; i >= 0; i--) {
      const s = siblings[i]!;
      if (!s.visible || s.type === "TEXT" || !contains(s, box)) continue;
      if (!stacked && s.layoutPositioning !== "ABSOLUTE") continue;
      const p = topPaint(s.fills);
      if (!p) continue;
      if ("nonSolid" in p) return { kind: "unverifiable", reason: `${p.nonSolid.toLowerCase()} fill on "${s.name}"` };
      layers.push(p.color);
      if (p.color.a >= 1) return { kind: "solid", color: flatten(layers), assumedCanvas: false };
    }
    const own = topPaint(parent.fills);
    if (own) {
      if ("nonSolid" in own) return { kind: "unverifiable", reason: `${own.nonSolid.toLowerCase()} fill on "${parent.name}"` };
      layers.push(own.color);
      if (own.color.a >= 1) return { kind: "solid", color: flatten(layers), assumedCanvas: false };
    }
    // Children of frames are positioned relative to the frame; groups share their parent's space.
    if (parent.type !== "GROUP") box = { x: box.x + parent.x, y: box.y + parent.y, width: box.width, height: box.height };
    current = parent;
  }
  layers.push({ r: 1, g: 1, b: 1, a: 1 });
  return { kind: "solid", color: flatten(layers), assumedCanvas: true };
}

/** layers[0] is closest to the text (on top); the last one is opaque. */
function flatten(layers: Rgba[]): Rgba {
  let acc = layers[layers.length - 1]!;
  acc = { ...acc, a: 1 };
  for (let i = layers.length - 2; i >= 0; i--) acc = composite(layers[i]!, acc);
  return acc;
}
