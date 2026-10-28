import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { MutationPlanSchema, type MutationPlan } from "@figma-studio/shared-types";
import { BRAND, WHITE, designSystem, desktopLanding } from "../../shared-types/test/fixtures.js";
import { createServer, type Connection, type Toolset } from "../src/server.js";
import { Studio } from "../src/studio.js";

/**
 * Token budgets are a product feature: tool definitions are re-sent on every turn and tool results
 * stay in context for the rest of the session. These limits fail CI if a change bloats either.
 * Tokens are estimated at 3.6 characters per token (JSON-heavy text tokenises densely).
 */
const tok = (s: string) => Math.round(s.length / 3.6);

function fakeConnection(): Connection {
  const snap = desktopLanding();
  const ds = designSystem({
    variables: [
      { id: "V:b", name: "color/brand", resolvedType: "COLOR", value: BRAND },
      { id: "V:w", name: "color/surface", resolvedType: "COLOR", value: WHITE },
    ],
  });
  let n = 0;
  const conn = {
    connected: true,
    paired: true,
    pluginOnline: true,
    fileName: "Fixture.fig",
    pair: async () => ({}),
    async request(method: string, params: unknown) {
      switch (method) {
        case "get_selection":
          return [{ id: snap.id, name: snap.name, type: "FRAME", width: 1440, height: 1600 }];
        case "get_document_info":
          return { fileName: "Fixture.fig", pageName: "Page", selection: [{ id: snap.id, name: snap.name, type: "FRAME", width: 1440, height: 1600 }] };
        case "snapshot":
          return snap;
        case "scan_design_system":
          return structuredClone(ds);
        case "apply_plan": {
          const plan: MutationPlan = MutationPlanSchema.parse(params);
          const tags = Object.fromEntries(plan.ops.flatMap((o) => ("tag" in o && o.tag ? [[o.tag, `T:${o.tag}`]] : [])));
          // Realistic noise: one missing-font warning per text layer.
          const warnings = plan.ops.filter((o) => o.op === "setText" && o.fontFamily).map((_, i) => `"Text ${i}": none of SF Pro Display installed — kept the original font.`);
          return { rootId: `9:${++n}`, applied: plan.ops.length, tags, warnings };
        }
        case "render_handoff":
          return { sectionId: "S:1" };
        default:
          return {};
      }
    },
  };
  return conn as unknown as Connection;
}

async function connect(toolset: Toolset) {
  const conn = fakeConnection();
  const server = createServer(new Studio(conn), conn, "ws://127.0.0.1:3055", toolset);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "budget", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    return (r.content as Array<{ text: string }>).map((c) => c.text).join("");
  };
  return { client, call };
}

const ALL = ["ios", "android_m3", "smart_tv_10ft", "tablet"];

describe("token budgets", () => {
  it("keeps per-turn overhead small", async () => {
    const core = await connect("core");
    const { tools } = await core.client.listTools();
    expect(tools).toHaveLength(8);
    expect(tok(JSON.stringify(tools))).toBeLessThan(2000);
    expect(tok(core.client.getInstructions() ?? "")).toBeLessThan(200);
    const full = await connect("full");
    expect((await full.client.listTools()).tools).toHaveLength(12);
  });

  it("returns compact results for whole jobs", async () => {
    const { call } = await connect("core");
    const budgets: Array<[string, Record<string, unknown>, number]> = [
      ["figma_inspect", { depth: 10 }, 450],
      ["figma_transpose_surface", { targetSurfaces: ALL }, 450],
      ["figma_mirror_rtl", { targetLanguage: "ar" }, 220],
      ["figma_audit_design_system", {}, 160],
      ["figma_generate_dev_handoff", { targetStack: "swiftui" }, 60],
    ];
    for (const [name, args, max] of budgets) {
      const text = await call(name, args);
      expect(tok(text), `${name}: ${text}`).toBeLessThan(max);
    }
  });

  it("collapses repeated warnings across surfaces into one line", async () => {
    const { call } = await connect("core");
    const text = await call("figma_transpose_surface", { targetSurfaces: ALL });
    const fontLines = text.split("\n").filter((l) => l.includes("SF Pro"));
    expect(fontLines).toHaveLength(1);
    // TV keeps the source font family, so only the three platforms that swap fonts are listed.
    expect(fontLines[0]).toMatch(/^• \d+× \[iOS, Android M3, Tablet\]/);
  });

  it("still returns everything on request", async () => {
    const { call } = await connect("core");
    const concise = await call("figma_generate_dev_handoff", { targetStack: "swiftui" });
    const detailed = await call("figma_generate_dev_handoff", { targetStack: "swiftui", detail: "detailed" });
    expect(concise).not.toContain("```");
    expect(detailed).toContain("```swift");
  });
});
