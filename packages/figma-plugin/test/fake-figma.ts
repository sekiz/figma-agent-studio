/**
 * A deliberately small, strict fake of the Figma Plugin API — enough to execute mutation plans in
 * Node. It enforces the same rules that make real plugins fail (FILL sizing outside Auto-Layout,
 * resizing removed nodes, missing fonts) so plan bugs surface in CI instead of on a designer's canvas.
 */
import type { NodeSnapshot } from "@figma-studio/shared-types";

let seq = 0;
const registry = new Map<string, FakeNode>();
export const MIXED = Symbol("mixed");

export class FakeNode {
  id = `F:${++seq}`;
  name: string;
  type: string;
  parent: FakeNode | null = null;
  children: FakeNode[] = [];
  removed = false;
  visible = true;
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  layoutMode = "NONE";
  layoutWrap = "NO_WRAP";
  itemSpacing = 0;
  counterAxisSpacing = 0;
  paddingLeft = 0;
  paddingRight = 0;
  paddingTop = 0;
  paddingBottom = 0;
  primaryAxisAlignItems = "MIN";
  counterAxisAlignItems = "MIN";
  primaryAxisSizingMode = "FIXED";
  counterAxisSizingMode = "FIXED";
  layoutPositioning = "AUTO";
  clipsContent = false;
  minWidth: number | null = null;
  minHeight: number | null = null;
  constraints = { horizontal: "MIN", vertical: "MIN" };
  fills: unknown[] = [];
  strokes: unknown[] = [];
  strokeWeight = 0;
  strokeAlign = "INSIDE";
  dashPattern: number[] = [];
  cornerRadius = 0;
  effects: Array<{ type: string; visible: boolean }> = [];
  relativeTransform: [[number, number, number], [number, number, number]] = [
    [1, 0, 0],
    [0, 1, 0],
  ];
  annotations: unknown[] = [];
  boundVariables: Record<string, unknown> = {};
  private _sizingH = "FIXED";
  private _sizingV = "FIXED";
  private pluginData = new Map<string, string>();
  // TEXT
  characters = "";
  fontName: { family: string; style: string } | typeof MIXED = { family: "Inter", style: "Regular" };
  fontSize = 16;
  textAlignHorizontal = "LEFT";
  textAutoResize = "WIDTH_AND_HEIGHT";
  // INSTANCE
  mainComponent: FakeNode | null = null;
  description = "";
  key = "";

  constructor(type: string, name = type) {
    this.type = type;
    this.name = name;
    registry.set(this.id, this);
  }

  private parentIsAutoLayout() {
    return !!this.parent && (this.parent.layoutMode === "HORIZONTAL" || this.parent.layoutMode === "VERTICAL");
  }
  get layoutSizingHorizontal() {
    return this._sizingH;
  }
  set layoutSizingHorizontal(v: string) {
    if (v === "FILL" && !this.parentIsAutoLayout()) throw new Error(`FILL can only be set on children of auto-layout frames ("${this.name}")`);
    if (v === "HUG" && this.layoutMode === "NONE" && this.type !== "TEXT") throw new Error(`HUG requires auto-layout ("${this.name}")`);
    this._sizingH = v;
  }
  get layoutSizingVertical() {
    return this._sizingV;
  }
  set layoutSizingVertical(v: string) {
    if (v === "FILL" && !this.parentIsAutoLayout()) throw new Error(`FILL can only be set on children of auto-layout frames ("${this.name}")`);
    this._sizingV = v;
  }

  private alive() {
    if (this.removed) throw new Error(`The node (${this.id}) does not exist`);
  }
  resize(w: number, h: number) {
    this.alive();
    if (w < 0.01 || h < 0.01) throw new Error("size must be >= 0.01");
    this.width = w;
    this.height = h;
    if (this.layoutMode !== "NONE") {
      this.primaryAxisSizingMode = "FIXED";
      this.counterAxisSizingMode = "FIXED";
    }
    this._sizingH = "FIXED";
    this._sizingV = "FIXED";
  }
  resizeWithoutConstraints(w: number, h: number) {
    this.resize(w, h);
  }
  insertChild(index: number, child: FakeNode) {
    this.alive();
    child.detach();
    child.parent = this;
    this.children.splice(index, 0, child);
  }
  appendChild(child: FakeNode) {
    this.insertChild(this.children.length, child);
  }
  private detach() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  remove() {
    this.alive();
    this.detach();
    this.removed = true;
  }
  clone(): FakeNode {
    const c = this.deepCopy();
    // Clones land next to the original in the same parent.
    if (this.parent) this.parent.insertChild(this.parent.children.indexOf(this) + 1, c);
    return c;
  }
  private deepCopy(): FakeNode {
    const c = new FakeNode(this.type, this.name);
    for (const k of ["x", "y", "width", "height", "layoutMode", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "characters", "fontSize", "layoutPositioning"] as const) {
      (c as unknown as Record<string, unknown>)[k] = this[k];
    }
    c.fontName = this.fontName;
    c.effects = [...this.effects];
    c.fills = [...this.fills];
    this.children.forEach((ch) => {
      const cc = ch.deepCopy();
      cc.parent = c;
      c.children.push(cc);
    });
    c._sizingH = this._sizingH;
    c._sizingV = this._sizingV;
    return c;
  }
  setPluginData(k: string, v: string) {
    this.pluginData.set(k, v);
  }
  getPluginData(k: string) {
    return this.pluginData.get(k) ?? "";
  }
  getRangeAllFontNames() {
    return this.fontName === MIXED ? [{ family: "Inter", style: "Regular" }] : [this.fontName];
  }
  createInstance() {
    const i = new FakeNode("INSTANCE", this.name);
    i.mainComponent = this;
    i.width = this.width;
    i.height = this.height;
    return i;
  }
  swapComponent(c: FakeNode) {
    this.mainComponent = c;
  }
  setBoundVariable(field: string, v: { id: string }) {
    this.boundVariables[field] = { type: "VARIABLE_ALIAS", id: v.id };
  }
  get absoluteBoundingBox() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

export interface FakeFigma {
  page: FakeNode;
  installedFonts: Set<string>;
  undoCommits: number;
  components: Map<string, FakeNode>;
}

export function installFakeFigma(): FakeFigma {
  registry.clear();
  const page = new FakeNode("PAGE", "Page 1");
  const state: FakeFigma = { page, installedFonts: new Set(["Inter|Regular", "Inter|Medium", "Inter|Bold", "Roboto|Regular", "Roboto|Bold"]), undoCommits: 0, components: new Map() };
  const append = (n: FakeNode) => (page.appendChild(n), n);
  (globalThis as Record<string, unknown>).figma = {
    mixed: MIXED,
    currentPage: page,
    root: { name: "Fake.fig", children: [page] },
    createFrame: () => append(new FakeNode("FRAME", "Frame")),
    createText: () => append(new FakeNode("TEXT", "Text")),
    createEllipse: () => append(new FakeNode("ELLIPSE", "Ellipse")),
    createSection: () => append(new FakeNode("SECTION", "Section")),
    getNodeByIdAsync: async (id: string) => {
      const n = registry.get(id);
      return n && !n.removed ? n : null;
    },
    loadFontAsync: async (f: { family: string; style: string }) => {
      if (!state.installedFonts.has(`${f.family}|${f.style}`)) throw new Error(`font ${f.family} ${f.style} not installed`);
    },
    importComponentByKeyAsync: async (key: string) => {
      const c = state.components.get(key);
      if (!c) throw new Error(`no component with key ${key}`);
      return c;
    },
    commitUndo: () => state.undoCommits++,
    viewport: { scrollAndZoomIntoView: () => {} },
    variables: {
      getVariableByIdAsync: async (id: string) => ({ id }),
      setBoundVariableForPaint: (p: object, _f: string, v: { id: string }) => ({ ...p, boundVariables: { color: { type: "VARIABLE_ALIAS", id: v.id } } }),
    },
  };
  return state;
}

export function component(state: FakeFigma, name: string, key: string, width = 393, height = 49): FakeNode {
  const c = new FakeNode("COMPONENT", name);
  c.key = key;
  c.width = width;
  c.height = height;
  state.components.set(key, c);
  return c;
}

/** Materialises a NodeSnapshot as a live fake tree on the page (ids are rewritten). */
export function materialize(state: FakeFigma, snap: NodeSnapshot, parent: FakeNode = state.page): FakeNode {
  const n = new FakeNode(snap.type === "INSTANCE" ? "INSTANCE" : snap.type, snap.name);
  parent.appendChild(n);
  Object.assign(n, {
    x: snap.x,
    y: snap.y,
    width: snap.width,
    height: snap.height,
    layoutMode: snap.layoutMode ?? "NONE",
    itemSpacing: snap.itemSpacing ?? 0,
    paddingLeft: snap.paddingLeft ?? 0,
    paddingRight: snap.paddingRight ?? 0,
    paddingTop: snap.paddingTop ?? 0,
    paddingBottom: snap.paddingBottom ?? 0,
    primaryAxisAlignItems: snap.primaryAxisAlignItems ?? "MIN",
    layoutPositioning: snap.layoutPositioning ?? "AUTO",
    effects: snap.effects ?? [],
    fills: snap.fills ?? [],
  });
  if (snap.type === "TEXT") {
    n.characters = snap.characters ?? "";
    n.fontSize = snap.fontSize ?? 16;
  }
  (snap.children ?? []).forEach((c) => materialize(state, c, n));
  return n;
}
