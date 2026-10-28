import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BridgeClient, BridgeRequestError, isAllowedOrigin, startBridge, type Bridge } from "../src/index.js";

const silent = { info: () => {}, warn: () => {} };
const CODE = "K7QM2XPA";

/** Minimal stand-in for the plugin UI iframe. */
function fakePlugin(url: string, code = CODE, handler: (method: string, params: unknown, reply: (msg: object) => void, id: string) => void = () => {}) {
  const ws = new WebSocket(url);
  const registered = new Promise<void>((resolve, reject) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "registered") resolve();
      if (msg.type === "error") reject(new Error(msg.code));
      if (msg.type === "request") handler(msg.method, msg.params, (m) => ws.send(JSON.stringify(m)), msg.id);
    });
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "register_plugin", protocolVersion: 1, pairingCode: code, fileName: "Demo.fig" })));
  return { ws, registered };
}

let bridge: Bridge | null = null;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  cleanups.splice(0).forEach((c) => c());
  await bridge?.close();
  bridge = null;
});

async function setup() {
  bridge = await startBridge({ port: 0, logger: silent, heartbeatMs: 60_000 });
  return `ws://127.0.0.1:${bridge.port}`;
}

function client(url: string) {
  const c = new BridgeClient({ url, reconnect: false });
  c.connect();
  cleanups.push(() => c.close());
  return c;
}

describe("origin policy", () => {
  it("allows the plugin iframe (null origin), Node clients and figma.com only", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("null")).toBe(true);
    expect(isAllowedOrigin("https://www.figma.com")).toBe(true);
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("https://figma.com.evil.example")).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(false);
  });
  it("refuses browser pages from other origins at the handshake", async () => {
    const url = await setup();
    const ws = new WebSocket(url, { origin: "https://evil.example" });
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });
});

describe("pairing and RPC relay", () => {
  it("relays requests, progress and responses between agent and plugin", async () => {
    const url = await setup();
    const plugin = fakePlugin(url, CODE, (method, params, reply, id) => {
      reply({ type: "progress", id, done: 1, total: 2 });
      reply({ type: "response", id, result: { echo: method, params } });
    });
    cleanups.push(() => plugin.ws.close());
    await plugin.registered;

    const agent = client(url);
    const joined = await agent.pair("k7qm-2xpa".toUpperCase().replace("-", ""));
    expect(joined.fileName).toBe("Demo.fig");

    const progress: number[] = [];
    const result = await agent.request("snapshot", { nodeId: "1:2" }, { onProgress: (d) => progress.push(d) });
    expect(result).toEqual({ echo: "snapshot", params: { nodeId: "1:2" } });
    expect(progress).toEqual([1]);
    expect(bridge!.stats()).toMatchObject({ rooms: 1, plugins: 1, agents: 1, pending: 0 });
  });

  it("propagates plugin errors", async () => {
    const url = await setup();
    const plugin = fakePlugin(url, CODE, (_m, _p, reply, id) => reply({ type: "response", id, error: { code: "plugin_error", message: "boom" } }));
    cleanups.push(() => plugin.ws.close());
    await plugin.registered;
    const agent = client(url);
    await agent.pair(CODE);
    await expect(agent.request("get_selection", {})).rejects.toMatchObject({ code: "plugin_error", message: "boom" });
  });

  it("rejects unknown codes and closes after repeated failures", async () => {
    bridge = await startBridge({ port: 0, logger: silent, maxFailedJoins: 2 });
    const url = `ws://127.0.0.1:${bridge.port}`;
    const agent = client(url);
    await expect(agent.pair("ABCDEFGH")).rejects.toMatchObject({ code: "unknown_code" });
    const closed = new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (!agent.connected) {
          clearInterval(iv);
          resolve();
        }
      }, 10);
    });
    await expect(agent.pair("ABCDEFGJ")).rejects.toBeInstanceOf(BridgeRequestError);
    await closed;
  });

  it("refuses a second plugin window with the same code", async () => {
    const url = await setup();
    const a = fakePlugin(url);
    cleanups.push(() => a.ws.close());
    await a.registered;
    const b = fakePlugin(url);
    cleanups.push(() => b.ws.close());
    await expect(b.registered).rejects.toThrow("code_in_use");
  });

  it("fails in-flight requests when the plugin disconnects, then resumes when it re-registers", async () => {
    const url = await setup();
    const first = fakePlugin(url, CODE, () => first.ws.close());
    await first.registered;
    const agent = client(url);
    await agent.pair(CODE);
    await expect(agent.request("snapshot", { nodeId: "1:1" })).rejects.toMatchObject({ code: "plugin_disconnected" });
    await expect(agent.request("snapshot", { nodeId: "1:1" })).rejects.toMatchObject({ code: "plugin_offline" });

    const second = fakePlugin(url, CODE, (_m, _p, reply, id) => reply({ type: "response", id, result: "back" }));
    cleanups.push(() => second.ws.close());
    await second.registered;
    await new Promise((r) => setTimeout(r, 20));
    expect(agent.pluginOnline).toBe(true);
    await expect(agent.request("get_selection", {})).resolves.toBe("back");
  });

  it("requires pairing before requests", async () => {
    const url = await setup();
    const agent = client(url);
    await agent.waitForOpen();
    await expect(agent.request("get_selection", {})).rejects.toMatchObject({ code: "not_paired" });
  });

  it("times out idle requests", async () => {
    const url = await setup();
    const plugin = fakePlugin(url);
    cleanups.push(() => plugin.ws.close());
    await plugin.registered;
    const agent = client(url);
    await agent.pair(CODE);
    await expect(agent.request("get_selection", {}, { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
  });
});
