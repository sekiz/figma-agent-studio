/**
 * Font protocol (DoD): every text mutation loads all fonts of the node first. When a font is not
 * installed, the node falls back to Inter Regular instead of failing the whole plan.
 */

export const INTER: FontName = { family: "Inter", style: "Regular" };
const loaded = new Set<string>();
const missing = new Set<string>();
const key = (f: FontName) => `${f.family}|${f.style}`;

export async function tryLoad(font: FontName): Promise<boolean> {
  const k = key(font);
  if (loaded.has(k)) return true;
  if (missing.has(k)) return false;
  try {
    await figma.loadFontAsync(font);
    loaded.add(k);
    return true;
  } catch {
    missing.add(k);
    return false;
  }
}

export async function loadFirst(candidates: FontName[]): Promise<FontName> {
  for (const f of candidates) if (await tryLoad(f)) return f;
  await figma.loadFontAsync(INTER);
  return INTER;
}

export function fontsOf(node: TextNode): FontName[] {
  if (node.characters.length === 0) return node.fontName === figma.mixed ? [] : [node.fontName];
  return node.getRangeAllFontNames(0, node.characters.length);
}

/** Loads every font used by the node; swaps unavailable ones for Inter Regular. Returns warnings. */
export async function ensureTextFonts(node: TextNode): Promise<string[]> {
  const warnings: string[] = [];
  const fonts = fontsOf(node);
  let allOk = true;
  for (const f of fonts) if (!(await tryLoad(f))) allOk = false;
  if (!allOk) {
    await figma.loadFontAsync(INTER);
    node.fontName = INTER;
    warnings.push(`"${node.name}": font ${fonts.map((f) => `${f.family} ${f.style}`).join(", ")} is not installed — fell back to Inter Regular.`);
  }
  return warnings;
}

/** Switches a text node to the first available family, keeping its style (or Regular). */
export async function switchFamily(node: TextNode, families: string[]): Promise<string | null> {
  const current = node.fontName === figma.mixed ? (fontsOf(node)[0] ?? INTER) : node.fontName;
  for (const family of families) {
    if (family === current.family) return family;
    for (const style of [current.style, "Regular"]) {
      if (await tryLoad({ family, style })) {
        node.fontName = { family, style };
        return family;
      }
    }
  }
  return null;
}
