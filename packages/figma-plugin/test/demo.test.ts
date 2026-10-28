import { beforeEach, describe, expect, it } from "vitest";
import { auditDesignSystem, createMirrorFinder, createResolver } from "@figma-studio/ds-sentinel";
import { planRtl } from "@figma-studio/rtl-engine";
import { planTranspose } from "@figma-studio/surface-engine";
import type { NodeSnapshot } from "@figma-studio/shared-types";
import { applyPlan } from "../src/apply.js";
import { seedDemo } from "../src/demo.js";
import { scanDesignSystem } from "../src/scan.js";
import { snapshotNode } from "../src/snapshot.js";
import { installFakeFigma, type FakeFigma, type FakeNode } from "./fake-figma.js";

/**
 * The full in-plugin pipeline on the demo file: seed → scan → snapshot → plan → apply.
 * This is the same path a designer exercises with the "Create demo" button, minus the real canvas.
 */
let fig: FakeFigma;
beforeEach(() => {
  fig = installFakeFigma();
});

async function seeded() {
  const { frameId } = await seedDemo();
  const root = (await figma.getNodeByIdAsync(frameId)) as unknown as SceneNode;
  const snap: NodeSnapshot = await snapshotNode(root, 50);
  const ds = await scanDesignSystem();
  return { frameId, snap, ds };
}

const find = (n: NodeSnapshot, name: string): NodeSnapshot | undefined =>
  n.name === name ? n : (n.children ?? []).map((c) => find(c, name)).find(Boolean);

describe("demo seed", () => {
  it("creates tokens, components and a selected 1440px landing page", async () => {
    const { snap, ds } = await seeded();
    expect(snap.width).toBe(1440);
    expect(snap.layoutMode).toBe("VERTICAL");
    expect(ds.variables.map((v) => v.name)).toEqual(expect.arrayContaining(["color/brand", "color/surface-container", "spacing/4", "radius/md"]));
    expect(ds.components.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Navigation/Bar/Top/iOS", "Navigation/Bar/Bottom/iOS", "Navigation/Bar/Top/Android", "Navigation/Bar/Bottom/Android", "Icon/Chevron/Left", "Icon/Chevron/Right"]),
    );
    expect(find(snap, "chevron-left")?.component?.mainComponentName).toBe("Icon/Chevron/Left");
    expect((figma.currentPage as unknown as FakeNode).selection.map((n) => n.name)).toEqual(["Landing — Desktop"]);
  });

  it("resolves phone navigation from the demo DS and leaves TV/tablet as decisions", async () => {
    const { snap, ds } = await seeded();
    const resolver = createResolver(ds);
    const ios = planTranspose(snap, { surface: "ios", resolver });
    expect(ios.usedComponents.map((u) => u.name).sort()).toEqual(["Navigation/Bar/Bottom/iOS", "Navigation/Bar/Top/iOS"]);
    expect(ios.missing).toHaveLength(0);
    const android = planTranspose(snap, { surface: "android_m3", resolver });
    expect(android.usedComponents.map((u) => u.name).sort()).toEqual(["Navigation/Bar/Bottom/Android", "Navigation/Bar/Top/Android"]);
    expect(planTranspose(snap, { surface: "smart_tv_10ft", resolver }).missing.map((m) => m.role)).toEqual(["tab_bar_top"]);
    expect(planTranspose(snap, { surface: "tablet", resolver }).missing.map((m) => m.role)).toEqual(["sidebar"]);
  });

  it.each(["ios", "android_m3", "smart_tv_10ft", "tablet"] as const)("applies the %s transpose without structural warnings", async (surface) => {
    const { snap, ds } = await seeded();
    const plan = planTranspose(snap, { surface, resolver: createResolver(ds) }).plan;
    const r = await applyPlan(plan, () => {});
    expect(r.warnings.filter((w) => !w.includes("font"))).toEqual([]);
  });

  it("finds the deliberate audit issues", async () => {
    const { snap, ds } = await seeded();
    const report = auditDesignSystem(snap, ds);
    const rules = (rule: string) => report.findings.filter((f) => f.rule === rule).map((f) => f.nodeName);
    expect(rules("hardcoded_color")).toContain("Promo Banner");
    expect(rules("off_grid_spacing")).toContain("Promo Banner");
    expect(rules("contrast")).toEqual(["Terms apply"]);
    expect(report.fixPlan?.ops.length).toBeGreaterThan(0);
    const fixed = await applyPlan(report.fixPlan!, () => {});
    expect(fixed.warnings).toEqual([]);
  });

  it("mirrors to RTL, swapping the chevron to its DS counterpart and shielding phone/URL", async () => {
    const { snap, ds } = await seeded();
    const rtl = planRtl(snap, { findMirrorComponent: createMirrorFinder(ds) });
    expect(rtl.stats.iconsSwapped).toBe(1);
    expect(rtl.shielded.map((s) => s.reason).sort()).toEqual(expect.arrayContaining(["phone", "url"]));
    const r = await applyPlan(rtl.plan, () => {});
    expect(r.warnings).toEqual([]);
    const out = fig.page.children.find((n) => n.id === r.rootId)!;
    const crumb = out.children.find((n) => n.name === "Breadcrumb")!;
    expect(crumb.children.at(-1)!.mainComponent?.name).toBe("Icon/Chevron/Right");
  });
});
