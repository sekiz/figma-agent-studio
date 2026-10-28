import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient, startBridge, type Bridge } from "@figma-studio/bridge-server";
import { DEFAULT_BRIDGE_PORT, PairingCodeSchema } from "@figma-studio/shared-types";
import { createServer } from "./server.js";
import { Studio } from "./studio.js";

const log = (m: string) => process.stderr.write(`[figma-agent-studio] ${m}\n`);

const port = Number(process.env.FIGMA_STUDIO_PORT ?? DEFAULT_BRIDGE_PORT);
const url = `ws://127.0.0.1:${port}`;

/**
 * Every MCP server process tries to host the bridge. The first one wins the port; the others reuse it
 * as clients. If the host process exits, a surviving one takes over on the next attempt.
 */
let bridge: Bridge | null = null;
async function ensureBridge(): Promise<void> {
  if (bridge) return;
  try {
    bridge = await startBridge({ port, logger: { info: (m) => log(`bridge: ${m}`), warn: (m) => log(`bridge WARN: ${m}`) } });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") log(`could not start bridge: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  await ensureBridge();
  const client = new BridgeClient({ url, log });
  client.connect();
  setInterval(() => {
    if (!client.connected) void ensureBridge();
  }, 3_000).unref();

  const preset = process.env.FIGMA_STUDIO_PAIRING_CODE;
  if (preset) {
    const code = PairingCodeSchema.safeParse(preset);
    if (code.success) client.pair(code.data).catch((e: Error) => log(`auto-pair failed: ${e.message}`));
  }

  const studio = new Studio(client, {
    figmaToken: process.env.FIGMA_ACCESS_TOKEN,
    libraryFileKeys: process.env.FIGMA_LIBRARY_FILE_KEYS?.split(",").map((s) => s.trim()).filter(Boolean),
    log,
  });
  const toolset = process.env.FIGMA_STUDIO_TOOLSET === "full" ? "full" : "core";
  const server = createServer(studio, client, url, toolset);
  await server.connect(new StdioServerTransport());
  log(`ready (${toolset} tools) — bridge ${url}${bridge ? " (hosted here)" : " (shared)"}; open the Figma plugin and pair with figma_connect`);

  const shutdown = async () => {
    client.close();
    await bridge?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((e: Error) => {
  log(`fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
