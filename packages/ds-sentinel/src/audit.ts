import {
  rgbaToHex,
  sameColor,
  walk,
  type DsIndex,
  type DsVariable,
  type MutationPlan,
  type NodeSnapshot,
  type Path,
  type PlanOp,
  type Rgba,
} from "@figma-studio/shared-types";
import { contrastRatio, composite, requiredRatio, resolveBackground, topPaint } from "./contrast.js";

export type AuditRule =
  | "detached_component"
  | "hardcoded_color"
  | "off_palette_color"
  | "off_grid_spacing"
  | "unbound_spacing"
  | "contrast"
  | "contrast_unverifiable";

export interface AuditFinding {
  rule: AuditRule;
  severity: "error" | "warning" | "info";
  nodeId: string;
  nodeName: string;
  path: Path;
  message: string;
  /** Present when the finding can be fixed safely (identical value → existing variable). */
  fix?: PlanOp;
}

export interface AuditReport {
  nodeId: string;
  nodeName: string;
  score: number;
  scannedNodes: number;
  counts: Record<AuditRule, number>;
  findings: AuditFinding[];
  /** Plan that binds every safely-fixable value to its variable (apply with mode "existing"). */
  fixPlan: MutationPlan | null;
}

export interface AuditOptions {
  /** Base grid for spacing checks (default 4). */
  grid?: number;
}

const SPACING_FIELDS = ["itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "counterAxisSpacing"] as const;
const COLOR_SCOPES_TEXT = ["ALL_SCOPES", "TEXT_FILL", "ALL_FILLS"];
const COLOR_SCOPES_SHAPE = ["ALL_SCOPES", "ALL_FILLS", "FRAME_FILL", "SHAPE_FILL"];
const COLOR_SCOPES_STROKE = ["ALL_SCOPES", "STROKE_COLOR"];
const SPACING_SCOPES = ["ALL_SCOPES", "GAP", "WIDTH_HEIGHT"];

function scopeOk(v: DsVariable, wanted: string[]): boolean {
  return !v.scopes || v.scopes.length === 0 || v.scopes.some((s) => wanted.includes(s));
}

export function findColorVariable(index: DsIndex, color: Rgba, scopes: string[]): DsVariable | undefined {
  const matches = index.variables.filter(
    (v) => v.resolvedType === "COLOR" && typeof v.value === "object" && v.value !== null && sameColor(v.value as Rgba, color),
  );
  return matches.find((v) => scopeOk(v, scopes) && v.scopes && !v.scopes.includes("ALL_SCOPES")) ?? matches.find((v) => scopeOk(v, scopes));
}

export function findSpacingVariable(index: DsIndex, value: number): DsVariable | undefined {
  const matches = index.variables.filter(
    (v) => v.resolvedType === "FLOAT" && v.value === value && scopeOk(v, SPACING_SCOPES) && /spac|gap|pad|space|inset|gutter|size/i.test(v.name),
  );
  // "Safe" means unambiguous: exactly one spacing token carries this value.
  return matches.length === 1 ? matches[0] : undefined;
}

function componentNames(index: DsIndex): Set<string> {
  const names = new Set<string>();
  for (const c of index.components) {
    const base = c.componentSetName ?? c.name;
    names.add(base.toLowerCase());
    const last = base.split("/").pop()?.trim().toLowerCase();
    if (last && last.length > 2) names.add(last);
  }
  return names;
}

export function auditDesignSystem(root: NodeSnapshot, index: DsIndex, options: AuditOptions = {}): AuditReport {
  const grid = options.grid ?? 4;
  const findings: AuditFinding[] = [];
  const dsNames = componentNames(index);
  const hasColorTokens = index.variables.some((v) => v.resolvedType === "COLOR");
  let scanned = 0;

  for (const { node, path, ancestors } of walk(root)) {
    scanned++;
    if (!node.visible) continue;
    const insideInstance = ancestors.some((a) => a.type === "INSTANCE");
    const base = { nodeId: node.id, nodeName: node.name, path };

    // 1. Detached components: a plain frame/group carrying a design-system component's name.
    if ((node.type === "FRAME" || node.type === "GROUP") && !insideInstance && path.length > 0) {
      const nm = node.name.trim().toLowerCase();
      if (dsNames.has(nm) || dsNames.has(nm.split("/").pop()?.trim() ?? "")) {
        findings.push({ ...base, rule: "detached_component", severity: "error", message: `"${node.name}" looks like a detached copy of a design-system component; replace it with an instance.` });
      }
    }

    // 2. Colors: identical hex → bind to variable; unknown hex → off-palette.
    if (!insideInstance) {
      const paintGroups: Array<["fills" | "strokes", string[]]> = [
        ["fills", node.type === "TEXT" ? COLOR_SCOPES_TEXT : COLOR_SCOPES_SHAPE],
        ["strokes", COLOR_SCOPES_STROKE],
      ];
      for (const [field, scopes] of paintGroups) {
        (node[field] ?? []).forEach((p, paintIndex) => {
          if (!p.visible || p.type !== "SOLID" || !p.color || p.boundVariableId) return;
          const hex = rgbaToHex(p.color);
          const variable = findColorVariable(index, p.color, scopes);
          if (variable) {
            findings.push({
              ...base,
              rule: "hardcoded_color",
              severity: "warning",
              message: `${field === "fills" ? "Fill" : "Stroke"} ${hex} is hardcoded but equals variable "${variable.name}".`,
              fix: { op: "bindVariable", path, field, variableId: variable.id, paintIndex },
            });
          } else if (hasColorTokens) {
            findings.push({ ...base, rule: "off_palette_color", severity: "warning", message: `${field === "fills" ? "Fill" : "Stroke"} ${hex} is not in the design-system palette.` });
          }
        });
      }
    }

    // 3. Spacing: off-grid values and unbound values that have an exact token.
    if (!insideInstance && (node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL")) {
      for (const field of SPACING_FIELDS) {
        const value = node[field];
        if (typeof value !== "number" || value === 0 || node.boundVariables?.[field]) continue;
        if (field === "itemSpacing" && node.primaryAxisAlignItems === "SPACE_BETWEEN") continue;
        if (value % grid !== 0) {
          findings.push({ ...base, rule: "off_grid_spacing", severity: "warning", message: `${field} = ${value} is off the ${grid}-pt grid.` });
          continue;
        }
        const variable = findSpacingVariable(index, value);
        if (variable) {
          findings.push({
            ...base,
            rule: "unbound_spacing",
            severity: "info",
            message: `${field} = ${value} matches token "${variable.name}" but is not bound.`,
            fix: { op: "bindVariable", path, field, variableId: variable.id },
          });
        }
      }
    }

    // 4. WCAG contrast for text.
    if (node.type === "TEXT" && typeof node.fontSize === "number") {
      const fg = topPaint(node.fills);
      if (!fg) continue;
      if ("nonSolid" in fg) {
        findings.push({ ...base, rule: "contrast_unverifiable", severity: "info", message: `Text uses a ${fg.nonSolid.toLowerCase()} fill; contrast must be checked manually.` });
        continue;
      }
      const bg = resolveBackground(node, ancestors);
      if (bg.kind === "unverifiable") {
        findings.push({ ...base, rule: "contrast_unverifiable", severity: "info", message: `Background is a ${bg.reason}; contrast must be checked manually.` });
        continue;
      }
      const text = composite(fg.color, bg.color);
      const ratio = contrastRatio(text, bg.color);
      const needed = requiredRatio(node.fontSize, node.fontWeight);
      if (ratio < needed) {
        findings.push({
          ...base,
          rule: "contrast",
          severity: "error",
          message: `Contrast ${ratio}:1 (${rgbaToHex(text)} on ${rgbaToHex(bg.color)}) is below WCAG AA ${needed}:1${bg.assumedCanvas ? " (white canvas assumed)" : ""}.`,
        });
      }
    }
  }

  const counts = Object.fromEntries(
    (["detached_component", "hardcoded_color", "off_palette_color", "off_grid_spacing", "unbound_spacing", "contrast", "contrast_unverifiable"] as AuditRule[]).map((r) => [
      r,
      findings.filter((f) => f.rule === r).length,
    ]),
  ) as Record<AuditRule, number>;
  const penalty = findings.reduce((sum, f) => sum + (f.severity === "error" ? 5 : f.severity === "warning" ? 2 : 0.5), 0);
  const fixes = findings.flatMap((f) => (f.fix ? [f.fix] : []));

  return {
    nodeId: root.id,
    nodeName: root.name,
    score: Math.max(0, Math.round(100 - penalty)),
    scannedNodes: scanned,
    counts,
    findings,
    fixPlan: fixes.length > 0 ? { root: { mode: "existing", nodeId: root.id }, ops: fixes, label: "Bind design tokens" } : null,
  };
}
