import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MutationPlanSchema } from "@figma-studio/shared-types";
import { designSystem, desktopLanding } from "../../shared-types/test/fixtures.js";

/**
 * End-to-end: the published bundle (dist/index.js) is spawned exactly like Claude Code / Cursor would,
 * a fake plugin connects to the bridge it hosts, and a real MCP client drives a transpose.
 */
const bundle = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const port = 30_000 + Math.floor(Math.random() * 20_000);
const CODE = "TESTE2E2";

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

describe.skipIf(!existsSync(bundle))("stdio bundle end-to-end", () => {
  it("hosts the bridge, pairs with the plugin and applies a transpose plan", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      env: { ...(process.env as Record<string, string>), FIGMA_STUDIO_PORT: String(port) },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);
    cleanups.push(() => client.close());

    // Fake plugin UI: registers the pairing code and answers RPCs like the sandbox would.
    const plans: unknown[] = [];
    const plugin = await new Promise<WebSocket>((resolve, reject) => {
      const tryConnect = (attempt: number) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on("open", () => {
          ws.send(JSON.stringify({ type: "register_plugin", protocolVersion: 1, pairingCode: CODE, fileName: "E2E.fig" }));
          resolve(ws);
        });
        ws.on("error", () => (attempt < 50 ? setTimeout(() => tryConnect(attempt + 1), 100) : reject(new Error("bridge never came up"))));
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type !== "request") return;
          const reply = (result: unknown) => ws.send(JSON.stringify({ type: "response", id: msg.id, result }));
          if (msg.method === "snapshot") reply(desktopLanding());
          else if (msg.method === "scan_design_system") reply(designSystem());
          else if (msg.method === "apply_plan") {
            plans.push(MutationPlanSchema.parse(msg.params));
            ws.send(JSON.stringify({ type: "progress", id: msg.id, done: 1, total: 1 }));
            reply({ rootId: "99:1", applied: msg.params.ops.length, tags: { "placeholder:smart_tv_10ft:tab_bar_top": "99:2", "flag:smart_tv_10ft:tab_bar_top": "99:3" }, warnings: [] });
          } else ws.send(JSON.stringify({ type: "response", id: msg.id, error: { code: "unknown_method", message: msg.method } }));
        });
      };
      tryConnect(0);
    });
    cleanups.push(() => plugin.close());

    const paired = await client.callTool({ name: "figma_connect", arguments: { pairingCode: "test-e2e2" } });
    expect(paired.isError).toBeFalsy();
    expect(JSON.stringify(paired.content)).toContain("E2E.fig");

    const res = await client.callTool({ name: "figma_transpose_surface", arguments: { sourceNodeId: "1:1", targetSurfaces: ["smart_tv_10ft"] } });
    expect(res.isError).toBeFalsy();
    const body = JSON.stringify(res.content);
    expect(body).toContain("Smart TV");
    expect(body).toContain("DECISIONS NEEDED");
    expect(plans).toHaveLength(1);
  }, 20_000);
});
