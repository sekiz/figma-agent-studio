import { rgbaToHex, walk, type DsIndex, type DsVariable, type NodeSnapshot, type Rgba } from "@figma-studio/shared-types";

export type TargetStack = "react_tailwind" | "swiftui" | "jetpack_compose" | "react_native";

export interface LedgerRow {
  token: string;
  value: string;
  css: string;
  tailwind: string;
  native: string;
  kind: "color" | "spacing" | "radius" | "number" | "hardcoded";
}

export const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

export const camel = (s: string) => kebab(s).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** "color/surface-primary" → "surface-primary"; "spacing/4" → "4". Drops the category prefix. */
export function tokenLeaf(name: string): string {
  const parts = name.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^(colou?rs?|spacing|space|radius|radii|corner|size|sizes|semantic|primitives?)$/i.test(parts[0]!)) parts.shift();
  return parts.join("-");
}

export function variableKind(v: DsVariable): LedgerRow["kind"] {
  if (v.resolvedType === "COLOR") return "color";
  if (/radi|corner|round/i.test(v.name)) return "radius";
  if (/spac|gap|pad|space|inset|gutter/i.test(v.name)) return "spacing";
  return "number";
}

const TW_RADIUS: Record<number, string> = { 0: "rounded-none", 2: "rounded-xs", 4: "rounded-sm", 6: "rounded-md", 8: "rounded-lg", 12: "rounded-xl", 16: "rounded-2xl", 24: "rounded-3xl", 9999: "rounded-full" };

export function tailwindSpacing(value: number, prefix: string): string {
  return value % 4 === 0 ? `${prefix}-${value / 4}` : `${prefix}-[${value}px]`;
}

export function tailwindRadius(value: number): string {
  return TW_RADIUS[value] ?? `rounded-[${value}px]`;
}

export function formatValue(v: DsVariable): string {
  if (v.value === undefined) return "—";
  if (typeof v.value === "object") return rgbaToHex(v.value as Rgba, true);
  return typeof v.value === "number" ? `${v.value}` : String(v.value);
}

export function nativeToken(v: DsVariable, stack: TargetStack): string {
  const kind = variableKind(v);
  const leaf = tokenLeaf(v.name);
  const num = typeof v.value === "number" ? v.value : 0;
  switch (stack) {
    case "swiftui":
      if (v.codeSyntax?.iOS) return v.codeSyntax.iOS;
      return kind === "color" ? `Color("${camel(leaf)}")` : `${num} // Spacing.${camel(leaf)}`;
    case "jetpack_compose":
      if (v.codeSyntax?.ANDROID) return v.codeSyntax.ANDROID;
      return kind === "color" ? `AppTheme.colors.${camel(leaf)}` : `${num}.dp // AppTheme.spacing.${camel(leaf)}`;
    case "react_native":
      return kind === "color" ? `theme.colors.${camel(leaf)}` : `theme.${kind === "radius" ? "radii" : "space"}.${camel(leaf)} // ${num}`;
    case "react_tailwind":
      return v.codeSyntax?.WEB ?? `var(--${kebab(v.name)})`;
  }
}

export function ledgerRowFor(v: DsVariable, stack: TargetStack): LedgerRow {
  const kind = variableKind(v);
  const leaf = kebab(tokenLeaf(v.name));
  const num = typeof v.value === "number" ? v.value : 0;
  const tailwind =
    kind === "color" ? `bg-${leaf} / text-${leaf}` : kind === "radius" ? tailwindRadius(num) : kind === "spacing" ? `${tailwindSpacing(num, "p")} / ${tailwindSpacing(num, "gap")}` : `[${num}px]`;
  return {
    token: v.name,
    value: kind === "color" ? formatValue(v) : `${formatValue(v)}px`,
    css: v.codeSyntax?.WEB ?? `var(--${kebab(v.name)})`,
    tailwind,
    native: nativeToken(v, stack),
    kind,
  };
}

/** Collects every variable bound anywhere in the tree, plus hardcoded colors that have no token. */
export function buildLedger(root: NodeSnapshot, index: DsIndex, stack: TargetStack, maxHardcoded = 8): LedgerRow[] {
  const byId = new Map(index.variables.map((v) => [v.id, v]));
  const used = new Set<string>();
  const hardcoded = new Set<string>();
  for (const { node, ancestors } of walk(root)) {
    if (ancestors.some((a) => a.type === "INSTANCE")) continue;
    for (const p of [...(node.fills ?? []), ...(node.strokes ?? [])]) {
      if (p.boundVariableId) used.add(p.boundVariableId);
      else if (p.visible && p.type === "SOLID" && p.color) hardcoded.add(rgbaToHex(p.color));
    }
    for (const id of Object.values(node.boundVariables ?? {})) used.add(id);
  }
  const rows: LedgerRow[] = [...used]
    .map((id) => byId.get(id))
    .filter((v): v is DsVariable => Boolean(v))
    .map((v) => ledgerRowFor(v, stack))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.token.localeCompare(b.token));
  for (const hex of [...hardcoded].slice(0, maxHardcoded)) {
    rows.push({ token: "⚠ hardcoded", value: hex, css: hex, tailwind: `bg-[${hex}]`, native: stack === "swiftui" ? `Color(hex: "${hex}")` : stack === "jetpack_compose" ? `Color(0xFF${hex.slice(1)})` : `"${hex}"`, kind: "hardcoded" });
  }
  return rows;
}
