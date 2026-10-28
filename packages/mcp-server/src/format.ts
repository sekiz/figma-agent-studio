import type { AuditReport } from "@figma-studio/ds-sentinel";
import type { NodeSnapshot } from "@figma-studio/shared-types";

/**
 * Token-efficient renderers for tool results.
 *
 * Results are plain text, not pretty-printed JSON: models read them as well, and they cost a
 * fraction of the tokens. Every line keeps the ids the agent needs for a follow-up call.
 */

export type Detail = "concise" | "detailed";

const QUOTED = /"[^"]*"/g;

/**
 * Collapses repeated warnings ("Text A: font X missing", "Text B: font X missing", …) into one
 * line with a count, an example and the surfaces it applies to, so 200 text layers on four
 * surfaces produce one line instead of 800.
 */
export function groupWarnings(warnings: Array<string | { text: string; scope?: string }>, max = 6): string[] {
  const groups = new Map<string, { count: number; example: string; scopes: Set<string> }>();
  for (const w of warnings) {
    const text = typeof w === "string" ? w : w.text;
    const scope = typeof w === "string" ? undefined : w.scope;
    const key = text.replace(/^"[^"]*":\s*/, "").replace(/^op #\d+ /, "op ").replace(QUOTED, "…").replace(/\d+/g, "#");
    const g = groups.get(key) ?? { count: 0, example: text, scopes: new Set<string>() };
    g.count++;
    if (scope) g.scopes.add(scope);
    groups.set(key, g);
  }
  const lines = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => `${g.count > 1 ? `${g.count}× ` : ""}${g.scopes.size ? `[${[...g.scopes].join(", ")}] ` : ""}${g.example}`);
  return lines.length > max ? [...lines.slice(0, max), `…${lines.length - max} more kinds (detail="detailed" lists all)`] : lines;
}

export function section(title: string, lines: string[]): string {
  return lines.length ? `\n${title}\n${lines.map((l) => `• ${l}`).join("\n")}` : "";
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * One line per layer: `1:4 FRAME "Header" 1440×80 row gap16 → Button/Size=M "Buy now"`.
 * Depth- and line-limited, with a hint on how to drill down instead of re-reading everything.
 */
export function outline(root: NodeSnapshot, maxLines = 80): string {
  const lines: string[] = [];
  let hidden = 0;
  const visit = (n: NodeSnapshot, depth: number) => {
    if (lines.length >= maxLines) {
      hidden++;
      return;
    }
    const parts = [`${"  ".repeat(depth)}${n.id} ${n.type} "${short(n.name, 40)}" ${Math.round(n.width)}×${Math.round(n.height)}`];
    if (n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL") {
      parts.push(`${n.layoutMode === "HORIZONTAL" ? "row" : "col"}${n.layoutWrap === "WRAP" ? "-wrap" : ""}${n.itemSpacing ? ` gap${n.itemSpacing}` : ""}`);
    }
    if (n.component?.mainComponentName) parts.push(`→ ${n.component.componentSetName ? `${n.component.componentSetName}/` : ""}${n.component.mainComponentName}`);
    if (n.type === "TEXT" && n.characters) parts.push(`"${short(n.characters.replace(/\s+/g, " "), 32)}"${n.fontSize ? ` ${n.fontSize}px` : ""}`);
    if (!n.visible) parts.push("(hidden)");
    lines.push(parts.join(" "));
    (n.children ?? []).forEach((c) => visit(c, depth + 1));
    if (n.truncatedChildren) lines.push(`${"  ".repeat(depth + 1)}… ${n.truncatedChildren} children below depth limit`);
  };
  visit(root, 0);
  if (hidden) lines.push(`… ${hidden} more layers. Inspect a child id to drill down instead of raising maxLines.`);
  return lines.join("\n");
}

const RULE_LABEL: Record<string, string> = {
  contrast: "WCAG contrast",
  detached_component: "Detached components",
  hardcoded_color: "Hardcoded colors (token exists)",
  off_palette_color: "Off-palette colors",
  off_grid_spacing: "Off-grid spacing",
  unbound_spacing: "Unbound spacing tokens",
  contrast_unverifiable: "Contrast needs manual check",
};

export function auditText(report: AuditReport, detail: Detail, fixed: number | null): string {
  const head = `DS health ${report.score}/100 · "${report.nodeName}" (${report.nodeId}) · ${report.scannedNodes} layers scanned`;
  const order = ["contrast", "detached_component", "hardcoded_color", "off_palette_color", "off_grid_spacing", "unbound_spacing", "contrast_unverifiable"];
  const perRule = detail === "detailed" ? Infinity : 3;
  const blocks: string[] = [];
  for (const rule of order) {
    const items = report.findings.filter((f) => f.rule === rule);
    if (!items.length) continue;
    const shown = items.slice(0, perRule).map((f) => `${f.nodeId} ${f.message}`);
    if (items.length > shown.length) shown.push(`…${items.length - shown.length} more`);
    blocks.push(section(`${RULE_LABEL[rule] ?? rule} (${items.length})`, shown));
  }
  const fixes = report.fixPlan?.ops.length ?? 0;
  const tail =
    fixed !== null ? `\nAuto-fixed ${fixed} token binding(s).` : fixes ? `\n${fixes} safe token binding(s) available: rerun with autoFixSafeTokens=true.` : "";
  return `${head}${blocks.join("") || "\nNo findings."}${tail}`;
}
