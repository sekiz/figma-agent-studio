import { PLUGIN_DATA_SURFACE, SURFACE_LABELS, type DsIndex, type HandoffSpec, type NodeSnapshot, type Surface } from "@figma-studio/shared-types";
import { generateCode } from "./codegen.js";
import { buildLedger, type TargetStack } from "./tokens.js";

const WIDTH_HINTS: Array<[number, Surface]> = [
  [393, "ios"],
  [412, "android_m3"],
  [1920, "smart_tv_10ft"],
  [834, "tablet"],
];

export function detectPlatform(root: NodeSnapshot): { label: string; unit: string } {
  const tagged = root.pluginData?.[PLUGIN_DATA_SURFACE] as Surface | undefined;
  const surface = tagged ?? WIDTH_HINTS.find(([w]) => Math.abs(root.width - w) < 1)?.[1];
  if (!surface) return { label: "Web", unit: "px" };
  const unit = surface === "android_m3" ? "dp" : surface === "smart_tv_10ft" ? "px" : "pt";
  return { label: SURFACE_LABELS[surface], unit };
}

function sizingText(n: NodeSnapshot, unit: string): string {
  const h = n.layoutSizingHorizontal;
  const width = h === "FILL" ? "fluid, fills 100% of its container" : h === "HUG" ? "hugs its content" : `fixed ${Math.round(n.width)}${unit}`;
  const parts = [`Width: ${width}`];
  if (n.layoutWrap === "WRAP") parts.push("wraps children onto new rows");
  if (n.layoutMode === "HORIZONTAL" && n.clipsContent) parts.push("horizontal scroll / carousel");
  if (typeof n.minHeight === "number") parts.push(`min-height ${n.minHeight}${unit}`);
  if (typeof n.minWidth === "number") parts.push(`min-width ${n.minWidth}${unit} (touch target)`);
  return parts.join("; ");
}

/** Responsive notes for the root and its containers down to `depth` levels. */
export function responsiveNotes(root: NodeSnapshot, unit: string, platformLabel: string, depth = 2, max = 12): HandoffSpec["notes"] {
  const notes: HandoffSpec["notes"] = [
    { target: root.name, text: `Viewport: ${Math.round(root.width)}${unit} wide on ${platformLabel}; height ${root.layoutSizingVertical === "HUG" || root.layoutMode === "VERTICAL" ? "grows with content (scrolls)" : `fixed ${Math.round(root.height)}${unit}`}.` },
  ];
  const visit = (n: NodeSnapshot, d: number) => {
    for (const c of n.children ?? []) {
      if (notes.length >= max) return;
      if (!c.visible || c.type === "TEXT") continue;
      if (c.layoutPositioning === "ABSOLUTE") notes.push({ target: c.name, text: "Absolutely positioned; pinned by constraints, not part of the flow." });
      else if (c.layoutSizingHorizontal) notes.push({ target: c.name, text: sizingText(c, unit) });
      if (d < depth && c.type !== "INSTANCE") visit(c, d + 1);
    }
  };
  visit(root, 1);
  return notes;
}

export function buildHandoff(root: NodeSnapshot, index: DsIndex, stack: TargetStack): HandoffSpec {
  const platform = detectPlatform(root);
  const ledger = buildLedger(root, index, stack).map(({ kind: _kind, ...row }) => row);
  return {
    title: `[HANDOFF] ${root.name} - ${platform.label}`,
    platformLabel: platform.label,
    ledger,
    notes: responsiveNotes(root, platform.unit, platform.label),
    code: generateCode(root, index, stack),
  };
}

export function handoffToMarkdown(spec: HandoffSpec): string {
  const rows = spec.ledger.map((r) => `| ${r.token} | ${r.value} | \`${r.css}\` | \`${r.tailwind}\` | \`${r.native}\` |`);
  return [
    `## ${spec.title}`,
    "",
    "### Token ledger",
    "| Token | Value | CSS | Tailwind v4 | Native |",
    "|---|---|---|---|---|",
    ...(rows.length ? rows : ["| — | — | — | — | — |"]),
    "",
    "### Responsive behavior",
    ...spec.notes.map((n) => `- **${n.target}** — ${n.text}`),
    "",
    "### Code scaffold",
    "```" + spec.code.language,
    spec.code.text,
    "```",
  ].join("\n");
}
