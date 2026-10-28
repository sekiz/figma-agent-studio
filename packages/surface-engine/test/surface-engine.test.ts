import { describe, expect, it } from "vitest";
import { MutationPlanSchema, type ComponentResolver, type PlanOp } from "@figma-studio/shared-types";
import { desktopLanding, frame, node, row, text } from "../../shared-types/test/fixtures.js";
import { findSidebar, findTopNav, isButton, isGrid, mapFontSize, mapSpacing, planTranspose, platformSpec, snap4 } from "../src/index.js";

const ofType = <K extends PlanOp["op"]>(ops: PlanOp[], k: K) => ops.filter((o): o is Extract<PlanOp, { op: K }> => o.op === k);
const at = (ops: PlanOp[], path: number[]) => ops.filter((o) => "path" in o && o.path.join("/") === path.join("/"));

/** Resolver that knows exactly the roles given. */
const resolverFor =
  (roles: string[]): ComponentResolver =>
  (q) => {
    const hit = roles.includes(q.role) ? { target: { id: `C:${q.role}` }, name: `${q.role}/${q.surface}`, score: 0.95 } : undefined;
    return { match: hit, candidates: hit ? [hit] : [{ target: { id: "C:near" }, name: "Something/Close", score: 0.4 }] };
  };

describe("platform specs (PRD §3 Module 1)", () => {
  it("iOS: iPhone 16 viewport with Dynamic Island and Home Indicator safe areas", () => {
    const s = platformSpec("ios");
    expect([s.width, s.height, s.unit]).toEqual([393, 852, "pt"]);
    expect(s.safeArea).toMatchObject({ top: 59, bottom: 34 });
    expect(s.minTouchTarget).toBe(44);
    expect(s.topNav?.height).toBe(96);
    expect(s.bottomNav?.height).toBe(49);
  });
  it("Android M3: 412dp, 24dp status bar, 48dp (3-button) or 24dp (gesture) nav, tonal elevation", () => {
    const s = platformSpec("android_m3");
    expect([s.width, s.height, s.unit]).toEqual([412, 917, "dp"]);
    expect(s.safeArea).toMatchObject({ top: 24, bottom: 48 });
    expect(platformSpec("android_m3", { androidNavigation: "gesture" }).safeArea.bottom).toBe(24);
    expect(s.topNav?.height).toBe(64);
    expect(s.bottomNav?.height).toBe(80);
    expect(s.minTouchTarget).toBe(48);
    expect(s.elevation).toBe("tonal");
  });
  it("Smart TV: 1920×1080, 80px overscan by default (configurable), focus ring, no touch", () => {
    const s = platformSpec("smart_tv_10ft");
    expect([s.width, s.height]).toEqual([1920, 1080]);
    expect([s.marginX, s.marginY]).toEqual([80, 80]);
    expect(platformSpec("smart_tv_10ft", { tvOverscan: { horizontal: 96, vertical: 54 } }).marginY).toBe(54);
    expect(s.focusRing?.weight).toBe(3);
    expect(s.minTouchTarget).toBeNull();
    expect(s.typography.minSize).toBeGreaterThanOrEqual(24);
  });
  it("Tablet: 834×1194 with a 320pt sidebar and two-column grids", () => {
    const s = platformSpec("tablet");
    expect([s.width, s.height]).toEqual([834, 1194]);
    expect(s.sidebar?.width).toBe(320);
    expect(s.grid).toBe("two_column");
  });
});

describe("type and spacing scales", () => {
  it("caps display text on phones and keeps body text", () => {
    const ios = platformSpec("ios");
    expect(mapFontSize(56, ios)).toBe(34);
    expect(mapFontSize(24, ios)).toBe(20);
    expect(mapFontSize(16, ios)).toBe(16);
    expect(mapFontSize(10, ios)).toBe(11);
  });
  it("scales TV text to a 24px minimum", () => {
    const tv = platformSpec("smart_tv_10ft");
    expect(mapFontSize(16, tv)).toBe(24);
    expect(mapFontSize(48, tv)).toBe(72);
    expect(mapFontSize(120, tv)).toBe(96);
  });
  it("compresses large desktop spacing on the 4-pt grid", () => {
    const ios = platformSpec("ios");
    expect(mapSpacing(12, ios)).toBe(12);
    expect(mapSpacing(80, ios)).toBe(40);
    expect(mapSpacing(24, ios)).toBe(16);
    expect(mapSpacing(32, platformSpec("smart_tv_10ft"))).toBe(48);
    expect(snap4(13)).toBe(12);
  });
});

describe("role detection", () => {
  const page = desktopLanding();
  it("finds the top navigation", () => expect(findTopNav(page)).toBe(0));
  it("detects similar-card rows as grids but not a two-item hero", () => {
    expect(isGrid(page.children![2]!)).toBe(true);
    expect(isGrid(page.children![1]!)).toBe(false);
  });
  it("detects buttons by layer or component name", () => {
    expect(isButton(page.children![0]!.children![2]!)).toBe(true);
    expect(isButton(page.children![1]!.children![0]!.children![2]!)).toBe(true);
  });
  it("finds a desktop sidebar only in horizontal roots", () => {
    const shell = row("App", { width: 1440, height: 900 }, [frame("Sidebar", { width: 280, height: 900 }), frame("Main", { width: 1160, height: 900 })]);
    expect(findSidebar(shell)).toBe(0);
    expect(findSidebar(desktopLanding())).toBeNull();
  });
});

describe("planTranspose → iOS", () => {
  const source = desktopLanding();
  const result = planTranspose(source, { surface: "ios", resolver: resolverFor(["nav_top", "nav_bottom"]) });
  const ops = result.plan.ops;

  it("produces a schema-valid clone plan placed beside the source", () => {
    expect(MutationPlanSchema.safeParse(result.plan).success).toBe(true);
    expect(result.plan.root).toMatchObject({ mode: "clone", sourceId: source.id, name: "Landing — Desktop — iOS", placeBesideSource: true });
  });
  it("resizes the root to 393pt and tags the surface", () => {
    expect(ofType(ops, "resize").find((o) => o.path.length === 0)).toMatchObject({ width: 393, height: 852 });
    expect(ofType(ops, "setPluginData")[0]).toMatchObject({ key: "fas.surface", value: "ios" });
  });
  it("wraps the 4-column grid into a vertical stack with full-width cards", () => {
    expect(ofType(at(ops, [2]), "setLayout")[0]).toMatchObject({ layoutMode: "VERTICAL", layoutWrap: "NO_WRAP" });
    for (const i of [0, 1, 2, 3]) expect(ofType(at(ops, [2, i]), "setSizing")[0]).toMatchObject({ horizontal: "FILL" });
  });
  it("stacks the side-by-side hero because it overflows 361pt of content", () => {
    expect(ofType(at(ops, [1]), "setLayout")[0]).toMatchObject({ layoutMode: "VERTICAL" });
  });
  it("swaps desktop navigation for DS nav bar + tab bar instances", () => {
    expect(ofType(ops, "remove").map((o) => o.path)).toContainEqual([0]);
    const inserted = ofType(ops, "insertInstance").map((o) => o.component.id);
    expect(inserted).toEqual(["C:nav_top", "C:nav_bottom"]);
    expect(result.usedComponents.map((u) => u.role)).toEqual(["nav_top", "nav_bottom"]);
    expect(result.missing).toHaveLength(0);
  });
  it("injects the 59pt Dynamic Island and 34pt Home Indicator safe areas", () => {
    const spacers = ofType(ops, "insertSpacer");
    expect(spacers.map((s) => s.height)).toEqual([59, 34]);
    expect(spacers[0]!.index).toBe(0);
    expect(spacers[1]!.index).toBe(-1);
  });
  it("puts content in a padded column so chrome stays full-bleed", () => {
    const wrap = ofType(ops, "wrapChildren")[0]!;
    expect(wrap).toMatchObject({ name: "Content", layoutMode: "VERTICAL", padding: { left: 16, right: 16 } });
    expect(wrap.itemSpacing).toBe(32);
  });
  it("scales typography and enforces a 44pt touch target on the CTA", () => {
    expect(ofType(at(ops, [1, 0, 0]), "setText")[0]).toMatchObject({ fontSize: 34, fontFamily: "SF Pro Display" });
    expect(ofType(at(ops, [1, 0, 2]), "setMinSize")[0]).toMatchObject({ minHeight: 44 });
  });
  it("orders structural ops after content ops", () => {
    const firstStructural = ops.findIndex((o) => o.op === "remove");
    const lastContent = ops.reduce((i, o, idx) => ("path" in o && o.path.length > 0 && o.op !== "remove" ? idx : i), -1);
    expect(lastContent).toBeLessThan(firstStructural);
  });
});

describe("missing component protocol (PRD §3 Module 2)", () => {
  it("flags and placeholders missing components instead of drawing detached UI", () => {
    const r = planTranspose(desktopLanding(), { surface: "ios" });
    expect(r.missing.map((m) => m.role)).toEqual(["nav_top", "nav_bottom"]);
    expect(ofType(r.plan.ops, "insertPlaceholder")).toHaveLength(2);
    const flags = ofType(r.plan.ops, "flag");
    expect(flags).toHaveLength(2);
    expect(flags[0]!.title).toContain("Missing Component");
    expect(r.missing[0]!.placeholderTag).toBe("placeholder:ios:nav_top");
    expect(ofType(r.plan.ops, "insertInstance")).toHaveLength(0);
  });
  it("optional chrome (status bar) silently falls back to a spacer", () => {
    const r = planTranspose(desktopLanding(), { surface: "ios" });
    expect(r.missing.map((m) => m.role)).not.toContain("status_bar");
  });
  it("without enforcement uses the closest variant", () => {
    const r = planTranspose(desktopLanding(), { surface: "ios", enforceDesignSystem: false, resolver: resolverFor([]) });
    expect(r.missing).toHaveLength(0);
    expect(ofType(r.plan.ops, "insertInstance").every((o) => o.component.id === "C:near")).toBe(true);
    expect(r.warnings.some((w) => w.includes("closest variant"))).toBe(true);
  });
  it("without enforcement and without candidates keeps the source navigation", () => {
    const r = planTranspose(desktopLanding(), { surface: "ios", enforceDesignSystem: false });
    expect(ofType(r.plan.ops, "remove")).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes("kept the source layer"))).toBe(true);
  });
});

describe("planTranspose → Android M3", () => {
  const r = planTranspose(desktopLanding(), { surface: "android_m3", tokens: { surfaceContainerVariableId: "V:sc" } });
  it("replaces drop shadows with tonal surfaces", () => {
    expect(ofType(r.plan.ops, "removeShadows")).toHaveLength(4);
    expect(ofType(r.plan.ops, "bindVariable").every((o) => o.variableId === "V:sc")).toBe(true);
  });
  it("uses Roboto, 24/48dp safe areas and a 48dp touch target", () => {
    expect(ofType(r.plan.ops, "setText").some((o) => o.fontFamily === "Roboto")).toBe(true);
    expect(ofType(r.plan.ops, "insertSpacer").map((s) => s.height)).toEqual([24, 48]);
    expect(ofType(r.plan.ops, "setMinSize").some((o) => o.minHeight === 48)).toBe(true);
  });
});

describe("planTranspose → Smart TV", () => {
  const r = planTranspose(desktopLanding(), { surface: "smart_tv_10ft", resolver: resolverFor(["tab_bar_top"]) });
  const ops = r.plan.ops;
  it("applies the 80px overscan margin on every edge", () => {
    expect(ofType(at(ops, []), "setLayout")[0]).toMatchObject({ padding: { top: 80, right: 80, bottom: 80, left: 80 } });
  });
  it("turns grids into a clipped D-pad row with one focused card", () => {
    expect(ofType(at(ops, [2]), "setLayout")[0]).toMatchObject({ layoutMode: "HORIZONTAL", layoutWrap: "NO_WRAP", clipsContent: true });
    const rings = ofType(ops, "focusRing");
    expect(rings).toHaveLength(1);
    expect(rings[0]).toMatchObject({ weight: 3 });
  });
  it("replaces the header in place with a top tab bar and adds no touch targets", () => {
    expect(ofType(ops, "replaceWithInstance")[0]).toMatchObject({ path: [0], component: { id: "C:tab_bar_top" } });
    expect(ofType(ops, "setMinSize").filter((o) => o.path.length > 0)).toHaveLength(0);
  });
  it("raises body text to 24px", () => {
    expect(ofType(at(ops, [3, 0]), "setText")[0]).toMatchObject({ fontSize: 24 });
  });
});

describe("planTranspose → Tablet", () => {
  const r = planTranspose(desktopLanding(), { surface: "tablet", resolver: resolverFor(["sidebar"]) });
  const ops = r.plan.ops;
  it("builds a split view: sidebar instance + content column", () => {
    expect(ofType(at(ops, []), "setLayout")[0]).toMatchObject({ layoutMode: "HORIZONTAL" });
    expect(ofType(ops, "insertInstance")[0]).toMatchObject({ index: 0, width: 320, fillWidth: false, fillHeight: true });
  });
  it("wraps the card grid into two fixed columns", () => {
    expect(ofType(at(ops, [2]), "setLayout")[0]).toMatchObject({ layoutMode: "HORIZONTAL", layoutWrap: "WRAP" });
    const content = 834 - 320 - 48;
    const gap = 24;
    expect(ofType(at(ops, [2, 0]), "resize")[0]).toMatchObject({ width: Math.floor((content - gap) / 2) });
  });
});

describe("non Auto-Layout sources", () => {
  it("only resizes and scales typography, with a clear warning", () => {
    const flat = frame("Legacy", { layoutMode: "NONE", width: 1440, height: 900 }, [text("Title", "Hello", { fontSize: 48 })]);
    const r = planTranspose(flat, { surface: "ios" });
    expect(r.warnings[0]).toContain("not an Auto-Layout frame");
    expect(ofType(r.plan.ops, "wrapChildren")).toHaveLength(0);
    expect(ofType(r.plan.ops, "setText")[0]).toMatchObject({ fontSize: 34 });
  });
  it("leaves absolutely positioned layers alone", () => {
    const page = frame("Page", { width: 1440, height: 900 }, [node({ name: "Badge", type: "FRAME", width: 2000, layoutPositioning: "ABSOLUTE" })]);
    const r = planTranspose(page, { surface: "ios" });
    expect(at(r.plan.ops, [0])).toHaveLength(0);
  });
});
