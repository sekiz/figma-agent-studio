import { beforeEach, describe, expect, it } from "vitest";
import { MutationPlanSchema, type MutationPlanInput } from "@figma-studio/shared-types";
import { createResolver } from "@figma-studio/ds-sentinel";
import { planRtl } from "@figma-studio/rtl-engine";
import { planTranspose } from "@figma-studio/surface-engine";
import { designSystem, desktopLanding, frame, node, row, text } from "../../shared-types/test/fixtures.js";
import { applyPlan } from "../src/apply.js";
import { component, installFakeFigma, materialize, type FakeFigma, type FakeNode } from "./fake-figma.js";

let fig: FakeFigma;
beforeEach(() => {
  fig = installFakeFigma();
});

const run = (plan: MutationPlanInput, progress: Array<[number, number]> = []) => applyPlan(MutationPlanSchema.parse(plan), (d, t) => progress.push([d, t]));
const names = (n: FakeNode) => n.children.map((c) => c.name);

describe("applyPlan basics", () => {
  it("resolves every path before mutating (reorders don't shift later ops)", async () => {
    const root = materialize(fig, row("Row", {}, [text("A", "a"), text("B", "b"), text("C", "c")]));
    await run({ root: { mode: "existing", nodeId: root.id }, ops: [{ op: "reverseChildren", path: [] }, { op: "rename", path: [0], name: "was-A" }] });
    expect(names(root)).toEqual(["C", "B", "was-A"]);
  });

  it("reverses only flow children; absolute layers keep their slot", async () => {
    const root = materialize(fig, row("Row", {}, [text("A", "a"), node({ name: "Badge", type: "FRAME", layoutPositioning: "ABSOLUTE" }), text("B", "b"), text("C", "c")]));
    await run({ root: { mode: "existing", nodeId: root.id }, ops: [{ op: "reverseChildren", path: [] }] });
    expect(names(root)).toEqual(["C", "Badge", "B", "A"]);
  });

  it("wraps children into a filling Auto-Layout column", async () => {
    const root = materialize(fig, frame("Screen", {}, [text("A", "a"), text("B", "b")]));
    const r = await run({ root: { mode: "existing", nodeId: root.id }, ops: [{ op: "wrapChildren", path: [], name: "Content", layoutMode: "VERTICAL", padding: { left: 16, right: 16 }, tag: "content" }] });
    expect(names(root)).toEqual(["Content"]);
    const wrapper = root.children[0]!;
    expect(names(wrapper)).toEqual(["A", "B"]);
    expect(wrapper.layoutSizingHorizontal).toBe("FILL");
    // resize() pins both axes in Figma; the wrapper must still grow with its content.
    expect(wrapper.primaryAxisSizingMode).toBe("AUTO");
    expect(wrapper.paddingLeft).toBe(16);
    expect(r.tags.content).toBe(wrapper.id);
  });

  it("inserts spacers at the top and bottom", async () => {
    const root = materialize(fig, frame("Screen", {}, [text("A", "a")]));
    await run({
      root: { mode: "existing", nodeId: root.id },
      ops: [
        { op: "insertSpacer", parentPath: [], index: 0, name: "Top", height: 59 },
        { op: "insertSpacer", parentPath: [], index: -1, name: "Bottom", height: 34 },
      ],
    });
    expect(names(root)).toEqual(["Top", "A", "Bottom"]);
    expect(root.children[0]!.height).toBe(59);
  });

  it("isolates failing ops as warnings and keeps going", async () => {
    const root = materialize(fig, frame("Screen", { layoutMode: "NONE" }, [text("A", "a")]));
    const r = await run({
      root: { mode: "existing", nodeId: root.id },
      ops: [
        { op: "setSizing", path: [0], horizontal: "FILL" },
        { op: "rename", path: [0], name: "Renamed" },
        { op: "rename", path: [5], name: "missing" },
      ],
    });
    expect(root.children[0]!.name).toBe("Renamed");
    expect(r.applied).toBe(1);
    expect(r.warnings.join("\n")).toMatch(/FILL can only be set/);
    expect(r.warnings.join("\n")).toMatch(/could not be resolved/);
  });

  it("replaces a layer with a library instance imported by key", async () => {
    component(fig, "Tab Bar", "k-tab");
    const root = materialize(fig, frame("Screen", {}, [frame("Old nav"), text("A", "a")]));
    const r = await run({ root: { mode: "existing", nodeId: root.id }, ops: [{ op: "replaceWithInstance", path: [0], component: { key: "k-tab" }, name: "Tab Bar", tag: "t" }] });
    expect(names(root)).toEqual(["Tab Bar", "A"]);
    expect(root.children[0]!.type).toBe("INSTANCE");
    expect(root.children[0]!.layoutSizingHorizontal).toBe("FILL");
    expect(r.tags.t).toBe(root.children[0]!.id);
  });

  it("falls back to Inter when a target font is missing, and keeps the original family otherwise", async () => {
    const root = materialize(fig, frame("Screen", {}, [text("A", "a")]));
    const r = await run({ root: { mode: "existing", nodeId: root.id }, ops: [{ op: "setText", path: [0], fontFamily: "SF Pro Display", fontFamilyFallbacks: ["SF Pro"], fontSize: 34 }] });
    expect(root.children[0]!.fontSize).toBe(34);
    expect(root.children[0]!.fontName).toEqual({ family: "Inter", style: "Regular" });
    expect(r.warnings[0]).toContain("kept the original font");
  });

  it("places clones to the right of the source and of earlier clones", async () => {
    const src = materialize(fig, frame("Desktop", { x: 0, width: 1440 }));
    const a = await run({ root: { mode: "clone", sourceId: src.id, name: "iOS" }, ops: [{ op: "resize", path: [], width: 393, height: 852 }] });
    const b = await run({ root: { mode: "clone", sourceId: src.id, name: "Android" }, ops: [] });
    const ios = fig.page.children.find((n) => n.id === a.rootId)!;
    const android = fig.page.children.find((n) => n.id === b.rootId)!;
    expect(ios.x).toBe(1640);
    expect(android.x).toBe(1640 + 393 + 200);
    expect(fig.undoCommits).toBe(2);
  });
});

describe("chunking (DoD: no canvas freezes)", () => {
  it("yields and reports progress every 50 ops", async () => {
    const root = materialize(fig, frame("Big", {}, Array.from({ length: 120 }, (_, i) => text(`t${i}`, "x"))));
    const progress: Array<[number, number]> = [];
    const r = await run({ root: { mode: "existing", nodeId: root.id }, ops: root.children.map((_, i) => ({ op: "rename" as const, path: [i], name: `n${i}` })) }, progress);
    expect(r.applied).toBe(120);
    expect(progress).toEqual([
      [50, 120],
      [100, 120],
      [120, 120],
    ]);
  });

  it("plans and applies a 2,000+ node tree", async () => {
    const cards = Array.from({ length: 400 }, (_, i) => frame(`Card ${i}`, { width: 296, height: 320, paddingLeft: 24, paddingRight: 24 }, [text("Title", `Card ${i}`, { fontSize: 24 }), text("Body", "Body copy"), row("Meta", { width: 248 }, [text("a", "1"), text("b", "2")])]));
    const big = frame("Catalog", { width: 1440, height: 20000 }, [row("Header", { width: 1440, height: 80 }, [text("Logo", "X")]), row("Product grid", { width: 1280, layoutWrap: "WRAP", itemSpacing: 32 }, cards)]);
    const t0 = performance.now();
    const t = planTranspose(big, { surface: "android_m3" });
    const planMs = performance.now() - t0;
    expect(planMs).toBeLessThan(500);
    const live = materialize(fig, big);
    const r = await applyPlan({ ...t.plan, root: { ...t.plan.root, sourceId: live.id } as never }, () => {});
    expect(r.warnings.filter((w) => !w.includes("font"))).toEqual([]);
    expect(r.applied).toBe(t.plan.ops.length);
  });
});

describe("engine plans apply cleanly to a live tree", () => {
  it.each(["ios", "android_m3", "smart_tv_10ft", "tablet"] as const)("%s transpose has no structural warnings", async (surface) => {
    component(fig, "Navigation/Bar/Bottom/iOS", "k1");
    const ds = designSystem({ components: [{ key: "k1", name: "Navigation/Bar/Bottom/iOS", source: "library" }] });
    const snap = desktopLanding();
    const live = materialize(fig, snap);
    const t = planTranspose(snap, { surface, resolver: createResolver(ds) });
    const r = await applyPlan({ ...t.plan, root: { ...t.plan.root, sourceId: live.id } as never }, () => {});
    const structural = r.warnings.filter((w) => !w.includes("font"));
    expect(structural).toEqual([]);
    const out = fig.page.children.find((n) => n.id === r.rootId)!;
    expect(out.width).toBe(t.spec.width);
    expect(out.getPluginData("fas.surface")).toBe(surface);
  });

  it("iOS output has safe areas, content column and chrome in order", async () => {
    component(fig, "Navigation/Bar/Bottom/iOS", "k1");
    const ds = designSystem({ components: [{ key: "k1", name: "Navigation/Bar/Bottom/iOS", source: "library" }] });
    const snap = desktopLanding();
    const live = materialize(fig, snap);
    const t = planTranspose(snap, { surface: "ios", resolver: createResolver(ds) });
    const r = await applyPlan({ ...t.plan, root: { ...t.plan.root, sourceId: live.id } as never }, () => {});
    const out = fig.page.children.find((n) => n.id === r.rootId)!;
    expect(names(out)).toEqual([
      "Safe Area / Status Bar (59pt)",
      "[DS-AUDIT] Large Title Navigation Bar (96pt)",
      "Content",
      "Tab Bar (49pt)",
      "Safe Area / Home Indicator (34pt)",
    ]);
    expect(names(out.children[2]!)).toEqual(["Hero", "Feature Cards", "Footer"]);
    // The fuchsia flag sits on the page above the generated frame.
    const flag = fig.page.children.find((n) => n.name.startsWith("[DS-AUDIT-FLAG]"))!;
    expect(flag.y).toBeLessThan(out.y);
  });

  it("RTL plan applies cleanly", async () => {
    const snap = frame("Screen", { counterAxisAlignItems: "MIN" }, [row("Toolbar", { paddingLeft: 8, paddingRight: 24 }, [node({ name: "chevron-left", type: "VECTOR" }), text("T", "Title")])]);
    const live = materialize(fig, snap);
    const p = planRtl(snap);
    const r = await applyPlan({ ...p.plan, root: { ...p.plan.root, sourceId: live.id } as never }, () => {});
    expect(r.warnings).toEqual([]);
    const out = fig.page.children.find((n) => n.id === r.rootId)!;
    const toolbar = out.children[0]!;
    expect(names(toolbar)).toEqual(["T", "chevron-left"]);
    expect([toolbar.paddingLeft, toolbar.paddingRight]).toEqual([24, 8]);
    expect(toolbar.children[1]!.relativeTransform[0][0]).toBe(-1);
  });
});
