import { describe, expect, it } from "vitest";
import {
  ClientMessageSchema,
  MutationPlanSchema,
  PairingCodeSchema,
  countNodes,
  formatPairingCode,
  hexToRgba,
  rgbaToHex,
  sameColor,
  walk,
} from "../src/index.js";
import { desktopLanding } from "./fixtures.js";

describe("color helpers", () => {
  it("round-trips hex", () => {
    expect(rgbaToHex(hexToRgba("#6366F1"))).toBe("#6366F1");
    expect(rgbaToHex(hexToRgba("#fff"))).toBe("#FFFFFF");
    expect(rgbaToHex(hexToRgba("#00000080"), true)).toBe("#00000080");
  });
  it("rejects invalid hex", () => {
    expect(() => hexToRgba("#12")).toThrow();
    expect(() => hexToRgba("zzzzzz")).toThrow();
  });
  it("compares at 8-bit precision", () => {
    expect(sameColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, { r: 0.501, g: 0.5, b: 0.5, a: 1 })).toBe(true);
    expect(sameColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, { r: 0.52, g: 0.5, b: 0.5, a: 1 })).toBe(false);
  });
});

describe("pairing codes", () => {
  it("normalises dashes, spaces and case", () => {
    expect(PairingCodeSchema.parse("k7qm-2xpa")).toBe("K7QM2XPA");
    expect(PairingCodeSchema.parse(" K7QM 2XPA ")).toBe("K7QM2XPA");
    expect(formatPairingCode("K7QM2XPA")).toBe("K7QM-2XPA");
  });
  it("rejects ambiguous characters and wrong lengths", () => {
    expect(PairingCodeSchema.safeParse("K7QM-2XP0").success).toBe(false);
    expect(PairingCodeSchema.safeParse("K7QM").success).toBe(false);
  });
});

describe("wire messages", () => {
  it("validates client messages", () => {
    expect(ClientMessageSchema.safeParse({ type: "join", protocolVersion: 1, pairingCode: "K7QM-2XPA" }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: "request", id: "1", method: "snapshot" }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: "hack" }).success).toBe(false);
  });
});

describe("mutation plan schema", () => {
  it("accepts a valid plan and applies defaults", () => {
    const plan = MutationPlanSchema.parse({
      root: { mode: "clone", sourceId: "1:1", name: "x" },
      ops: [{ op: "insertInstance", parentPath: [], index: -1, component: { key: "abc" } }],
    });
    expect(plan.root.mode === "clone" && plan.root.placeBesideSource).toBe(true);
    expect(plan.ops[0]).toMatchObject({ fillWidth: true });
  });
  it("rejects component targets without id or key", () => {
    expect(
      MutationPlanSchema.safeParse({ root: { mode: "existing", nodeId: "1:1" }, ops: [{ op: "swapComponent", path: [0], component: {} }] }).success,
    ).toBe(false);
  });
  it("rejects negative paths", () => {
    expect(MutationPlanSchema.safeParse({ root: { mode: "existing", nodeId: "1:1" }, ops: [{ op: "remove", path: [-1] }] }).success).toBe(false);
  });
});

describe("tree walking", () => {
  it("yields paths and ancestors depth-first", () => {
    const root = desktopLanding();
    const visited = [...walk(root)];
    expect(visited.length).toBe(countNodes(root));
    const headline = visited.find((v) => v.node.name === "Headline")!;
    expect(headline.path).toEqual([1, 0, 0]);
    expect(headline.ancestors.map((a) => a.name)).toEqual(["Landing — Desktop", "Hero", "Copy"]);
  });
});
