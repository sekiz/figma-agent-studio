import { describe, expect, it } from "vitest";
import { hexToRgba, type DsComponent } from "@figma-studio/shared-types";
import { BLACK, BRAND, WHITE, designSystem, frame, node, row, solid, text } from "../../shared-types/test/fixtures.js";
import {
  auditDesignSystem,
  contrastRatio,
  createMirrorFinder,
  createResolver,
  fetchLibraryComponents,
  mergeIndexes,
  parseVariantName,
  requiredRatio,
  resolveBackground,
  scoreComponent,
  swapDirectionWords,
  tokenize,
} from "../src/index.js";

const comp = (name: string, extra: Partial<DsComponent> = {}): DsComponent => ({ id: `C:${name}`, name, source: "local", ...extra });

describe("taxonomy tokenizer", () => {
  it("splits slash paths, variants, camelCase and builds compounds", () => {
    const t = tokenize("Navigation/TabBar/Bottom/iOS", "Type=Bottom, Platform=iOS");
    expect(t).toEqual(expect.arrayContaining(["navigation", "tab", "bar", "tabbar", "bottom", "ios", "platform"]));
  });
});

describe("component resolver", () => {
  const ds = designSystem({
    components: [
      comp("Navigation/Bar/Bottom/iOS"),
      comp("Navigation/Bar/Bottom/Android"),
      comp("Navigation/Bar/Top/iOS"),
      comp("Platform=Android", { componentSetName: "Top App Bar", variantProperties: { Platform: "Android" } }),
      comp("Status Bar/iPhone"),
      comp("Button/Primary"),
      comp("Card/Product"),
    ],
  });
  const resolve = createResolver(ds);

  it("matches [Category]/[Component]/[Variant]/[Platform] names", () => {
    expect(resolve({ role: "nav_bottom", surface: "ios" }).match?.name).toBe("Navigation/Bar/Bottom/iOS");
    expect(resolve({ role: "nav_bottom", surface: "android_m3" }).match?.name).toBe("Navigation/Bar/Bottom/Android");
    expect(resolve({ role: "nav_top", surface: "ios" }).match?.name).toBe("Navigation/Bar/Top/iOS");
  });
  it("matches variant sets by their set name and properties", () => {
    expect(resolve({ role: "nav_top", surface: "android_m3" }).match?.name).toBe("Top App Bar / Platform=Android");
  });
  it("uses platform synonyms (iPhone → iOS)", () => {
    expect(resolve({ role: "status_bar", surface: "ios" }).match?.name).toBe("Status Bar/iPhone");
  });
  it("never accepts a bottom bar as a top bar or another platform's component", () => {
    const bottomAsTop = scoreComponent(comp("Navigation/Bar/Bottom/iOS"), { role: "nav_top", surface: "ios" });
    expect(bottomAsTop).toBeLessThan(0.75);
    expect(resolve({ role: "tab_bar_top", surface: "smart_tv_10ft" }).match).toBeUndefined();
  });
  it("returns sub-threshold candidates for the variant-fallback option", () => {
    const r = resolve({ role: "nav_bottom", surface: "tablet" });
    expect(r.match).toBeUndefined();
    expect(r.candidates[0]?.name).toMatch(/Navigation\/Bar\/Bottom/);
  });
});

describe("mirror finder", () => {
  it("swaps direction words without touching unrelated words", () => {
    expect(swapDirectionWords("ChevronLeft")).toBe("Chevron Right");
    expect(swapDirectionWords("arrow_back")).toBe("arrow_forward");
    expect(swapDirectionWords("Background")).toBe("Background");
  });
  const ds = designSystem({
    components: [
      comp("Icon/Chevron/Left"),
      comp("Icon/Chevron/Right"),
      comp("Direction=LTR, Size=M", { componentSetName: "Top Bar" }),
      comp("Direction=RTL, Size=M", { componentSetName: "Top Bar" }),
    ],
  });
  const find = createMirrorFinder(ds);
  it("finds the flipped icon", () => {
    expect(find({ mainComponentName: "Icon/Chevron/Left", remote: false }, "flipped_icon")?.name).toBe("Icon/Chevron/Right");
  });
  it("finds the Direction=RTL sibling variant with the same other properties", () => {
    expect(find({ mainComponentName: "Direction=LTR, Size=M", componentSetName: "Top Bar", remote: false }, "rtl_variant")?.name).toBe("Direction=RTL, Size=M");
  });
  it("returns null when nothing matches", () => {
    expect(find({ mainComponentName: "Icon/Star", remote: false }, "flipped_icon")).toBeNull();
  });
});

describe("WCAG contrast", () => {
  it("computes reference ratios", () => {
    expect(contrastRatio(BLACK, WHITE)).toBe(21);
    expect(contrastRatio(hexToRgba("#777777"), WHITE)).toBeCloseTo(4.48, 2);
    expect(contrastRatio(hexToRgba("#767676"), WHITE)).toBeGreaterThanOrEqual(4.5);
  });
  it("uses 3:1 for large text", () => {
    expect(requiredRatio(24, 400)).toBe(3);
    expect(requiredRatio(19, 700)).toBe(3);
    expect(requiredRatio(19, 400)).toBe(4.5);
  });
  it("finds a covering sibling rectangle behind text", () => {
    const label = text("Label", "OK", { x: 10, y: 10, width: 40, height: 20 });
    const bg = node({ name: "bg", type: "RECTANGLE", x: 0, y: 0, width: 100, height: 40, fills: [solid(BLACK)] });
    const group = frame("Button", { layoutMode: "NONE", width: 100, height: 40, fills: [solid(WHITE)] }, [bg, label]);
    expect(resolveBackground(label, [group])).toMatchObject({ kind: "solid", color: { r: 0, g: 0, b: 0 } });
  });
  it("reports gradients as unverifiable", () => {
    const t = text("T", "x");
    const parent = frame("Hero", { fills: [{ type: "GRADIENT_LINEAR", visible: true, opacity: 1 }] }, [t]);
    expect(resolveBackground(t, [parent]).kind).toBe("unverifiable");
  });
});

describe("design-system audit", () => {
  const ds = designSystem({
    components: [comp("Button/Primary")],
    variables: [
      { id: "V:brand", name: "color/brand", resolvedType: "COLOR", value: BRAND, scopes: ["ALL_SCOPES"] },
      { id: "V:s4", name: "spacing/4", resolvedType: "FLOAT", value: 16, scopes: ["GAP"] },
    ],
  });
  const screen = frame("Screen", { width: 400, height: 800, fills: [solid(WHITE)], itemSpacing: 16, paddingLeft: 13 }, [
    frame("Primary", { fills: [solid(BRAND)] }, [text("Label", "Buy", { fills: [solid(WHITE)] })]),
    text("Faint", "Low contrast", { fills: [solid(hexToRgba("#BBBBBB"))] }),
    frame("Ok", { fills: [solid(BRAND, "V:brand")] }),
    row("Off", { fills: [solid(hexToRgba("#123456"))] }),
  ]);
  const report = auditDesignSystem(screen, ds);
  const rules = (r: string) => report.findings.filter((f) => f.rule === r);

  it("flags hardcoded colors that equal a variable and offers a safe fix", () => {
    const f = rules("hardcoded_color").find((x) => x.nodeName === "Primary")!;
    expect(f.fix).toMatchObject({ op: "bindVariable", field: "fills", variableId: "V:brand", paintIndex: 0 });
    expect(rules("hardcoded_color").some((x) => x.nodeName === "Ok")).toBe(false);
  });
  it("flags off-palette colors", () => expect(rules("off_palette_color").some((f) => f.nodeName === "Off")).toBe(true));
  it("flags off-grid spacing and unbound spacing tokens", () => {
    expect(rules("off_grid_spacing")[0]?.message).toContain("paddingLeft = 13");
    expect(rules("unbound_spacing")[0]?.fix).toMatchObject({ field: "itemSpacing", variableId: "V:s4" });
  });
  it("flags WCAG AA contrast failures", () => {
    // White on indigo-500 (#6366F1) is 4.47:1 — a real, common AA failure for 16px text.
    expect(rules("contrast").map((f) => f.nodeName)).toEqual(["Label", "Faint"]);
    expect(rules("contrast")[0]!.message).toContain("4.47:1");
  });
  it("flags detached components by name", () => {
    const r = auditDesignSystem(frame("S", {}, [frame("Button/Primary")]), ds);
    expect(r.findings.some((f) => f.rule === "detached_component")).toBe(true);
  });
  it("builds a fix plan on the existing node and a bounded score", () => {
    expect(report.fixPlan?.root).toEqual({ mode: "existing", nodeId: screen.id });
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThan(100);
  });
});

describe("team library indexer", () => {
  it("parses variant names", () => {
    expect(parseVariantName("Type=Bottom, Platform=iOS")).toEqual({ Type: "Bottom", Platform: "iOS" });
    expect(parseVariantName("Navigation/Bar")).toBeUndefined();
  });
  it("reads published components through the REST API", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${(init?.headers as Record<string, string>)["X-Figma-Token"]}`);
      return new Response(
        JSON.stringify({
          meta: {
            components: [
              { key: "k1", name: "Platform=iOS", containing_frame: { containingComponentSet: { name: "Tab Bar" } } },
              { key: "k2", name: "Icon/Chevron/Left" },
            ],
          },
        }),
      );
    }) as typeof fetch;
    const comps = await fetchLibraryComponents({ token: "tok", fileKeys: ["FILE1"], fetchImpl: fakeFetch });
    expect(calls[0]).toBe("https://api.figma.com/v1/files/FILE1/components tok");
    expect(comps[0]).toMatchObject({ key: "k1", componentSetName: "Tab Bar", variantProperties: { Platform: "iOS" }, source: "library" });
    const merged = mergeIndexes(designSystem({ components: [comp("Local", { key: "k2" })] }), comps);
    expect(merged.components.map((c) => c.key)).toEqual(["k2", "k1"]);
    expect(createResolver(merged)({ role: "nav_bottom", surface: "ios" }).match?.target).toEqual({ id: undefined, key: "k1" });
  });
  it("surfaces REST errors", async () => {
    const fakeFetch = (async () => new Response("Forbidden", { status: 403 })) as typeof fetch;
    await expect(fetchLibraryComponents({ token: "t", fileKeys: ["F"], fetchImpl: fakeFetch })).rejects.toThrow("403");
  });
});

describe("contrast background regressions", () => {
  it("never treats a neighbouring text layer or an Auto-Layout sibling as the background", () => {
    const a = text("A", "First", { x: 0, y: 0, width: 100, height: 20, fills: [solid(BLACK)] });
    const b = text("B", "Second", { x: 0, y: 0, width: 100, height: 20, fills: [solid(BLACK)] });
    const card = frame("Card", { x: 0, y: 0, width: 100, height: 20, fills: [solid(BLACK)] });
    const flow = frame("Flow", { fills: [solid(WHITE)] }, [a, card, b]);
    expect(resolveBackground(b, [flow])).toMatchObject({ kind: "solid", color: { r: 1, g: 1, b: 1 } });
  });
});
