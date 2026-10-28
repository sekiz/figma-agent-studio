import type { NodeSummary, PluginMethod, PluginMethods } from "@figma-studio/shared-types";
import { applyPlan } from "./apply.js";
import { seedDemo } from "./demo.js";
import { ensureTextFonts } from "./fonts.js";
import { renderHandoff, synthesizeComponent } from "./render.js";
import { scanDesignSystem } from "./scan.js";
import { getSceneNode, snapshotNode } from "./snapshot.js";

/**
 * Sandbox entry point. The sandbox has no network access: the UI iframe owns the WebSocket and
 * relays JSON-RPC requests here via postMessage. Every handler is async and returns plain JSON.
 */

figma.showUI(__html__, { width: 340, height: 560, themeColors: true, title: "Agent Studio" });

type Handler<M extends PluginMethod> = (params: PluginMethods[M]["params"], requestId: string) => Promise<PluginMethods[M]["result"]>;
type Handlers = { [M in PluginMethod]: Handler<M> };

const summary = (n: SceneNode): NodeSummary => ({ id: n.id, name: n.name, type: n.type, width: n.width, height: n.height });

const progress = (id: string) => (done: number, total: number, message?: string) => figma.ui.postMessage({ type: "progress", id, done, total, message });

const handlers: Handlers = {
  async get_document_info() {
    return { fileName: figma.root.name, pageName: figma.currentPage.name, selection: figma.currentPage.selection.map(summary) };
  },
  async get_selection() {
    return figma.currentPage.selection.map(summary);
  },
  async snapshot({ nodeId, depth }) {
    return snapshotNode(await getSceneNode(nodeId), depth ?? 50);
  },
  async scan_design_system() {
    return scanDesignSystem();
  },
  async create_frame({ name, width, height, x, y, parentId, fill }) {
    const f = figma.createFrame();
    f.name = name;
    f.resize(width, height);
    if (fill) f.fills = [{ type: "SOLID", color: { r: fill.r, g: fill.g, b: fill.b }, opacity: fill.a }];
    if (parentId) {
      const parent = await getSceneNode(parentId);
      const parentName = parent.name;
      if (!("appendChild" in parent)) throw new Error(`"${parentName}" cannot contain layers`);
      (parent as FrameNode).appendChild(f);
    }
    if (x !== undefined) f.x = x;
    if (y !== undefined) f.y = y;
    figma.commitUndo();
    return summary(f);
  },
  async set_fills({ nodeId, color, variableId }) {
    const target = await getSceneNode(nodeId);
    if (!("fills" in target)) throw new Error(`"${target.name}" has no fills`);
    const n = target as GeometryMixin & SceneNode;
    let paint: SolidPaint = { type: "SOLID", color: color ? { r: color.r, g: color.g, b: color.b } : { r: 0, g: 0, b: 0 }, opacity: color?.a ?? 1 };
    if (variableId) {
      const v = await figma.variables.getVariableByIdAsync(variableId);
      if (!v) throw new Error(`variable ${variableId} not found`);
      paint = figma.variables.setBoundVariableForPaint(paint, "color", v);
    }
    n.fills = [paint];
    figma.commitUndo();
    return summary(n);
  },
  async set_auto_layout(p) {
    const target = await getSceneNode(p.nodeId);
    if (!("layoutMode" in target)) throw new Error(`"${target.name}" does not support Auto-Layout`);
    const n = target as FrameNode;
    n.layoutMode = p.layoutMode;
    if (p.layoutMode !== "NONE") {
      if (p.itemSpacing !== undefined) n.itemSpacing = p.itemSpacing;
      if (p.padding?.top !== undefined) n.paddingTop = p.padding.top;
      if (p.padding?.right !== undefined) n.paddingRight = p.padding.right;
      if (p.padding?.bottom !== undefined) n.paddingBottom = p.padding.bottom;
      if (p.padding?.left !== undefined) n.paddingLeft = p.padding.left;
      if (p.primaryAxisAlignItems) n.primaryAxisAlignItems = p.primaryAxisAlignItems;
      if (p.counterAxisAlignItems) n.counterAxisAlignItems = p.counterAxisAlignItems;
      if (p.layoutWrap && p.layoutMode === "HORIZONTAL") n.layoutWrap = p.layoutWrap;
    }
    figma.commitUndo();
    return summary(n);
  },
  async apply_plan(plan, id) {
    return applyPlan(plan, progress(id));
  },
  async extract_text({ nodeId }) {
    const root = await getSceneNode(nodeId);
    const texts: TextNode[] = root.type === "TEXT" ? [root] : "findAllWithCriteria" in root ? (root as FrameNode).findAllWithCriteria({ types: ["TEXT"] }) : [];
    return texts.map((t) => ({ nodeId: t.id, name: t.name, characters: t.characters }));
  },
  async apply_text({ updates }, id) {
    const warnings: string[] = [];
    let updated = 0;
    const report = progress(id);
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i]!;
      try {
        const n = await getSceneNode(u.nodeId);
        if (n.type !== "TEXT") throw new Error(`"${n.name}" is not a text layer`);
        warnings.push(...(await ensureTextFonts(n)));
        n.characters = u.characters;
        updated++;
      } catch (e) {
        warnings.push(`${u.nodeId}: ${(e as Error).message}`);
      }
      if ((i + 1) % 50 === 0) {
        report(i + 1, updates.length, "Writing text");
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    figma.commitUndo();
    return { updated, warnings };
  },
  async synthesize_component(spec) {
    const c = await synthesizeComponent(spec);
    figma.commitUndo();
    return { componentId: c.id, name: c.name };
  },
  async render_handoff({ nodeId, spec }) {
    const section = await renderHandoff(await getSceneNode(nodeId), spec);
    figma.commitUndo();
    figma.viewport.scrollAndZoomIntoView([section]);
    return { sectionId: section.id };
  },
  async export_png({ nodeId, maxSize }) {
    const node = await getSceneNode(nodeId);
    // Constrain the longer side so tall phone pages and wide TV frames both stay small.
    const tall = node.height > node.width;
    const side = Math.min(maxSize, tall ? node.height : node.width);
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: tall ? "HEIGHT" : "WIDTH", value: side } });
    const scale = side / (tall ? node.height : node.width);
    return { base64: figma.base64Encode(bytes), width: Math.round(node.width * scale), height: Math.round(node.height * scale), name: node.name };
  },
  async remove_nodes({ nodeIds }) {
    let removed = 0;
    for (const id of nodeIds) {
      const n = await figma.getNodeByIdAsync(id);
      if (n && "remove" in n && !n.removed) {
        n.remove();
        removed++;
      }
    }
    figma.commitUndo();
    return { removed };
  },
};

interface RpcMessage {
  type: "rpc";
  id: string;
  method: string;
  params: unknown;
}

figma.ui.onmessage = async (msg: RpcMessage | { type: "ui_ready" } | { type: "seed_demo" } | { type: "storage_set"; key: string; value: unknown }) => {
  if (msg.type === "seed_demo") {
    try {
      await seedDemo();
      figma.notify("Demo created and selected. Ask your agent to adapt it for iOS, Android and TV.");
      figma.ui.postMessage({ type: "demo_done" });
    } catch (e) {
      figma.notify(`Demo failed: ${(e as Error).message}`, { error: true });
      figma.ui.postMessage({ type: "demo_done", error: (e as Error).message });
    }
    return;
  }
  if (msg.type === "ui_ready") {
    const [code, port] = await Promise.all([figma.clientStorage.getAsync("pairingCode"), figma.clientStorage.getAsync("bridgePort")]);
    figma.ui.postMessage({ type: "init", fileName: figma.root.name, pairingCode: code ?? null, port: port ?? null });
    return;
  }
  if (msg.type === "storage_set") {
    await figma.clientStorage.setAsync(msg.key, msg.value);
    return;
  }
  if (msg.type !== "rpc") return;
  const handler = (handlers as Record<string, (p: unknown, id: string) => Promise<unknown>>)[msg.method];
  if (!handler) {
    figma.ui.postMessage({ type: "rpc_result", id: msg.id, error: { code: "unknown_method", message: `Unknown method ${msg.method}` } });
    return;
  }
  try {
    const result = await handler(msg.params ?? {}, msg.id);
    figma.ui.postMessage({ type: "rpc_result", id: msg.id, result });
  } catch (e) {
    figma.ui.postMessage({ type: "rpc_result", id: msg.id, error: { code: "plugin_error", message: (e as Error).message ?? String(e) } });
  }
};
