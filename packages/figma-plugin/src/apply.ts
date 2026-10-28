import type { ApplyPlanResult, ComponentTarget, MutationPlan, Path, PlanOp } from "@figma-studio/shared-types";
import { ensureTextFonts, switchFamily } from "./fonts.js";
import { createFlag, createPlaceholder } from "./render.js";
import { getSceneNode } from "./snapshot.js";

/** DoD: mutations are chunked so the canvas keeps rendering. */
const CHUNK = 50;
const SLOT_GAP = 200;

export type ProgressFn = (done: number, total: number, message?: string) => void;

const yieldToCanvas = () => new Promise<void>((r) => setTimeout(r, 0));
const pathKey = (p: Path) => p.join("/");

function child(node: BaseNode, index: number): SceneNode {
  if (!("children" in node)) throw new Error(`"${node.name}" has no children`);
  const kids = (node as ChildrenMixin).children;
  const c = kids[index];
  if (!c) throw new Error(`"${node.name}" has no child #${index}`);
  return c;
}

function resolvePath(root: SceneNode, path: Path): SceneNode {
  let n: SceneNode = root;
  for (const i of path) n = child(n, i);
  return n;
}

const isAutoLayout = (n: BaseNode | null): n is FrameNode =>
  !!n && "layoutMode" in n && ((n as FrameNode).layoutMode === "HORIZONTAL" || (n as FrameNode).layoutMode === "VERTICAL");

const componentCache = new Map<string, ComponentNode>();

async function resolveComponent(target: ComponentTarget): Promise<ComponentNode> {
  const cacheKey = target.id ?? `key:${target.key}`;
  const cached = componentCache.get(cacheKey);
  if (cached && !cached.removed) return cached;
  let comp: ComponentNode | null = null;
  if (target.id) {
    const n = await figma.getNodeByIdAsync(target.id);
    if (n && n.type === "COMPONENT") comp = n;
  }
  if (!comp && target.key) comp = await figma.importComponentByKeyAsync(target.key);
  if (!comp) throw new Error(`Component ${target.id ?? target.key} not found`);
  componentCache.set(cacheKey, comp);
  return comp;
}

function insertAt(parent: BaseNode, index: number, node: SceneNode): void {
  const p = parent as ChildrenMixin & BaseNode;
  if (!("children" in p)) throw new Error(`"${parent.name}" cannot contain layers`);
  const len = p.children.length;
  p.insertChild(index < 0 ? len : Math.min(index, len), node);
}

function size(node: SceneNode, opts: { fillWidth?: boolean; width?: number; fillHeight?: boolean }, fallbackWidth?: number): void {
  const parentAL = isAutoLayout(node.parent);
  if (opts.fillWidth && parentAL) (node as FrameNode).layoutSizingHorizontal = "FILL";
  else if ((opts.width ?? (opts.fillWidth ? fallbackWidth : undefined)) && "resize" in node) {
    (node as FrameNode).resize(opts.width ?? fallbackWidth!, node.height);
  }
  if (opts.fillHeight && parentAL) (node as FrameNode).layoutSizingVertical = "FILL";
}

async function placeClone(source: SceneNode, name: string, besides: boolean): Promise<SceneNode> {
  const clone = source.clone();
  clone.name = name;
  clone.setPluginData("fas.sourceId", source.id);
  if (besides) {
    const parent = source.parent as (ChildrenMixin & BaseNode) | null;
    const siblings = parent ? parent.children.filter((n) => n !== clone && (n === source || n.getPluginData("fas.sourceId") === source.id)) : [source];
    const right = siblings.reduce((x, n) => Math.max(x, n.x + n.width), source.x + source.width);
    clone.x = right + SLOT_GAP;
    clone.y = source.y;
  }
  return clone;
}

export async function applyPlan(plan: MutationPlan, progress: ProgressFn): Promise<ApplyPlanResult> {
  const warnings: string[] = [];
  const tags: Record<string, string> = {};

  let root: SceneNode;
  if (plan.root.mode === "existing") {
    root = await getSceneNode(plan.root.nodeId);
  } else {
    const source = await getSceneNode(plan.root.sourceId);
    root = await placeClone(source, plan.root.name, plan.root.placeBesideSource);
  }

  // Resolve every path BEFORE mutating: later reorders/inserts can't invalidate addresses.
  const nodes = new Map<string, SceneNode>();
  const want = (p: Path | undefined) => {
    if (!p || nodes.has(pathKey(p))) return;
    try {
      nodes.set(pathKey(p), resolvePath(root, p));
    } catch (e) {
      warnings.push(`Path [${p.join(",")}] could not be resolved: ${(e as Error).message}`);
    }
  };
  for (const op of plan.ops) want("path" in op ? op.path : op.parentPath);
  const at = (p: Path) => {
    const n = nodes.get(pathKey(p));
    if (!n || n.removed) throw new Error(`no node at [${p.join(",")}]`);
    return n;
  };

  let applied = 0;
  for (let i = 0; i < plan.ops.length; i++) {
    const op = plan.ops[i]!;
    try {
      const w = await applyOp(op, at, root, tags);
      if (w) warnings.push(w);
      applied++;
    } catch (e) {
      warnings.push(`op #${i} ${op.op}: ${(e as Error).message}`);
    }
    if ((i + 1) % CHUNK === 0) {
      progress(i + 1, plan.ops.length, plan.label);
      await yieldToCanvas();
    }
  }
  progress(plan.ops.length, plan.ops.length, plan.label);
  figma.commitUndo();
  if (plan.root.mode === "clone") figma.viewport.scrollAndZoomIntoView([root]);
  return { rootId: root.id, applied, tags, warnings };
}

async function applyOp(op: PlanOp, at: (p: Path) => SceneNode, root: SceneNode, tags: Record<string, string>): Promise<string | void> {
  switch (op.op) {
    case "resize": {
      const n = at(op.path);
      if (!("resize" in n)) throw new Error(`"${n.name}" cannot be resized`);
      const hugV = "layoutSizingVertical" in n && n.layoutSizingVertical === "HUG";
      n.resize(op.width, op.height ?? n.height);
      if (n.type === "TEXT") n.textAutoResize = "HEIGHT";
      else if (hugV && op.height === undefined) (n as FrameNode).layoutSizingVertical = "HUG";
      return;
    }
    case "setLayout": {
      const target = at(op.path);
      if (!("layoutMode" in target)) throw new Error(`"${target.name}" does not support Auto-Layout`);
      const n = target as FrameNode;
      if (op.layoutMode && op.layoutMode !== "GRID") n.layoutMode = op.layoutMode;
      if (op.layoutWrap && n.layoutMode === "HORIZONTAL") n.layoutWrap = op.layoutWrap;
      if (op.itemSpacing !== undefined) n.itemSpacing = op.itemSpacing;
      if (op.counterAxisSpacing !== undefined && n.layoutWrap === "WRAP") n.counterAxisSpacing = op.counterAxisSpacing;
      if (op.padding?.top !== undefined) n.paddingTop = op.padding.top;
      if (op.padding?.right !== undefined) n.paddingRight = op.padding.right;
      if (op.padding?.bottom !== undefined) n.paddingBottom = op.padding.bottom;
      if (op.padding?.left !== undefined) n.paddingLeft = op.padding.left;
      if (op.primaryAxisAlignItems && op.primaryAxisAlignItems !== "BASELINE") n.primaryAxisAlignItems = op.primaryAxisAlignItems;
      if (op.counterAxisAlignItems === "MIN" || op.counterAxisAlignItems === "CENTER" || op.counterAxisAlignItems === "MAX" || op.counterAxisAlignItems === "BASELINE") {
        n.counterAxisAlignItems = op.counterAxisAlignItems;
      }
      if (op.primaryAxisSizingMode) n.primaryAxisSizingMode = op.primaryAxisSizingMode;
      if (op.counterAxisSizingMode) n.counterAxisSizingMode = op.counterAxisSizingMode;
      if (op.clipsContent !== undefined) n.clipsContent = op.clipsContent;
      return;
    }
    case "setSizing": {
      const n = at(op.path) as FrameNode;
      if (op.horizontal) n.layoutSizingHorizontal = op.horizontal;
      if (op.vertical) n.layoutSizingVertical = op.vertical;
      return;
    }
    case "setMinSize": {
      const n = at(op.path) as FrameNode;
      if (op.minWidth !== undefined) n.minWidth = op.minWidth;
      if (op.minHeight !== undefined) n.minHeight = op.minHeight;
      return;
    }
    case "setText": {
      const n = at(op.path);
      if (n.type !== "TEXT") throw new Error(`"${n.name}" is not a text layer`);
      const warnings = await ensureTextFonts(n);
      if (op.fontFamily) {
        const used = await switchFamily(n, [op.fontFamily, ...(op.fontFamilyFallbacks ?? [])]);
        if (!used) warnings.push(`"${n.name}": none of ${op.fontFamily}, ${(op.fontFamilyFallbacks ?? []).join(", ")} installed — kept the original font.`);
      }
      if (op.fontSize !== undefined) n.fontSize = op.fontSize;
      if (op.textAlignHorizontal) n.textAlignHorizontal = op.textAlignHorizontal;
      if (op.characters !== undefined) n.characters = op.characters;
      return warnings.join(" ") || undefined;
    }
    case "reverseChildren": {
      const n = at(op.path) as FrameNode;
      // Only flow children swap places; absolutely positioned layers keep their z-order slot.
      const isFlow = (c: SceneNode) => !("layoutPositioning" in c) || c.layoutPositioning !== "ABSOLUTE";
      const reversed = n.children.filter(isFlow).reverse();
      let next = 0;
      const target = n.children.map((c) => (isFlow(c) ? reversed[next++]! : c));
      // Placing target[i] at i only ever moves a node forward, so earlier slots stay final.
      target.forEach((c, i) => n.insertChild(i, c));
      return;
    }
    case "setPosition": {
      const n = at(op.path);
      if (op.x !== undefined) n.x = op.x;
      if (op.y !== undefined) n.y = op.y;
      return;
    }
    case "setConstraints": {
      const n = at(op.path) as FrameNode;
      n.constraints = { horizontal: op.horizontal ?? n.constraints.horizontal, vertical: op.vertical ?? n.constraints.vertical };
      return;
    }
    case "flipHorizontal": {
      const n = at(op.path) as FrameNode;
      const [[a, c, tx], [b, d, ty]] = n.relativeTransform;
      const w = n.width;
      n.relativeTransform = [
        [-a, c, a * w + tx],
        [-b, d, b * w + ty],
      ];
      return;
    }
    case "swapComponent": {
      const n = at(op.path);
      if (n.type !== "INSTANCE") throw new Error(`"${n.name}" is not an instance`);
      n.swapComponent(await resolveComponent(op.component));
      return;
    }
    case "replaceWithInstance": {
      const old = at(op.path);
      const parent = old.parent!;
      const inst = (await resolveComponent(op.component)).createInstance();
      if (op.name) inst.name = op.name;
      insertAt(parent, (parent as ChildrenMixin).children.indexOf(old), inst);
      if (!isAutoLayout(parent)) {
        inst.x = old.x;
        inst.y = old.y;
      }
      size(inst, { fillWidth: op.fillWidth }, old.width);
      old.remove();
      if (op.tag) tags[op.tag] = inst.id;
      return;
    }
    case "insertInstance": {
      const parent = at(op.parentPath);
      const inst = (await resolveComponent(op.component)).createInstance();
      if (op.name) inst.name = op.name;
      insertAt(parent, op.index, inst);
      size(inst, op, parent.width);
      if (op.tag) tags[op.tag] = inst.id;
      return;
    }
    case "insertSpacer": {
      const parent = at(op.parentPath);
      const f = figma.createFrame();
      f.name = op.name;
      f.fills = [];
      f.resize(Math.max(1, parent.width), Math.max(0.01, op.height));
      insertAt(parent, op.index, f);
      size(f, { fillWidth: true });
      if (op.tag) tags[op.tag] = f.id;
      return;
    }
    case "insertPlaceholder": {
      const parent = at(op.parentPath);
      const f = await createPlaceholder(op.name, op.label, op.height, op.width ?? parent.width);
      insertAt(parent, op.index, f);
      size(f, { fillWidth: op.width === undefined, fillHeight: op.fillHeight });
      if (op.tag) tags[op.tag] = f.id;
      return;
    }
    case "replaceWithPlaceholder": {
      const old = at(op.path);
      const parent = old.parent!;
      const f = await createPlaceholder(op.name, op.label, old.height, old.width);
      insertAt(parent, (parent as ChildrenMixin).children.indexOf(old), f);
      if (!isAutoLayout(parent)) {
        f.x = old.x;
        f.y = old.y;
      } else if ("layoutSizingHorizontal" in old && (old as FrameNode).layoutSizingHorizontal === "FILL") {
        f.layoutSizingHorizontal = "FILL";
      }
      old.remove();
      if (op.tag) tags[op.tag] = f.id;
      return;
    }
    case "focusRing": {
      const n = at(op.path) as FrameNode;
      n.strokes = [{ type: "SOLID", color: { r: op.color.r, g: op.color.g, b: op.color.b } }];
      n.strokeWeight = op.weight;
      n.strokeAlign = "OUTSIDE";
      n.effects = [
        ...n.effects,
        { type: "DROP_SHADOW", color: { r: op.color.r, g: op.color.g, b: op.color.b, a: 0.55 }, offset: { x: 0, y: 0 }, radius: op.glowRadius, spread: 2, visible: true, blendMode: "NORMAL" },
      ];
      return;
    }
    case "removeShadows": {
      const n = at(op.path) as FrameNode;
      n.effects = n.effects.filter((e) => e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW");
      return;
    }
    case "bindVariable": {
      const n = at(op.path) as FrameNode;
      const v = await figma.variables.getVariableByIdAsync(op.variableId);
      if (!v) throw new Error(`variable ${op.variableId} not found`);
      if (op.field === "fills" || op.field === "strokes") {
        const paints = [...(n[op.field] as ReadonlyArray<Paint>)];
        const i = op.paintIndex ?? 0;
        const p = paints[i];
        if (!p || p.type !== "SOLID") throw new Error(`"${n.name}" has no solid ${op.field}[${i}]`);
        paints[i] = figma.variables.setBoundVariableForPaint(p, "color", v);
        if (op.field === "fills") n.fills = paints;
        else n.strokes = paints;
      } else {
        n.setBoundVariable(op.field as VariableBindableNodeField, v);
      }
      return;
    }
    case "rename":
      at(op.path).name = op.name;
      return;
    case "remove":
      at(op.path).remove();
      return;
    case "setPluginData":
      at(op.path).setPluginData(op.key, op.value);
      return;
    case "wrapChildren": {
      const parent = at(op.path) as FrameNode;
      const wrapper = figma.createFrame();
      wrapper.name = op.name;
      wrapper.fills = [];
      wrapper.clipsContent = false;
      wrapper.layoutMode = op.layoutMode;
      if (op.itemSpacing !== undefined) wrapper.itemSpacing = op.itemSpacing;
      wrapper.paddingTop = op.padding?.top ?? 0;
      wrapper.paddingRight = op.padding?.right ?? 0;
      wrapper.paddingBottom = op.padding?.bottom ?? 0;
      wrapper.paddingLeft = op.padding?.left ?? 0;
      const kids = [...parent.children];
      parent.appendChild(wrapper);
      // resize() pins both axes to FIXED, so the hug/fixed modes are set afterwards.
      wrapper.resize(Math.max(1, parent.width), Math.max(1, wrapper.height));
      wrapper.primaryAxisSizingMode = "AUTO";
      wrapper.counterAxisSizingMode = "FIXED";
      for (const k of kids) wrapper.appendChild(k);
      if (isAutoLayout(parent)) wrapper.layoutSizingHorizontal = "FILL";
      if (op.tag) tags[op.tag] = wrapper.id;
      return;
    }
    case "flag": {
      const target = at(op.path);
      const flag = await createFlag(root, target, op.title, op.message);
      if (op.tag) tags[op.tag] = flag.id;
      return;
    }
  }
}
