import {
  PLUGIN_DATA_SURFACE,
  SURFACE_LABELS,
  noComponentResolver,
  type ComponentCandidate,
  type ComponentResolver,
  type ComponentRole,
  type MutationPlan,
  type NodeSnapshot,
  type Path,
  type PlanOp,
  type PlanOpOf,
  type Surface,
} from "@figma-studio/shared-types";
import { mapFontSize, mapSpacing, platformSpec, type ChromeSlot, type PlatformSpec, type SurfaceOverrides } from "./platforms.js";
import { findSidebar, findTopNav, hasDropShadow, isAutoLayout, isButton, isContainer, isGrid, requiredRowWidth } from "./roles.js";

export interface TransposeOptions {
  surface: Surface;
  resolver?: ComponentResolver;
  /** When true (default) a missing required component becomes a fuchsia flag + placeholder + decision. */
  enforceDesignSystem?: boolean;
  placeBesideSource?: boolean;
  /** Column index next to the source when several surfaces are generated at once. */
  slot?: number;
  overrides?: SurfaceOverrides;
  /** Optional tokens the engine can bind (e.g. M3 tonal surfaces replacing drop shadows). */
  tokens?: { surfaceContainerVariableId?: string };
}

export interface MissingComponent {
  requirementId: string;
  role: ComponentRole;
  surface: Surface;
  label: string;
  /** Tag of the placeholder node in the applied plan (resolve via ApplyPlanResult.tags). */
  placeholderTag: string;
  flagTag: string;
  width?: number;
  height: number;
  candidates: ComponentCandidate[];
}

export interface TransposeResult {
  surface: Surface;
  spec: PlatformSpec;
  plan: MutationPlan;
  missing: MissingComponent[];
  usedComponents: Array<{ role: ComponentRole; name: string }>;
  warnings: string[];
}

type LayoutPatch = Omit<PlanOpOf<"setLayout">, "op" | "path">;

class PlanBuilder {
  readonly ops: PlanOp[] = [];
  readonly warnings: string[] = [];
  readonly missing: MissingComponent[] = [];
  readonly used: Array<{ role: ComponentRole; name: string }> = [];
  focusPlaced = false;
  shadowsRemoved = 0;

  constructor(
    readonly spec: PlatformSpec,
    readonly resolver: ComponentResolver,
    readonly enforce: boolean,
    readonly tokens: TransposeOptions["tokens"],
  ) {}

  push(op: PlanOp): void {
    this.ops.push(op);
  }

  layout(path: Path, patch: LayoutPatch): void {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as LayoutPatch;
    if (Object.keys(clean).length > 0) this.ops.push({ op: "setLayout", path, ...clean });
  }

  /**
   * Places a platform chrome component. Resolution order: exact DS match → (optional slot) spacer →
   * (enforce) placeholder + flag + decision → (no enforce) closest candidate → skip with warning.
   * Returns false when nothing was placed and the caller should keep the source node.
   */
  chrome(
    slot: ChromeSlot,
    at: { parentPath: Path; index: number } | { replacePath: Path },
    size: { width?: number; fillHeight?: boolean; spacerHeight?: number } = {},
  ): boolean {
    const surface = this.spec.surface;
    const res = this.resolver({ role: slot.role, surface });
    const fillWidth = size.width === undefined;
    const name = `${slot.label}`;

    const placeInstance = (c: ComponentCandidate) => {
      this.used.push({ role: slot.role, name: c.name });
      if ("replacePath" in at) {
        this.push({ op: "replaceWithInstance", path: at.replacePath, component: c.target, name, fillWidth });
      } else {
        this.push({
          op: "insertInstance",
          parentPath: at.parentPath,
          index: at.index,
          component: c.target,
          name,
          fillWidth,
          width: size.width,
          fillHeight: size.fillHeight ?? false,
        });
      }
    };

    if (res.match) {
      placeInstance(res.match);
      return true;
    }
    if (slot.optional) {
      if ("parentPath" in at) {
        const h = size.spacerHeight ?? slot.height;
        if (h > 0) {
          this.push({ op: "insertSpacer", parentPath: at.parentPath, index: at.index, name: `Safe Area / ${slot.label} (${h}${this.spec.unit})`, height: h });
        }
      }
      return true;
    }
    if (!this.enforce) {
      const closest = res.candidates[0];
      if (closest) {
        this.warnings.push(`No exact "${slot.label}" component for ${this.spec.label}; used closest variant "${closest.name}".`);
        placeInstance(closest);
        return true;
      }
      this.warnings.push(`No "${slot.label}" component for ${this.spec.label}; kept the source layer.`);
      return false;
    }

    const requirementId = `${surface}:${slot.role}`;
    const placeholderTag = `placeholder:${requirementId}`;
    const flagTag = `flag:${requirementId}`;
    const label = `${slot.label} — missing in Design System`;
    const placeholderName = `[DS-AUDIT] ${slot.label}`;
    if ("replacePath" in at) {
      this.push({ op: "replaceWithPlaceholder", path: at.replacePath, name: placeholderName, label, tag: placeholderTag });
    } else {
      this.push({
        op: "insertPlaceholder",
        parentPath: at.parentPath,
        index: at.index,
        name: placeholderName,
        label,
        height: slot.height,
        width: size.width,
        fillHeight: size.fillHeight ?? false,
        tag: placeholderTag,
      });
    }
    this.push({
      op: "flag",
      path: [],
      title: "⚠️ DS AUDIT: Missing Component",
      message: `${slot.label} for ${this.spec.label}. Choose: A) synthesize a master component from tokens, B) adapt the closest variant, C) keep a wireframe placeholder.`,
      tag: flagTag,
    });
    this.missing.push({
      requirementId,
      role: slot.role,
      surface,
      label: slot.label,
      placeholderTag,
      flagTag,
      width: size.width,
      height: slot.height,
      candidates: res.candidates.slice(0, 5),
    });
    return true;
  }
}

/**
 * Computes a mutation plan that turns a clone of `source` into a platform-accurate screen.
 * Pure: no Figma API, no I/O. The plan is applied by the plugin on a fresh duplicate.
 */
export function planTranspose(source: NodeSnapshot, options: TransposeOptions): TransposeResult {
  const spec = platformSpec(options.surface, options.overrides);
  const b = new PlanBuilder(spec, options.resolver ?? noComponentResolver, options.enforceDesignSystem ?? true, options.tokens);
  const root: Path = [];

  b.push({ op: "setPluginData", path: root, key: PLUGIN_DATA_SURFACE, value: spec.surface });

  if (!isAutoLayout(source)) {
    b.warnings.push(
      `"${source.name}" is not an Auto-Layout frame, so only the viewport and typography were adapted. ` +
        `Apply Auto-Layout to the source (Shift+A) for full reflow, navigation swaps and grid wrapping.`,
    );
    b.push({ op: "resize", path: root, width: spec.width, height: spec.height });
    adaptTypographyOnly(source, root, b);
    return finish(source, options, b);
  }

  const navIndex = findTopNav(source);
  const sidebarIndex = findSidebar(source);
  const hadNavigation = navIndex !== null || sidebarIndex !== null;

  if (spec.surface === "smart_tv_10ft") {
    planTv(source, b, navIndex, sidebarIndex);
  } else {
    planWrapped(source, b, navIndex, sidebarIndex, hadNavigation);
  }

  if (b.shadowsRemoved > 0) {
    b.warnings.push(
      `Replaced ${b.shadowsRemoved} drop shadow(s) with M3 tonal elevation` +
        (options.tokens?.surfaceContainerVariableId ? " bound to the surface-container token." : "; bind a surface-container color token to finish."),
    );
  }
  return finish(source, options, b);
}

function finish(source: NodeSnapshot, options: TransposeOptions, b: PlanBuilder): TransposeResult {
  const plan: MutationPlan = {
    root: {
      mode: "clone",
      sourceId: source.id,
      name: `${source.name} — ${SURFACE_LABELS[options.surface]}`,
      placeBesideSource: options.placeBesideSource ?? true,
      slot: options.slot ?? 0,
    },
    ops: b.ops,
    label: `Transpose to ${b.spec.label}`,
  };
  return { surface: options.surface, spec: b.spec, plan, missing: b.missing, usedComponents: b.used, warnings: b.warnings };
}

/** Phones and tablets: content moves into a padded "Content" column, platform chrome goes full-bleed around it. */
function planWrapped(source: NodeSnapshot, b: PlanBuilder, navIndex: number | null, sidebarIndex: number | null, hadNavigation: boolean): void {
  const spec = b.spec;
  const tablet = spec.surface === "tablet";
  const useSidebar = tablet && hadNavigation && spec.sidebar !== null;
  const contentWidth = spec.width - 2 * spec.marginX - (useSidebar ? spec.sidebar!.width : 0);

  // 1. Adapt every content child first (paths refer to the untouched source tree).
  const children = source.children ?? [];
  children.forEach((child, i) => {
    if (i === navIndex || i === sidebarIndex || !child.visible) return;
    adaptNode(child, [i], contentWidth, true, b);
  });

  // 2. Navigation: decide whether the desktop navigation can be replaced before removing it.
  const topSlot = tablet ? null : spec.topNav;
  let keepNav = false;
  if (navIndex !== null && topSlot) {
    const res = b.resolver({ role: topSlot.role, surface: spec.surface });
    keepNav = !res.match && !b.enforce && res.candidates.length === 0;
  }
  if (sidebarIndex !== null) b.push({ op: "remove", path: [sidebarIndex] });
  if (navIndex !== null && !keepNav) b.push({ op: "remove", path: [navIndex] });
  if (navIndex !== null && keepNav) adaptNode(children[navIndex]!, [navIndex], contentWidth, true, b);
  if (sidebarIndex !== null && !tablet) {
    b.warnings.push(`Desktop sidebar "${children[sidebarIndex]!.name}" was removed; its destinations belong in the ${spec.bottomNav?.label ?? "navigation"}.`);
  }

  // 3. Wrap the remaining content into a padded column.
  const safeTop = tablet ? spec.safeArea.top : 0;
  const safeBottom = tablet ? spec.safeArea.bottom : 0;
  b.push({
    op: "wrapChildren",
    path: [],
    name: "Content",
    layoutMode: "VERTICAL",
    itemSpacing: mapSpacing(source.itemSpacing ?? 0, spec),
    padding: {
      top: safeTop + mapSpacing(source.paddingTop ?? 0, spec),
      bottom: safeBottom + mapSpacing(source.paddingBottom ?? 0, spec),
      left: spec.marginX,
      right: spec.marginX,
    },
    tag: "content",
  });

  // 4. Root becomes the device viewport.
  b.push({ op: "resize", path: [], width: spec.width, height: spec.height });
  b.layout([], {
    layoutMode: useSidebar ? "HORIZONTAL" : "VERTICAL",
    layoutWrap: "NO_WRAP",
    itemSpacing: 0,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    primaryAxisSizingMode: useSidebar ? "FIXED" : "AUTO",
    counterAxisSizingMode: useSidebar ? "AUTO" : "FIXED",
    primaryAxisAlignItems: "MIN",
    counterAxisAlignItems: "MIN",
    clipsContent: true,
  });
  b.push({ op: "setMinSize", path: [], minHeight: spec.height });

  // 5. Platform chrome around the content column.
  if (tablet) {
    // Tablet safe areas live in the Content padding so the sidebar can run full height.
    if (useSidebar) b.chrome(spec.sidebar!, { parentPath: [], index: 0 }, { width: spec.sidebar!.width, fillHeight: true });
    return;
  }
  if (spec.statusBar) b.chrome(spec.statusBar, { parentPath: [], index: 0 }, { spacerHeight: spec.safeArea.top });
  else if (spec.safeArea.top > 0) {
    b.push({ op: "insertSpacer", parentPath: [], index: 0, name: `Safe Area / ${spec.safeArea.topLabel} (${spec.safeArea.top}${spec.unit})`, height: spec.safeArea.top });
  }
  if (navIndex !== null && topSlot && !keepNav) b.chrome(topSlot, { parentPath: [], index: 1 });
  if (hadNavigation && spec.bottomNav) b.chrome(spec.bottomNav, { parentPath: [], index: -1 });
  if (spec.homeIndicator) b.chrome(spec.homeIndicator, { parentPath: [], index: -1 }, { spacerHeight: spec.safeArea.bottom });
  else if (spec.safeArea.bottom > 0) {
    b.push({ op: "insertSpacer", parentPath: [], index: -1, name: `Safe Area / ${spec.safeArea.bottomLabel} (${spec.safeArea.bottom}${spec.unit})`, height: spec.safeArea.bottom });
  }
}

/** Smart TV: the whole screen sits inside the overscan-safe margin; navigation becomes a D-pad tab bar. */
function planTv(source: NodeSnapshot, b: PlanBuilder, navIndex: number | null, sidebarIndex: number | null): void {
  const spec = b.spec;
  const row = source.layoutMode === "HORIZONTAL";
  const contentWidth = spec.width - 2 * spec.marginX;
  (source.children ?? []).forEach((child, i) => {
    if (i === navIndex || !child.visible) return;
    if (i === sidebarIndex) return;
    adaptNode(child, [i], row ? null : contentWidth, true, b);
  });

  b.push({ op: "resize", path: [], width: spec.width, height: spec.height });
  b.layout([], {
    itemSpacing: mapSpacing(source.itemSpacing ?? 0, spec),
    padding: { top: spec.marginY, right: spec.marginX, bottom: spec.marginY, left: spec.marginX },
    primaryAxisSizingMode: row ? "FIXED" : "AUTO",
    clipsContent: true,
  });
  b.push({ op: "setMinSize", path: [], minHeight: spec.height });

  if (navIndex !== null && spec.topNav) {
    const placed = b.chrome(spec.topNav, { replacePath: [navIndex] });
    if (!placed) adaptNode((source.children ?? [])[navIndex]!, [navIndex], contentWidth, true, b);
  }
  if (sidebarIndex !== null) {
    b.chrome({ role: "sidebar", height: spec.height - 2 * spec.marginY, label: "Left Rail Navigation (120px)", optional: false }, { replacePath: [sidebarIndex] });
  }
  if (!b.focusPlaced) {
    b.warnings.push("No focusable card or button found; add a Focused variant so D-pad focus is visible.");
  } else {
    b.warnings.push("D-pad focus ring shown on the first focusable element; make sure the DS card/button has a Focused variant.");
  }
}

/**
 * Adapts one node to the available width (null = unknown, e.g. inside a horizontal row).
 * Emits ops for the node and recurses into its children.
 */
function adaptNode(n: NodeSnapshot, path: Path, avail: number | null, parentAutoLayout: boolean, b: PlanBuilder): void {
  const spec = b.spec;
  if (!n.visible || n.layoutPositioning === "ABSOLUTE") return;

  if (n.type === "TEXT") {
    adaptText(n, path, b);
    if (avail !== null && n.width > avail) fitWidth(n, path, avail, parentAutoLayout, b);
    return;
  }

  if (!isContainer(n) || n.type === "INSTANCE") {
    // Leaves and component instances keep their internals; only their footprint adapts.
    if (n.type === "INSTANCE") adaptInstance(n, path, b);
    if (avail !== null && n.width > avail) fitWidth(n, path, avail, parentAutoLayout, b);
    return;
  }

  if (spec.elevation === "tonal" && hasDropShadow(n)) {
    b.push({ op: "removeShadows", path });
    if (b.tokens?.surfaceContainerVariableId) b.push({ op: "bindVariable", path, field: "fills", variableId: b.tokens.surfaceContainerVariableId });
    b.shadowsRemoved++;
  }
  if (isButton(n)) adaptButton(n, path, b);

  const autoLayout = isAutoLayout(n) || n.layoutMode === "GRID";
  const fills = avail !== null && n.width > avail;
  const ownWidth = avail === null ? n.width : Math.min(n.width, avail);
  const padX = (side: number | undefined, field: string) => (n.boundVariables?.[field] ? side ?? 0 : mapSpacing(side ?? 0, spec));
  const innerWidth = ownWidth - padX(n.paddingLeft, "paddingLeft") - padX(n.paddingRight, "paddingRight");

  if (!autoLayout) {
    if (fills) fitWidth(n, path, avail!, parentAutoLayout, b);
    (n.children ?? []).forEach((c, i) => adaptTypographyOnly(c, [...path, i], b));
    return;
  }

  const spacingPatch = spacingFor(n, spec);

  if (isGrid(n)) {
    adaptGrid(n, path, avail, innerWidth, parentAutoLayout, spacingPatch, b);
    return;
  }

  let layoutMode = n.layoutMode;
  if (n.layoutMode === "HORIZONTAL" && avail !== null && spec.grid === "stack" && requiredRowWidth(n) > avail) {
    layoutMode = "VERTICAL";
  }
  const stacked = layoutMode !== n.layoutMode;
  b.layout(path, { ...spacingPatch, layoutMode: stacked ? layoutMode : undefined, layoutWrap: stacked ? "NO_WRAP" : undefined });
  if (fills || stacked) fitWidth(n, path, avail ?? n.width, parentAutoLayout, b);

  const children = n.children ?? [];
  const shrinkRow = layoutMode === "HORIZONTAL" && avail !== null && requiredRowWidth(n) > avail;
  children.forEach((c, i) => {
    const childPath = [...path, i];
    if (stacked && c.visible && c.layoutPositioning !== "ABSOLUTE") {
      b.push({ op: "setSizing", path: childPath, horizontal: "FILL" });
      adaptNode(c, childPath, innerWidth, true, b);
    } else if (shrinkRow && c.visible && c.layoutPositioning !== "ABSOLUTE") {
      // Tablet / TV rows that overflow: let siblings share the row instead of overflowing it.
      b.push({ op: "setSizing", path: childPath, horizontal: "FILL" });
      adaptNode(c, childPath, null, true, b);
    } else {
      adaptNode(c, childPath, layoutMode === "HORIZONTAL" ? null : innerWidth, true, b);
    }
  });
}

function adaptGrid(
  n: NodeSnapshot,
  path: Path,
  avail: number | null,
  innerWidth: number,
  parentAutoLayout: boolean,
  spacingPatch: LayoutPatch,
  b: PlanBuilder,
): void {
  const spec = b.spec;
  const gap = spacingPatch.itemSpacing ?? n.itemSpacing ?? 0;
  const kids = n.children ?? [];
  const flow = (c: NodeSnapshot) => c.visible && c.layoutPositioning !== "ABSOLUTE";

  const twoColumnWidth = Math.floor((innerWidth - gap) / 2);
  // Two columns narrower than a small card read worse than one; fall back to a stack.
  const mode = spec.grid === "two_column" && twoColumnWidth < 120 ? "stack" : spec.grid;

  switch (mode) {
    case "stack": {
      b.layout(path, { ...spacingPatch, layoutMode: "VERTICAL", layoutWrap: "NO_WRAP" });
      fitWidth(n, path, avail ?? n.width, parentAutoLayout, b);
      kids.forEach((c, i) => {
        if (!flow(c)) return;
        b.push({ op: "setSizing", path: [...path, i], horizontal: "FILL" });
        adaptNode(c, [...path, i], innerWidth, true, b);
      });
      return;
    }
    case "two_column": {
      b.layout(path, { ...spacingPatch, layoutMode: "HORIZONTAL", layoutWrap: "WRAP", counterAxisSpacing: gap });
      fitWidth(n, path, avail ?? n.width, parentAutoLayout, b);
      const col = twoColumnWidth;
      kids.forEach((c, i) => {
        if (!flow(c)) return;
        b.push({ op: "setSizing", path: [...path, i], horizontal: "FIXED" });
        b.push({ op: "resize", path: [...path, i], width: col });
        adaptNode({ ...c, width: col }, [...path, i], col, true, b);
      });
      return;
    }
    case "dpad_row": {
      b.layout(path, { ...spacingPatch, layoutMode: "HORIZONTAL", layoutWrap: "NO_WRAP", clipsContent: true });
      if (parentAutoLayout) b.push({ op: "setSizing", path, horizontal: "FILL" });
      kids.forEach((c, i) => {
        if (!flow(c)) return;
        if (!b.focusPlaced && spec.focusRing) {
          b.push({ op: "focusRing", path: [...path, i], ...spec.focusRing });
          b.push({ op: "rename", path: [...path, i], name: `${c.name} (Focused)` });
          b.focusPlaced = true;
        }
        adaptNode(c, [...path, i], null, true, b);
      });
      return;
    }
  }
}

function spacingFor(n: NodeSnapshot, spec: PlatformSpec): LayoutPatch {
  const bound = n.boundVariables ?? {};
  const map = (field: string, v: number | undefined) => (v === undefined || bound[field] ? undefined : mapSpacing(v, spec));
  const changed = (field: string, v: number | undefined) => {
    const m = map(field, v);
    return m === undefined || m === v ? undefined : m;
  };
  const padding = {
    top: changed("paddingTop", n.paddingTop),
    right: changed("paddingRight", n.paddingRight),
    bottom: changed("paddingBottom", n.paddingBottom),
    left: changed("paddingLeft", n.paddingLeft),
  };
  const hasPadding = Object.values(padding).some((v) => v !== undefined);
  return {
    itemSpacing: changed("itemSpacing", n.itemSpacing),
    padding: hasPadding ? padding : undefined,
  };
}

function fitWidth(n: NodeSnapshot, path: Path, avail: number, parentAutoLayout: boolean, b: PlanBuilder): void {
  if (parentAutoLayout) {
    b.push({ op: "setSizing", path, horizontal: "FILL" });
  } else if (n.width > avail) {
    const ratio = avail / n.width;
    b.push({ op: "resize", path, width: avail, height: n.type === "TEXT" ? undefined : Math.max(1, Math.round(n.height * ratio)) });
  }
}

function adaptText(n: NodeSnapshot, path: Path, b: PlanBuilder): void {
  const t = b.spec.typography;
  if (typeof n.fontSize !== "number") {
    b.warnings.push(`Text "${n.name}" has mixed font sizes; typography left unchanged.`);
    return;
  }
  const size = mapFontSize(n.fontSize, b.spec);
  const family = n.fontSize >= t.displayThreshold ? t.displayFamily : t.textFamily;
  if (size === n.fontSize && !family) return;
  b.push({
    op: "setText",
    path,
    fontSize: size !== n.fontSize ? size : undefined,
    fontFamily: family || undefined,
    fontFamilyFallbacks: family ? t.familyFallbacks : undefined,
  });
}

function adaptTypographyOnly(n: NodeSnapshot, path: Path, b: PlanBuilder): void {
  if (n.type === "TEXT") return adaptText(n, path, b);
  if (n.type === "INSTANCE") return;
  (n.children ?? []).forEach((c, i) => adaptTypographyOnly(c, [...path, i], b));
}

function adaptInstance(n: NodeSnapshot, path: Path, b: PlanBuilder): void {
  if (isButton(n)) adaptButton(n, path, b);
}

function adaptButton(n: NodeSnapshot, path: Path, b: PlanBuilder): void {
  const spec = b.spec;
  if (spec.minTouchTarget !== null && (n.height < spec.minTouchTarget || n.width < spec.minTouchTarget)) {
    b.push({
      op: "setMinSize",
      path,
      minHeight: n.height < spec.minTouchTarget ? spec.minTouchTarget : undefined,
      minWidth: n.width < spec.minTouchTarget ? spec.minTouchTarget : undefined,
    });
  }
  if (spec.focusRing && !b.focusPlaced) {
    b.push({ op: "focusRing", path, ...spec.focusRing });
    b.focusPlaced = true;
  }
}
