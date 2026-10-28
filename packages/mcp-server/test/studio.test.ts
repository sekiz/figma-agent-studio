import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { BridgeClient } from "@figma-studio/bridge-server";
import { MutationPlanSchema, type MutationPlan, type PluginMethod } from "@figma-studio/shared-types";
import { BRAND, WHITE, designSystem, desktopLanding, frame, row, solid, text } from "../../shared-types/test/fixtures.js";
import { createServer } from "../src/server.js";
import { Studio, synthesizeSpec, type FigmaGateway } from "../src/studio.js";

const ds = designSystem({
  components: [{ id: "C:tab", key: "k-tab", name: "Navigation/Bar/Bottom/iOS", source: "local" }],
  variables: [
    { id: "V:surface", name: "color/surface", resolvedType: "COLOR", value: WHITE },
    { id: "V:on", name: "color/on-surface", resolvedType: "COLOR", value: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
    { id: "V:brand", name: "color/brand", resolvedType: "COLOR", value: BRAND },
    { id: "V:r", name: "radius/md", resolvedType: "FLOAT", value: 12 },
    { id: "V:s", name: "spacing/4", resolvedType: "FLOAT", value: 16 },
  ],
});

/** Simulates the plugin: records every call and validates every plan against the wire schema. */
function fakeFigma(snapshot = desktopLanding()) {
  const calls: Array<{ method: PluginMethod; params: unknown }> = [];
  const plans: MutationPlan[] = [];
  let rootSeq = 0;
  const gateway: FigmaGateway = {
    async request(method, params) {
      calls.push({ method, params });
      switch (method) {
        case "snapshot":
          return snapshot as never;
        case "scan_design_system":
          return structuredClone(ds) as never;
        case "apply_plan": {
          const plan = MutationPlanSchema.parse(params);
          plans.push(plan);
          const tags = Object.fromEntries(plan.ops.flatMap((o) => ("tag" in o && o.tag ? [[o.tag, `T:${o.tag}`]] : [])));
          return { rootId: `9:${++rootSeq}`, applied: plan.ops.length, tags, warnings: [] } as never;
        }
        case "synthesize_component":
          return { componentId: "S:1", name: (params as { name: string }).name } as never;
        case "remove_nodes":
          return { removed: (params as { nodeIds: string[] }).nodeIds.length } as never;
        case "render_handoff":
          return { sectionId: "SEC:1" } as never;
        case "apply_text":
          return { updated: (params as { updates: unknown[] }).updates.length, warnings: [] } as never;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { gateway, calls, plans };
}

describe("Studio.transpose", () => {
  it("creates one frame per surface and turns missing components into decisions", async () => {
    const f = fakeFigma();
    const studio = new Studio(f.gateway);
    const { results } = await studio.transpose({ sourceNodeId: "1:1", targetSurfaces: ["ios", "android_m3"] });
    expect(results.map((r) => r.frameId)).toEqual(["9:1", "9:2"]);
    expect(f.plans.map((p) => p.root.mode === "clone" && p.root.slot)).toEqual([0, 1]);

    const ios = results[0]!;
    expect(ios.usedComponents).toEqual([{ role: "nav_bottom", name: "Navigation/Bar/Bottom/iOS" }]);
    expect(ios.decisions.map((d) => d.role)).toEqual(["nav_top"]);
    expect(ios.decisions[0]).toMatchObject({ placeholderId: "T:placeholder:ios:nav_top", flagId: "T:flag:ios:nav_top", rootId: "9:1" });
    expect(results[1]!.decisions.map((d) => d.role)).toEqual(["nav_top", "nav_bottom"]);
    expect(studio.decisions.size).toBe(3);
    // The DS index is scanned once and cached.
    expect(f.calls.filter((c) => c.method === "scan_design_system")).toHaveLength(1);
  });
});

describe("Studio.resolveDecision", () => {
  async function withDecision() {
    const f = fakeFigma();
    const studio = new Studio(f.gateway);
    const {
      results: [r],
    } = await studio.transpose({ sourceNodeId: "1:1", targetSurfaces: ["ios"] });
    return { f, studio, decision: r!.decisions[0]! };
  }

  it("A) synthesizes a token-bound master component and swaps the placeholder", async () => {
    const { f, studio, decision } = await withDecision();
    const r = await studio.resolveDecision(decision.decisionId, "synthesize");
    const spec = f.calls.find((c) => c.method === "synthesize_component")!.params as ReturnType<typeof synthesizeSpec>;
    expect(spec).toMatchObject({ name: "Navigation/Bar/Top/iOS", surfaceVariableId: "V:surface", onSurfaceVariableId: "V:on", height: 96, padding: 16 });
    const last = f.plans.at(-1)!;
    expect(last.root).toEqual({ mode: "existing", nodeId: "T:placeholder:ios:nav_top" });
    expect(last.ops[0]).toMatchObject({ op: "replaceWithInstance", path: [], component: { id: "S:1" } });
    expect(f.calls.at(-1)).toEqual({ method: "remove_nodes", params: { nodeIds: ["T:flag:ios:nav_top"] } });
    expect(r.remainingDecisions).toHaveLength(0);
    expect((await studio.designSystem()).components.some((c) => c.id === "S:1")).toBe(true);
  });

  it("B) adapts the closest variant", async () => {
    const { f, studio, decision } = await withDecision();
    expect(decision.candidates[0]?.name).toBe("Navigation/Bar/Bottom/iOS");
    const r = await studio.resolveDecision(decision.decisionId, "variant_fallback");
    expect(f.plans.at(-1)!.ops[0]).toMatchObject({ op: "replaceWithInstance", component: { id: "C:tab" } });
    expect(r.outcome).toContain("closest variant");
  });

  it("C) keeps a wireframe placeholder", async () => {
    const { f, studio, decision } = await withDecision();
    await studio.resolveDecision(decision.decisionId, "placeholder");
    expect(f.plans.at(-1)!.ops[0]).toMatchObject({ op: "rename", name: "[WIREFRAME] Large Title Navigation Bar (96pt)" });
  });

  it("rejects unknown decisions", async () => {
    const studio = new Studio(fakeFigma().gateway);
    await expect(studio.resolveDecision("dec_nope", "placeholder")).rejects.toThrow("Unknown decision");
  });
});

describe("Studio.mirrorRtl / audit / handoff", () => {
  const screen = frame("Screen", { width: 393, fills: [solid(WHITE)] }, [row("Row", {}, [text("A", "Hello"), text("B", "+90 555 123 4567")]), text("C", "Buy", { fills: [solid(BRAND)] })]);

  it("mirrors and returns only translatable strings", async () => {
    const f = fakeFigma(screen);
    const r = await new Studio(f.gateway).mirrorRtl({ nodeId: "1:1", targetLanguage: "ar" });
    expect(r.stats.reversedContainers).toBe(1);
    expect(r.toTranslate.map((t) => t.characters)).toEqual(["Hello", "Buy"]);
  });

  it("audits and auto-fixes only when asked", async () => {
    const f = fakeFigma(screen);
    const studio = new Studio(f.gateway);
    const dry = await studio.audit({ nodeId: "1:1" });
    expect(dry.fixed).toBe(0);
    expect(f.plans).toHaveLength(0);
    const fixed = await studio.audit({ nodeId: "1:1", autoFixSafeTokens: true });
    expect(fixed.fixed).toBeGreaterThan(0);
    expect(f.plans[0]!.ops.every((o) => o.op === "bindVariable")).toBe(true);
  });

  it("renders the handoff section and returns markdown", async () => {
    const f = fakeFigma(screen);
    const r = await new Studio(f.gateway).handoff({ nodeId: "1:1", targetStack: "swiftui" });
    expect(r.sectionId).toBe("SEC:1");
    expect(r.markdown).toContain("[HANDOFF] Screen - iOS");
    expect(r.markdown).toContain("```swift");
  });
});

describe("MCP surface", () => {
  it("exposes a small, client-safe core toolset, workflow prompts and actionable errors", async () => {
    const studio = new Studio(fakeFigma().gateway);
    const bridgeClient = new BridgeClient({ url: "ws://127.0.0.1:1", reconnect: false });
    const server = createServer(studio, bridgeClient, "ws://127.0.0.1:1");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "figma_apply_text",
        "figma_audit_design_system",
        "figma_connect",
        "figma_generate_dev_handoff",
        "figma_inspect",
        "figma_mirror_rtl",
        "figma_resolve_missing_component",
        "figma_transpose_surface",
      ].sort(),
    );
    // Some clients (e.g. the Claude API) only accept ^[a-zA-Z0-9_-]{1,64}$ — no dots.
    for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(client.getInstructions()).toContain("figma_connect");

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["adapt_screen", "audit_and_fix", "dev_handoff", "localize_rtl", "ship_all_platforms"]);
    const adapt = await client.getPrompt({ name: "adapt_screen", arguments: { surfaces: "iphone, tv" } });
    const text = (adapt.messages[0]!.content as { text: string }).text;
    expect(text).toContain("for: ios, smart_tv_10ft.");
    expect(text).toContain("Never pick an option for a missing design-system component yourself");
    const rtl = await client.getPrompt({ name: "localize_rtl", arguments: { language: "he" } });
    expect((rtl.messages[0]!.content as { text: string }).text).toContain('targetLanguage="he"');

    const status = await client.callTool({ name: "figma_connect", arguments: {} });
    expect(JSON.stringify(status.content)).toContain("not paired");

    const notPaired = await client.callTool({ name: "figma_inspect", arguments: {} });
    expect(notPaired.isError).toBe(true);
    expect(JSON.stringify(notPaired.content)).toContain("bridge restarts automatically");

    const badId = await client.callTool({ name: "figma_inspect", arguments: { nodeId: "not-an-id" } });
    expect(badId.isError).toBe(true);
    expect(JSON.stringify(badId.content)).toContain("isn't a Figma layer id");
    await client.close();
  });
});

describe("selection defaults", () => {
  it("acts on the single selected layer when nodeId is omitted", async () => {
    const f = fakeFigma();
    const gateway = { ...f.gateway, request: (async (m: string, p: unknown) => (m === "get_selection" ? [{ id: "7:7", name: "S", type: "FRAME" }] : f.gateway.request(m as never, p as never))) as typeof f.gateway.request };
    await new Studio(gateway).audit({});
    expect(f.calls.find((c) => c.method === "snapshot")?.params).toEqual({ nodeId: "7:7" });
  });
  it("asks which layer to use when several are selected", async () => {
    const gateway = { request: (async () => [{ id: "1:1", name: "A", type: "FRAME" }, { id: "1:2", name: "B", type: "FRAME" }]) as never };
    await expect(new Studio(gateway).audit({})).rejects.toThrow('2 layers are selected; pass nodeId for one of them: 1:1 "A", 1:2 "B"');
  });
});
