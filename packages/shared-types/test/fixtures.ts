import type { DsIndex, NodeSnapshot, Rgba } from "../src/index.js";

let seq = 0;
export const resetIds = () => (seq = 0);

export function node(partial: Partial<NodeSnapshot> & Pick<NodeSnapshot, "name" | "type">): NodeSnapshot {
  return { id: `1:${++seq}`, visible: true, x: 0, y: 0, width: 100, height: 100, ...partial };
}

export function frame(name: string, partial: Partial<NodeSnapshot> = {}, children: NodeSnapshot[] = []): NodeSnapshot {
  return node({ name, type: "FRAME", layoutMode: "VERTICAL", itemSpacing: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, ...partial, children });
}

export function row(name: string, partial: Partial<NodeSnapshot> = {}, children: NodeSnapshot[] = []): NodeSnapshot {
  return frame(name, { layoutMode: "HORIZONTAL", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER", ...partial }, children);
}

export function text(name: string, characters: string, partial: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return node({ name, type: "TEXT", characters, fontSize: 16, fontWeight: 400, fontFamily: "Inter", textAlignHorizontal: "LEFT", width: 200, height: 24, layoutSizingHorizontal: "HUG", ...partial });
}

export const solid = (c: Rgba, boundVariableId?: string) => ({ type: "SOLID", visible: true, opacity: 1, color: c, boundVariableId });
export const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };
export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
export const BRAND: Rgba = { r: 0x63 / 255, g: 0x66 / 255, b: 0xf1 / 255, a: 1 }; // #6366F1

/** A typical 1440px marketing page with nav, hero, a 4-card grid and a footer. */
export function desktopLanding(): NodeSnapshot {
  resetIds();
  const card = (i: number) =>
    frame(`Card ${i}`, { width: 296, height: 320, paddingLeft: 24, paddingRight: 24, paddingTop: 24, paddingBottom: 24, itemSpacing: 12, effects: [{ type: "DROP_SHADOW", visible: true }], fills: [solid(WHITE)] }, [
      text("Title", `Feature ${i}`, { fontSize: 24, fontWeight: 700 }),
      text("Body", "Description of the feature.", { fontSize: 16 }),
    ]);
  return frame("Landing — Desktop", { width: 1440, height: 1600, itemSpacing: 64, fills: [solid(WHITE)] }, [
    row("Header", { width: 1440, height: 80, y: 0, primaryAxisAlignItems: "SPACE_BETWEEN", paddingLeft: 80, paddingRight: 80, layoutSizingHorizontal: "FILL" }, [
      node({ name: "Logo", type: "RECTANGLE", width: 120, height: 32 }),
      row("Links", { width: 400, height: 24, itemSpacing: 32 }, [text("Link", "Home"), text("Link", "Pricing"), text("Link", "About")]),
      node({ name: "Button/Primary", type: "INSTANCE", width: 120, height: 40, component: { mainComponentName: "Size=Medium", componentSetName: "Button", remote: false } }),
    ]),
    row("Hero", { width: 1440, height: 560, y: 144, paddingLeft: 80, paddingRight: 80, paddingTop: 80, paddingBottom: 80, itemSpacing: 48 }, [
      frame("Copy", { width: 600, height: 400, itemSpacing: 24 }, [
        text("Headline", "Ship design faster", { fontSize: 56, fontWeight: 700, width: 600 }),
        text("Body", "Automate the boring parts.", { fontSize: 18, width: 600 }),
        row("CTA Button", { width: 160, height: 36, paddingLeft: 16, paddingRight: 16 }, [text("Label", "Get started")]),
      ]),
      node({ name: "Hero Image", type: "RECTANGLE", width: 640, height: 400 }),
    ]),
    row("Feature Cards", { width: 1280, height: 320, y: 768, itemSpacing: 32 }, [card(1), card(2), card(3), card(4)]),
    row("Footer", { width: 1440, height: 200, y: 1152, paddingLeft: 80, paddingRight: 80 }, [text("Copyright", "© 2026 Example Inc.")]),
  ]);
}

export function designSystem(partial: Partial<DsIndex> = {}): DsIndex {
  return { components: [], variables: [], paintStyles: [], scannedAt: "2026-01-01T00:00:00.000Z", ...partial };
}
