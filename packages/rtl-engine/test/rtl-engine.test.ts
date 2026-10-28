import { describe, expect, it } from "vitest";
import { MutationPlanSchema, type PlanOp } from "@figma-studio/shared-types";
import { frame, node, row, text } from "../../shared-types/test/fixtures.js";
import { isDirectionalIcon, planRtl, shieldText, translatableTexts } from "../src/index.js";

const ofType = <K extends PlanOp["op"]>(ops: PlanOp[], k: K) => ops.filter((o): o is Extract<PlanOp, { op: K }> => o.op === k);
const at = (ops: PlanOp[], path: number[]) => ops.filter((o) => "path" in o && o.path.join("/") === path.join("/"));

describe("shielding (data that must stay LTR)", () => {
  it.each([
    ["+90 555 123 4567", "phone"],
    ["(212) 555-0199", "phone"],
    ["https://example.com/pricing", "url"],
    ["www.example.com", "url"],
    ["hello@example.com", "url"],
    ["example.io", "url"],
    ["$1,299.00", "number"],
    ["₺ 49,90", "number"],
    ["75%", "number"],
    ["12:45", "number"],
    ["const x = () => 1;", "code"],
    ["<Button />", "code"],
  ])("shields %s as %s", (s, reason) => expect(shieldText(s)).toBe(reason));

  it.each(["Welcome back", "Sign in to continue", "Step 2 of 3 — almost done", "Fast; secure; simple", "Return to cart", "مرحبا"])("does not shield prose: %s", (s) => expect(shieldText(s)).toBeNull());

  it("shields by layer name", () => expect(shieldText("anything", "Code Snippet")).toBe("name"));
});

describe("directional icon detection", () => {
  it.each(["arrow-left", "chevron-right", "caret-forward", "back-button", "Icon/ChevronLeft", "arrow_back", "icon/send", "Undo"])("%s is directional", (n) =>
    expect(isDirectionalIcon(n)).toBe(true),
  );
  it.each(["play", "fast-forward", "checkmark", "Logo/Brand", "search", "Background", "Card", "clock-arrow-right"])("%s is not mirrored", (n) =>
    expect(isDirectionalIcon(n)).toBe(false),
  );
});

describe("planRtl", () => {
  const toolbar = row("Toolbar", { width: 400, height: 56, paddingLeft: 16, paddingRight: 24, primaryAxisAlignItems: "MIN" }, [
    node({ name: "chevron-left", type: "VECTOR", width: 24, height: 24 }),
    text("Title", "Settings"),
    text("Contact", "+90 555 123 4567"),
  ]);
  const screen = frame("Screen", { width: 400, height: 800, counterAxisAlignItems: "MIN" }, [
    toolbar,
    text("Body", "Your preferences", { textAlignHorizontal: "LEFT" }),
    text("Centered", "Hello", { textAlignHorizontal: "CENTER" }),
    frame("Progress bar", { layoutMode: "HORIZONTAL", width: 300, height: 8 }, [node({ name: "fill", type: "RECTANGLE" }), node({ name: "track", type: "RECTANGLE" })]),
    frame("Absolute", { layoutMode: "NONE", width: 400, height: 100 }, [node({ name: "Badge", type: "FRAME", x: 10, width: 50, height: 20, constraints: { horizontal: "MIN", vertical: "MIN" } })]),
  ]);
  const r = planRtl(screen);
  const ops = r.plan.ops;

  it("produces a schema-valid plan on a duplicate", () => {
    expect(MutationPlanSchema.safeParse(r.plan).success).toBe(true);
    expect(r.plan.root).toMatchObject({ mode: "clone", name: "Screen — RTL" });
  });
  it("reverses horizontal rows AND flips their primary alignment", () => {
    expect(ofType(at(ops, [0]), "reverseChildren")).toHaveLength(1);
    expect(ofType(at(ops, [0]), "setLayout")[0]).toMatchObject({ primaryAxisAlignItems: "MAX", padding: { left: 24, right: 16 } });
  });
  it("flips counter-axis alignment of vertical stacks", () => {
    expect(ofType(at(ops, []), "setLayout")[0]).toMatchObject({ counterAxisAlignItems: "MAX" });
  });
  it("inverts LEFT text alignment and leaves CENTER untouched", () => {
    expect(ofType(at(ops, [1]), "setText")[0]).toMatchObject({ textAlignHorizontal: "RIGHT" });
    expect(at(ops, [2])).toHaveLength(0);
  });
  it("flips directional icons", () => {
    expect(ofType(at(ops, [0, 0]), "flipHorizontal")).toHaveLength(1);
    expect(r.stats.iconsFlipped).toBe(1);
  });
  it("shields phone numbers and progress bars", () => {
    expect(at(ops, [0, 2])).toHaveLength(0);
    expect(at(ops, [3])).toHaveLength(0);
    expect(r.shielded.map((s) => s.reason).sort()).toEqual(["name", "phone"]);
  });
  it("mirrors absolute positions around the parent and swaps constraints", () => {
    expect(ofType(at(ops, [4, 0]), "setPosition")[0]).toMatchObject({ x: 340 });
    expect(ofType(at(ops, [4, 0]), "setConstraints")[0]).toMatchObject({ horizontal: "MAX" });
  });
  it("swaps icon instances to their mirrored DS counterpart when available", () => {
    const icon = node({ name: "arrow-left", type: "INSTANCE", component: { mainComponentName: "Icon/Arrow/Left", remote: false } });
    const rr = planRtl(row("Bar", {}, [icon, text("t", "x")]), { findMirrorComponent: (_ref, kind) => (kind === "flipped_icon" ? { id: "C:right", name: "Icon/Arrow/Right" } : null) });
    expect(ofType(rr.plan.ops, "swapComponent")[0]).toMatchObject({ path: [0], component: { id: "C:right" } });
  });
  it("swaps whole instances to a Direction=RTL variant, or warns when none exists", () => {
    const inst = row("Nav", { type: "INSTANCE", component: { mainComponentName: "Direction=LTR", componentSetName: "Top Bar", remote: false } }, [text("a", "A"), text("b", "B")]);
    const swapped = planRtl(frame("S", {}, [inst]), { findMirrorComponent: (_r, kind) => (kind === "rtl_variant" ? { id: "C:rtl", name: "Direction=RTL" } : null) });
    expect(ofType(swapped.plan.ops, "swapComponent")[0]).toMatchObject({ component: { id: "C:rtl" } });
    const warned = planRtl(frame("S", {}, [inst]));
    expect(ofType(warned.plan.ops, "reverseChildren")).toHaveLength(0);
    expect(warned.warnings.join(" ")).toContain("Direction=RTL");
  });
  it("can mirror in place", () => {
    expect(planRtl(screen, { createDuplicate: false }).plan.root).toEqual({ mode: "existing", nodeId: screen.id });
  });
});

describe("translation hook", () => {
  it("returns only translatable prose", () => {
    const s = frame("S", {}, [text("a", "Welcome"), text("b", "+90 555 123 4567"), text("c", "https://x.com"), frame("Code block", {}, [text("d", "Not translated")])]);
    expect(translatableTexts(s).map((t) => t.characters)).toEqual(["Welcome"]);
  });
});
