import type { AxisAlign, ComponentRef, MutationPlan, NodeSnapshot, Path, PlanOp, TextAlign } from "@figma-studio/shared-types";
import { isDirectionalIcon, shieldContainer, shieldText, type ShieldReason } from "./shield.js";

export type RtlLanguage = "ar" | "he" | "none";

export interface RtlOptions {
  targetLanguage?: RtlLanguage;
  swapDirectionalIcons?: boolean;
  /** Keep the LTR original and mirror a duplicate (default true). */
  createDuplicate?: boolean;
  slot?: number;
  /**
   * Looks up the mirrored counterpart of a component: `"flipped_icon"` maps "Icon/Chevron/Left" →
   * "Icon/Chevron/Right"; `"rtl_variant"` maps "Direction=LTR" → "Direction=RTL". Provided by ds-sentinel.
   */
  findMirrorComponent?: (ref: ComponentRef, kind: "flipped_icon" | "rtl_variant") => { id?: string; key?: string; name: string } | null;
}

export interface RtlStats {
  reversedContainers: number;
  paddingSwaps: number;
  alignmentFlips: number;
  textAlignmentFlips: number;
  mirroredPositions: number;
  iconsFlipped: number;
  iconsSwapped: number;
  shieldedTexts: number;
  shieldedContainers: number;
}

export interface RtlResult {
  plan: MutationPlan;
  stats: RtlStats;
  warnings: string[];
  shielded: Array<{ path: Path; name: string; reason: ShieldReason }>;
}

const flipAlign = (a: AxisAlign | undefined): AxisAlign | undefined => (a === "MIN" ? "MAX" : a === "MAX" ? "MIN" : undefined);
const flipText = (a: TextAlign | undefined): TextAlign | undefined => (a === "LEFT" ? "RIGHT" : a === "RIGHT" ? "LEFT" : undefined);
const flipConstraint = (c: string | undefined) => (c === "MIN" ? "MAX" : c === "MAX" ? "MIN" : undefined);

/**
 * Plans a zero-loss RTL mirror. Pure; works on child-index paths so it applies to a duplicate.
 *
 * Horizontal Auto-Layout: child order is reversed AND primary alignment MIN↔MAX is flipped — both are
 * required, otherwise a left-packed row stays left-packed. Vertical Auto-Layout: counter-axis alignment
 * flips. Absolute layouts mirror x around the parent's width. Instances can't reorder their sublayers,
 * so they are swapped to an RTL variant when the design system has one.
 */
export function planRtl(root: NodeSnapshot, options: RtlOptions = {}): RtlResult {
  const ops: PlanOp[] = [];
  const warnings: string[] = [];
  const shielded: RtlResult["shielded"] = [];
  const stats: RtlStats = {
    reversedContainers: 0,
    paddingSwaps: 0,
    alignmentFlips: 0,
    textAlignmentFlips: 0,
    mirroredPositions: 0,
    iconsFlipped: 0,
    iconsSwapped: 0,
    shieldedTexts: 0,
    shieldedContainers: 0,
  };
  const swapIcons = options.swapDirectionalIcons ?? true;
  const instancesWithoutRtl = new Set<string>();

  const visit = (n: NodeSnapshot, path: Path, parent: NodeSnapshot | null, insideInstance: boolean): void => {
    if (!n.visible) return;

    // Absolute children (in NONE frames, or ABSOLUTE inside Auto-Layout) mirror around the parent.
    const parentIsAbsolute = parent !== null && parent.type !== "GROUP" && (!parent.layoutMode || parent.layoutMode === "NONE");
    if (parent && !insideInstance && (parentIsAbsolute || n.layoutPositioning === "ABSOLUTE")) {
      const x = Math.round((parent.width - n.x - n.width) * 100) / 100;
      if (Math.abs(x - n.x) > 0.01) {
        ops.push({ op: "setPosition", path, x });
        stats.mirroredPositions++;
      }
      const h = flipConstraint(n.constraints?.horizontal);
      if (h) ops.push({ op: "setConstraints", path, horizontal: h as "MIN" | "MAX" });
    }

    if (swapIcons && path.length > 0 && isDirectionalIcon(n.name) && n.type !== "TEXT") {
      const mirror = n.type === "INSTANCE" && n.component && options.findMirrorComponent?.(n.component, "flipped_icon");
      if (mirror) {
        ops.push({ op: "swapComponent", path, component: { id: mirror.id, key: mirror.key } });
        stats.iconsSwapped++;
      } else {
        ops.push({ op: "flipHorizontal", path });
        stats.iconsFlipped++;
      }
      return;
    }

    if (n.type === "TEXT") {
      const reason = shieldText(n.characters ?? "", n.name);
      if (reason) {
        shielded.push({ path, name: n.name, reason });
        stats.shieldedTexts++;
        return;
      }
      const align = flipText(n.textAlignHorizontal);
      if (align) {
        ops.push({ op: "setText", path, textAlignHorizontal: align });
        stats.textAlignmentFlips++;
      }
      return;
    }

    if (path.length > 0 && shieldContainer(n.name)) {
      shielded.push({ path, name: n.name, reason: "name" });
      stats.shieldedContainers++;
      return;
    }

    let childrenInsideInstance = insideInstance;
    if (n.type === "INSTANCE" && !insideInstance) {
      const rtl = n.component && options.findMirrorComponent?.(n.component, "rtl_variant");
      if (rtl) {
        ops.push({ op: "swapComponent", path, component: { id: rtl.id, key: rtl.key } });
        stats.iconsSwapped++;
        return;
      }
      childrenInsideInstance = true;
      if (n.layoutMode === "HORIZONTAL" && (n.children ?? []).filter((c) => c.visible).length > 1) {
        instancesWithoutRtl.add(n.component?.componentSetName ?? n.component?.mainComponentName ?? n.name);
      }
    }

    if (n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL") {
      const horizontal = n.layoutMode === "HORIZONTAL";
      const canReorder = horizontal && n.type !== "INSTANCE" && !insideInstance && (n.children ?? []).length > 1;
      if (canReorder) {
        ops.push({ op: "reverseChildren", path });
        stats.reversedContainers++;
      }
      const primary = horizontal ? flipAlign(n.primaryAxisAlignItems) : undefined;
      const counter = horizontal ? undefined : flipAlign(n.counterAxisAlignItems);
      const pl = n.paddingLeft ?? 0;
      const pr = n.paddingRight ?? 0;
      const swapPadding = pl !== pr && !n.boundVariables?.paddingLeft && !n.boundVariables?.paddingRight;
      if (primary || counter || swapPadding) {
        ops.push({
          op: "setLayout",
          path,
          ...(primary ? { primaryAxisAlignItems: primary } : {}),
          ...(counter ? { counterAxisAlignItems: counter } : {}),
          ...(swapPadding ? { padding: { left: pr, right: pl } } : {}),
        });
        if (primary || counter) stats.alignmentFlips++;
        if (swapPadding) stats.paddingSwaps++;
      } else if (pl !== pr) {
        warnings.push(`"${n.name}" has asymmetric padding bound to variables; swap the bindings manually.`);
      }
    }

    if (n.type === "GROUP" && (n.children ?? []).length > 1) {
      warnings.push(`Group "${n.name}" was mirrored as a unit; convert it to a frame to mirror its contents.`);
      return;
    }

    (n.children ?? []).forEach((c, i) => visit(c, [...path, i], n, childrenInsideInstance));
  };

  visit(root, [], null, false);

  for (const name of instancesWithoutRtl) {
    warnings.push(`Instances of "${name}" can't reorder their layers; add a Direction=RTL variant to the design system.`);
  }

  const lang = options.targetLanguage ?? "none";
  const createDuplicate = options.createDuplicate ?? true;
  ops.push({ op: "setPluginData", path: [], key: "fas.direction", value: "rtl" });
  const plan: MutationPlan = {
    root: createDuplicate
      ? { mode: "clone", sourceId: root.id, name: `${root.name} — RTL${lang !== "none" ? ` (${lang})` : ""}`, placeBesideSource: true, slot: options.slot ?? 0 }
      : { mode: "existing", nodeId: root.id },
    ops,
    label: "Mirror to RTL",
  };
  return { plan, stats, warnings, shielded };
}

/** Text layers a translator should receive (shielded data excluded). */
export function translatableTexts(root: NodeSnapshot): Array<{ nodeId: string; name: string; characters: string }> {
  const out: Array<{ nodeId: string; name: string; characters: string }> = [];
  const visit = (n: NodeSnapshot, shieldedAncestor: boolean) => {
    if (!n.visible) return;
    const shielded = shieldedAncestor || (n.id !== root.id && shieldContainer(n.name));
    if (n.type === "TEXT") {
      const chars = n.characters ?? "";
      if (!shielded && chars.trim() && !shieldText(chars, n.name)) out.push({ nodeId: n.id, name: n.name, characters: chars });
      return;
    }
    (n.children ?? []).forEach((c) => visit(c, shielded));
  };
  visit(root, false);
  return out;
}
