import type { HandoffSpec, Rgba, SynthesizeSpec } from "@figma-studio/shared-types";
import { INTER, loadFirst } from "./fonts.js";

export const FUCHSIA: RGB = { r: 0xd9 / 255, g: 0x46 / 255, b: 0xef / 255 };
export const PLUGIN_DATA_FLAG = "fas.flag";

const solid = (c: RGB | Rgba, opacity = 1): SolidPaint => ({ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity });
const hex = (h: string): RGB => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });

export async function makeText(characters: string, opts: { size?: number; style?: string; color?: RGB; family?: string[]; width?: number } = {}): Promise<TextNode> {
  const families = opts.family ?? ["Inter"];
  const font = await loadFirst(families.map((family) => ({ family, style: opts.style ?? "Regular" })).concat([{ family: "Inter", style: opts.style ?? "Regular" }, INTER]));
  const t = figma.createText();
  t.fontName = font;
  t.fontSize = opts.size ?? 12;
  t.characters = characters;
  if (opts.color) t.fills = [solid(opts.color)];
  if (opts.width) {
    t.textAutoResize = "HEIGHT";
    t.resize(opts.width, t.height);
  }
  return t;
}

function stack(name: string, mode: "VERTICAL" | "HORIZONTAL", spacing = 0, padding = 0): FrameNode {
  const f = figma.createFrame();
  f.name = name;
  f.layoutMode = mode;
  f.primaryAxisSizingMode = "AUTO";
  f.counterAxisSizingMode = "AUTO";
  f.itemSpacing = spacing;
  f.paddingLeft = f.paddingRight = f.paddingTop = f.paddingBottom = padding;
  f.fills = [];
  f.clipsContent = false;
  return f;
}

/** Fixes a stack's width while it keeps hugging its content vertically (resize() pins both axes). */
function fixWidth(f: FrameNode, width: number): void {
  f.resize(width, Math.max(1, f.height));
  if (f.layoutMode === "VERTICAL") {
    f.counterAxisSizingMode = "FIXED";
    f.primaryAxisSizingMode = "AUTO";
  } else {
    f.primaryAxisSizingMode = "FIXED";
    f.counterAxisSizingMode = "AUTO";
  }
}

/** Visible-but-unexported audit flag placed on the page above the generated frame. */
export async function createFlag(root: SceneNode, target: SceneNode, title: string, message: string): Promise<FrameNode> {
  const flag = stack(`[DS-AUDIT-FLAG] ${title}`, "VERTICAL", 6, 16);
  flag.fills = [solid(FUCHSIA)];
  flag.cornerRadius = 12;
  fixWidth(flag, 360);
  const t = await makeText(title, { size: 14, style: "Bold", color: { r: 1, g: 1, b: 1 } });
  const m = await makeText(message, { size: 12, color: { r: 1, g: 1, b: 1 }, width: 328 });
  flag.appendChild(t);
  flag.appendChild(m);
  m.layoutSizingHorizontal = "FILL";

  const container = root.parent ?? figma.currentPage;
  (container as ChildrenMixin).appendChild(flag);
  const siblings = (container as ChildrenMixin).children.filter((n) => n !== flag && n.getPluginData(PLUGIN_DATA_FLAG) === root.id);
  const above = siblings.reduce((y, n) => Math.min(y, n.y), root.y);
  flag.x = root.x;
  flag.y = above - flag.height - 24;
  flag.setPluginData(PLUGIN_DATA_FLAG, root.id);
  flag.setPluginData("fas.target", target.id);

  // Dev Mode annotation on the affected layer (not available in every editor/plan — best effort).
  try {
    const annotated = target as SceneNode & { annotations?: ReadonlyArray<Annotation> };
    if ("annotations" in annotated) annotated.annotations = [...(annotated.annotations ?? []), { label: `${title}: ${message}` }];
  } catch {
    /* annotations unsupported here */
  }
  return flag;
}

export async function createPlaceholder(name: string, label: string, height: number, width?: number): Promise<FrameNode> {
  const f = stack(name, "VERTICAL", 0, 8);
  f.primaryAxisAlignItems = "CENTER";
  f.counterAxisAlignItems = "CENTER";
  f.primaryAxisSizingMode = "FIXED";
  f.counterAxisSizingMode = "FIXED";
  f.resize(width ?? 100, Math.max(1, height));
  f.fills = [solid(FUCHSIA, 0.08)];
  f.strokes = [solid(FUCHSIA)];
  f.strokeWeight = 1.5;
  f.dashPattern = [6, 4];
  f.cornerRadius = 4;
  f.appendChild(await makeText(label, { size: 12, style: "Medium", color: FUCHSIA }));
  return f;
}

async function proposalsPage(): Promise<PageNode> {
  const name = "🧩 DS Proposals";
  let page = figma.root.children.find((p) => p.name === name);
  if (!page) {
    page = figma.createPage();
    page.name = name;
  }
  await page.loadAsync();
  return page;
}

async function bindOrFill(node: MinimalFillsMixin, variableId: string | undefined, fallback: Rgba): Promise<void> {
  const base = solid(fallback, fallback.a);
  if (variableId) {
    const v = await figma.variables.getVariableByIdAsync(variableId);
    if (v) {
      node.fills = [figma.variables.setBoundVariableForPaint(base, "color", v)];
      return;
    }
  }
  node.fills = [base];
}

/** Option A of the missing-component protocol: a new master component built only from tokens. */
export async function synthesizeComponent(spec: SynthesizeSpec): Promise<ComponentNode> {
  const page = await proposalsPage();
  const c = figma.createComponent();
  c.name = spec.name;
  c.description = "Synthesized by figma-agent-studio from the file's tokens. Review, then move into your library.";
  c.layoutMode = spec.orientation === "vertical" ? "VERTICAL" : "HORIZONTAL";
  c.primaryAxisSizingMode = "FIXED";
  c.counterAxisSizingMode = "FIXED";
  c.resize(spec.width, spec.height);
  c.paddingLeft = c.paddingRight = spec.padding;
  c.paddingTop = c.paddingBottom = Math.min(spec.padding, 8);
  c.itemSpacing = spec.itemSpacing;
  c.cornerRadius = spec.cornerRadius;
  const vertical = spec.orientation === "vertical";
  c.primaryAxisAlignItems = vertical ? "MIN" : spec.slots.length > 0 ? "SPACE_BETWEEN" : "MIN";
  c.counterAxisAlignItems = vertical ? "MIN" : "CENTER";
  await bindOrFill(c, spec.surfaceVariableId, spec.fallbackSurface);

  if (spec.slots.length > 0) {
    for (const label of spec.slots) {
      const slot = stack(label, vertical ? "HORIZONTAL" : "VERTICAL", vertical ? 12 : 4, vertical ? 8 : 0);
      slot.counterAxisAlignItems = "CENTER";
      const icon = figma.createEllipse();
      icon.name = "Icon";
      icon.resize(24, 24);
      await bindOrFill(icon, spec.onSurfaceVariableId, spec.fallbackOnSurface);
      slot.appendChild(icon);
      const t = await makeText(label, { size: 11, style: "Medium" });
      await bindOrFill(t, spec.onSurfaceVariableId, spec.fallbackOnSurface);
      slot.appendChild(t);
      c.appendChild(slot);
      slot.layoutSizingHorizontal = "FILL";
    }
  } else if (spec.title !== undefined) {
    const t = await makeText(spec.title, { size: spec.height >= 90 ? 34 : 20, style: "Bold" });
    await bindOrFill(t, spec.onSurfaceVariableId, spec.fallbackOnSurface);
    c.appendChild(t);
  }

  const right = page.children.reduce((x, n) => Math.max(x, n.x + n.width), 0);
  page.appendChild(c);
  c.x = right + 80;
  c.y = 0;
  return c;
}

// ---------------------------------------------------------------------------
// Dev handoff section
// ---------------------------------------------------------------------------

const MONO = ["JetBrains Mono", "Roboto Mono", "Source Code Pro", "SF Mono", "Menlo", "Courier New"];

export async function renderHandoff(node: SceneNode, spec: HandoffSpec): Promise<SectionNode> {
  const content = stack("Handoff", "VERTICAL", 32, 0);

  const header = stack("Header", "VERTICAL", 4);
  header.appendChild(await makeText(spec.title, { size: 28, style: "Bold" }));
  header.appendChild(await makeText(`Generated by figma-agent-studio · ${new Date().toISOString().slice(0, 10)} · ${spec.platformLabel}`, { size: 13, color: hex("#64748B") }));
  content.appendChild(header);

  // Token ledger table
  const widths = [260, 110, 260, 240, 300];
  const table = stack("Token Ledger", "VERTICAL", 0);
  table.appendChild(await makeText("Token Variable Ledger", { size: 18, style: "Bold" }));
  const rows: string[][] = [["Token", "Value", "CSS", "Tailwind v4", "Native"], ...spec.ledger.map((r) => [r.token, r.value, r.css, r.tailwind, r.native])];
  if (spec.ledger.length === 0) rows.push(["No bound variables found", "—", "—", "—", "—"]);
  for (let i = 0; i < rows.length; i++) {
    const row = stack(i === 0 ? "Header Row" : `Row ${i}`, "HORIZONTAL", 0, 0);
    row.fills = [solid(i === 0 ? hex("#0F172A") : i % 2 ? hex("#FFFFFF") : hex("#F8FAFC"))];
    for (let j = 0; j < widths.length; j++) {
      const cell = stack(`Cell ${j}`, "VERTICAL", 0, 10);
      fixWidth(cell, widths[j]!);
      const t = await makeText(rows[i]![j] ?? "", {
        size: 12,
        style: i === 0 ? "Bold" : "Regular",
        color: i === 0 ? hex("#F8FAFC") : hex("#0F172A"),
        family: j >= 2 && i > 0 ? MONO : ["Inter"],
        width: widths[j]! - 20,
      });
      cell.appendChild(t);
      row.appendChild(cell);
    }
    table.appendChild(row);
  }
  content.appendChild(table);

  // Responsive sticky notes
  const notesTitle = await makeText("Responsive Constraints", { size: 18, style: "Bold" });
  content.appendChild(notesTitle);
  const notes = stack("Responsive Notes", "HORIZONTAL", 16, 0);
  notes.layoutWrap = "WRAP";
  notes.counterAxisSpacing = 16;
  fixWidth(notes, widths.reduce((a, b) => a + b, 0));
  for (const n of spec.notes) {
    const sticky = stack(`Note → ${n.target}`, "VERTICAL", 6, 14);
    sticky.fills = [solid(hex("#FEF3C7"))];
    sticky.cornerRadius = 8;
    fixWidth(sticky, 270);
    sticky.appendChild(await makeText(`→ ${n.target}`, { size: 12, style: "Bold", color: hex("#92400E"), width: 242 }));
    sticky.appendChild(await makeText(n.text, { size: 12, color: hex("#451A03"), width: 242 }));
    notes.appendChild(sticky);
  }
  content.appendChild(notes);

  // Code snippet card
  const card = stack("Code Snippet", "VERTICAL", 12, 24);
  card.fills = [solid(hex("#0F172A"))];
  card.cornerRadius = 12;
  card.appendChild(await makeText(spec.code.language.toUpperCase(), { size: 11, style: "Bold", color: hex("#94A3B8") }));
  card.appendChild(await makeText(spec.code.text, { size: 12, color: hex("#E2E8F0"), family: MONO }));
  content.appendChild(card);

  // Sections live on the page, so position from absolute coordinates.
  const section = figma.createSection();
  section.name = spec.title;
  pageOf(node).appendChild(section);
  section.appendChild(content);
  content.x = 48;
  content.y = 48;
  section.resizeWithoutConstraints(content.width + 96, content.height + 96);
  const box = node.absoluteBoundingBox ?? { x: node.x, y: node.y, width: node.width, height: node.height };
  section.x = box.x;
  section.y = box.y + box.height + 160;
  return section;
}

export function pageOf(node: BaseNode): PageNode {
  let n: BaseNode | null = node;
  while (n && n.type !== "PAGE") n = n.parent;
  return (n as PageNode | null) ?? figma.currentPage;
}
