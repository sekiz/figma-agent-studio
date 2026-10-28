import type { NodeSnapshot } from "@figma-studio/shared-types";

const NAV_NAME = /\b(nav|navbar|navigation|header|top ?bar|app ?bar|menu ?bar|masthead)\b/i;
const SIDEBAR_NAME = /\b(sidebar|side ?nav|side ?bar|drawer|rail)\b/i;
const GRID_NAME = /\b(grid|cards|gallery|products|features|tiles|collection)\b/i;
const BUTTON_NAME = /\b(button|btn|cta)\b/i;
const CONTAINER_TYPES = new Set(["FRAME", "INSTANCE", "COMPONENT", "GROUP"]);

export function isContainer(n: NodeSnapshot): boolean {
  return CONTAINER_TYPES.has(n.type);
}

export function isAutoLayout(n: NodeSnapshot): boolean {
  return n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL";
}

function visibleChildren(n: NodeSnapshot): NodeSnapshot[] {
  return (n.children ?? []).filter((c) => c.visible && c.layoutPositioning !== "ABSOLUTE");
}

function nameOf(n: NodeSnapshot): string {
  return `${n.name} ${n.component?.mainComponentName ?? ""} ${n.component?.componentSetName ?? ""}`;
}

/** Top navigation: a nav-named, (nearly) full-width container in the top 20% of the root. */
export function findTopNav(root: NodeSnapshot): number | null {
  const children = root.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (!c.visible || !isContainer(c)) continue;
    if (!NAV_NAME.test(nameOf(c)) || SIDEBAR_NAME.test(c.name)) continue;
    const nearTop = c.y <= root.height * 0.2;
    const wide = c.width >= root.width * 0.6;
    if (nearTop && wide) return i;
  }
  return null;
}

/** Desktop sidebar: a sidebar-named direct child of a HORIZONTAL root. */
export function findSidebar(root: NodeSnapshot): number | null {
  if (root.layoutMode !== "HORIZONTAL") return null;
  const children = root.children ?? [];
  const i = children.findIndex((c) => c.visible && isContainer(c) && SIDEBAR_NAME.test(c.name));
  return i >= 0 ? i : null;
}

/**
 * A grid is a horizontal (or wrapping) Auto-Layout container with at least two similar
 * container children — or one that is explicitly named like a grid.
 */
export function isGrid(n: NodeSnapshot): boolean {
  if (!(n.layoutMode === "HORIZONTAL" || n.layoutMode === "GRID")) return false;
  const kids = visibleChildren(n).filter(isContainer);
  if (kids.length < 2) return false;
  if (GRID_NAME.test(n.name) || n.layoutWrap === "WRAP" || n.layoutMode === "GRID") return true;
  if (kids.length < 3) return false;
  const widths = kids.map((k) => k.width).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)]!;
  return kids.every((k) => Math.abs(k.width - median) <= median * 0.2) && kids.length === visibleChildren(n).length;
}

export function isButton(n: NodeSnapshot): boolean {
  return isContainer(n) && BUTTON_NAME.test(nameOf(n));
}

export function hasDropShadow(n: NodeSnapshot): boolean {
  return (n.effects ?? []).some((e) => e.visible && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"));
}

/** Total width the children of a horizontal container ask for. */
export function requiredRowWidth(n: NodeSnapshot): number {
  const kids = visibleChildren(n);
  const gaps = Math.max(0, kids.length - 1) * (n.itemSpacing ?? 0);
  return kids.reduce((sum, k) => sum + k.width, 0) + gaps + (n.paddingLeft ?? 0) + (n.paddingRight ?? 0);
}
