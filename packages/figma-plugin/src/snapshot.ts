import type { NodeSnapshot, PaintSnapshot } from "@figma-studio/shared-types";

const PLUGIN_KEYS = ["fas.surface", "fas.direction", "fas.sourceId"];
const NUMERIC_BINDINGS = ["itemSpacing", "counterAxisSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "cornerRadius", "topLeftRadius"];

export async function getSceneNode(id: string): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") throw new Error(`Node ${id} not found or is not a layer.`);
  return node as SceneNode;
}

function paints(value: ReadonlyArray<Paint> | PluginAPI["mixed"] | undefined): PaintSnapshot[] | undefined {
  if (!value || value === figma.mixed) return undefined;
  return (value as ReadonlyArray<Paint>).map((p) => {
    const out: PaintSnapshot = { type: p.type, visible: p.visible !== false, opacity: p.opacity ?? 1 };
    if (p.type === "SOLID") {
      out.color = { r: p.color.r, g: p.color.g, b: p.color.b, a: 1 };
      const bound = p.boundVariables?.color;
      if (bound) out.boundVariableId = bound.id;
    }
    return out;
  });
}

const num = (v: number | PluginAPI["mixed"] | undefined): number | null | undefined => (v === figma.mixed ? null : v);

export interface SnapshotBudget {
  remaining: number;
}

/** Serialises a node (and descendants up to `depth`) into a NodeSnapshot. */
export async function snapshotNode(node: SceneNode, depth: number, budget: SnapshotBudget = { remaining: 5000 }): Promise<NodeSnapshot> {
  budget.remaining--;
  const n = node as unknown as FrameNode;
  const s: NodeSnapshot = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  };
  if ("rotation" in node && node.rotation) s.rotation = node.rotation;

  if ("layoutMode" in node) {
    const f = node as FrameNode;
    s.layoutMode = f.layoutMode;
    if (f.layoutMode !== "NONE") {
      s.layoutWrap = f.layoutWrap;
      s.primaryAxisAlignItems = f.primaryAxisAlignItems;
      s.counterAxisAlignItems = f.counterAxisAlignItems;
      s.itemSpacing = f.itemSpacing;
      s.counterAxisSpacing = f.counterAxisSpacing;
      s.paddingLeft = f.paddingLeft;
      s.paddingRight = f.paddingRight;
      s.paddingTop = f.paddingTop;
      s.paddingBottom = f.paddingBottom;
    }
    s.clipsContent = f.clipsContent;
  }
  if ("layoutSizingHorizontal" in node) {
    try {
      s.layoutSizingHorizontal = n.layoutSizingHorizontal;
      s.layoutSizingVertical = n.layoutSizingVertical;
    } catch {
      /* not applicable to this node type */
    }
  }
  if ("layoutPositioning" in node) s.layoutPositioning = n.layoutPositioning;
  if ("minWidth" in node) {
    s.minWidth = n.minWidth;
    s.minHeight = n.minHeight;
  }
  if ("constraints" in node) s.constraints = (node as ConstraintMixin).constraints;
  if ("cornerRadius" in node) s.cornerRadius = num((node as CornerMixin).cornerRadius);
  if ("fills" in node) s.fills = paints((node as GeometryMixin).fills);
  if ("strokes" in node) s.strokes = paints((node as GeometryMixin).strokes);
  if ("effects" in node) s.effects = (node as BlendMixin).effects.map((e) => ({ type: e.type, visible: e.visible }));

  if ("boundVariables" in node && node.boundVariables) {
    const bv: Record<string, string> = {};
    const raw = node.boundVariables as Record<string, VariableAlias | VariableAlias[] | undefined>;
    for (const field of NUMERIC_BINDINGS) {
      const alias = raw[field];
      if (alias && !Array.isArray(alias)) bv[field] = alias.id;
    }
    if (Object.keys(bv).length) s.boundVariables = bv;
  }

  if (node.type === "TEXT") {
    s.characters = node.characters;
    s.fontSize = num(node.fontSize);
    s.fontWeight = num(node.fontWeight);
    s.textAlignHorizontal = node.textAlignHorizontal;
    if (node.fontName !== figma.mixed) {
      s.fontFamily = node.fontName.family;
      s.fontStyle = node.fontName.style;
    } else {
      s.fontFamily = null;
    }
  }

  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    if (main) {
      const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
      s.component = { mainComponentId: main.id, mainComponentKey: main.key, mainComponentName: main.name, componentSetName: set?.name, remote: main.remote };
    }
  }

  const pd: Record<string, string> = {};
  for (const k of PLUGIN_KEYS) {
    const v = node.getPluginData(k);
    if (v) pd[k] = v;
  }
  if (Object.keys(pd).length) s.pluginData = pd;

  if ("children" in node) {
    const kids = (node as ChildrenMixin).children;
    if (depth <= 0 || budget.remaining <= 0) {
      if (kids.length) s.truncatedChildren = kids.length;
    } else {
      s.children = [];
      for (const child of kids) {
        if (budget.remaining <= 0) {
          s.truncatedChildren = kids.length - s.children.length;
          break;
        }
        s.children.push(await snapshotNode(child, depth - 1, budget));
      }
    }
  }
  return s;
}
