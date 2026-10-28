import { describe, expect, it } from "vitest";
import { BRAND, WHITE, designSystem, frame, node, row, solid, text } from "../../shared-types/test/fixtures.js";
import { buildHandoff, buildLedger, detectPlatform, generateCode, handoffToMarkdown, kebab, tailwindSpacing, tokenLeaf } from "../src/index.js";

const ds = designSystem({
  variables: [
    { id: "V:surface", name: "color/surface-primary", resolvedType: "COLOR", value: WHITE },
    { id: "V:brand", name: "color/brand", resolvedType: "COLOR", value: BRAND, codeSyntax: { iOS: "Color.brand" } },
    { id: "V:s4", name: "spacing/4", resolvedType: "FLOAT", value: 16 },
    { id: "V:r", name: "radius/lg", resolvedType: "FLOAT", value: 8 },
  ],
});

const screen = frame(
  "Checkout",
  { width: 393, height: 852, fills: [solid(WHITE, "V:surface")], itemSpacing: 16, paddingLeft: 16, paddingRight: 16, boundVariables: { itemSpacing: "V:s4" }, pluginData: { "fas.surface": "ios" } },
  [
    text("Title", "Order summary", { fontSize: 28, fontWeight: 700 }),
    row("Actions", { layoutSizingHorizontal: "FILL", primaryAxisAlignItems: "SPACE_BETWEEN", cornerRadius: 8, fills: [solid(BRAND, "V:brand")] }, [
      text("Price", "$49.00"),
      node({ name: "Pay", type: "INSTANCE", component: { mainComponentName: "Size=Large", componentSetName: "Button/Primary", remote: false } }),
    ]),
    node({ name: "Hardcoded", type: "RECTANGLE", fills: [solid({ r: 1, g: 0, b: 0, a: 1 })] }),
  ],
);

describe("token naming", () => {
  it("normalises names", () => {
    expect(kebab("color/surfacePrimary")).toBe("color-surface-primary");
    expect(tokenLeaf("color/surface-primary")).toBe("surface-primary");
    expect(tailwindSpacing(16, "p")).toBe("p-4");
    expect(tailwindSpacing(18, "gap")).toBe("gap-[18px]");
  });
});

describe("token ledger", () => {
  const rows = buildLedger(screen, ds, "swiftui");
  it("lists every bound variable with CSS / Tailwind v4 / native mappings", () => {
    const surface = rows.find((r) => r.token === "color/surface-primary")!;
    expect(surface).toMatchObject({ css: "var(--color-surface-primary)", tailwind: "bg-surface-primary / text-surface-primary", native: 'Color("surfacePrimary")', value: "#FFFFFF" });
    expect(rows.find((r) => r.token === "spacing/4")).toMatchObject({ tailwind: "p-4 / gap-4", value: "16px" });
  });
  it("prefers Figma code syntax when present", () => {
    expect(rows.find((r) => r.token === "color/brand")?.native).toBe("Color.brand");
  });
  it("calls out hardcoded colors", () => {
    expect(rows.find((r) => r.kind === "hardcoded")?.value).toBe("#FF0000");
  });
});

describe("code scaffolds", () => {
  it("React + Tailwind", () => {
    const { language, text: code } = generateCode(screen, ds, "react_tailwind");
    expect(language).toBe("tsx");
    expect(code).toContain("export function Checkout()");
    expect(code).toContain("flex flex-col gap-4 px-4 bg-surface-primary");
    expect(code).toContain("justify-between");
    expect(code).toContain("<ButtonPrimary />");
  });
  it("SwiftUI", () => {
    const code = generateCode(screen, ds, "swiftui").text;
    expect(code).toContain("struct Checkout: View");
    expect(code).toContain("VStack(alignment: .leading, spacing: 16)");
    expect(code).toContain("Spacer()");
    expect(code).toContain('.font(.system(size: 28, weight: .bold))');
    expect(code).toContain(".background(Color.brand)");
  });
  it("Jetpack Compose", () => {
    const code = generateCode(screen, ds, "jetpack_compose").text;
    expect(code).toContain("@Composable");
    expect(code).toContain("Column(modifier = Modifier.background(AppTheme.colors.surfacePrimary)");
    expect(code).toContain("Arrangement.SpaceBetween");
    expect(code).toContain("fontSize = 28.sp");
  });
  it("React Native", () => {
    const code = generateCode(screen, ds, "react_native").text;
    expect(code).toContain("flexDirection: 'column'");
    expect(code).toContain("backgroundColor: theme.colors.surfacePrimary");
  });
  it("truncates very large trees", () => {
    const big = frame("Big", {}, Array.from({ length: 200 }, (_, i) => text(`t${i}`, `Line ${i}`)));
    const code = generateCode(big, ds, "react_tailwind", { maxLines: 30 }).text;
    expect(code.split("\n").length).toBeLessThan(40);
    expect(code).toContain("truncated");
  });
  it("escapes quotes and JSX braces", () => {
    const t = frame("E", {}, [text("q", 'Say "hi" {now}')]);
    expect(generateCode(t, ds, "swiftui").text).toContain('Text("Say \\"hi\\" {now}")');
    expect(generateCode(t, ds, "react_tailwind").text).toContain('{"{"}now{"}"}');
  });
});

describe("handoff spec", () => {
  it("detects the platform from plugin data or width", () => {
    expect(detectPlatform(screen)).toEqual({ label: "iOS", unit: "pt" });
    expect(detectPlatform(frame("x", { width: 412 }))).toEqual({ label: "Android M3", unit: "dp" });
    expect(detectPlatform(frame("x", { width: 1280 }))).toEqual({ label: "Web", unit: "px" });
  });
  it("assembles title, notes and markdown", () => {
    const spec = buildHandoff(screen, ds, "react_tailwind");
    expect(spec.title).toBe("[HANDOFF] Checkout - iOS");
    expect(spec.notes[0]!.text).toContain("393pt");
    expect(spec.notes.find((n) => n.target === "Actions")?.text).toContain("fluid");
    const md = handoffToMarkdown(spec);
    expect(md).toContain("| color/surface-primary | #FFFFFF |");
    expect(md).toContain("```tsx");
  });
});
