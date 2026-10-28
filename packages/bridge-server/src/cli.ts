#!/usr/bin/env node
import { DEFAULT_BRIDGE_PORT } from "@figma-studio/shared-types";
import { startBridge } from "./bridge.js";

const port = Number(process.env.FIGMA_STUDIO_PORT ?? DEFAULT_BRIDGE_PORT);

startBridge({ port }).then(
  (bridge) => {
    const stop = () => void bridge.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },
  (err: NodeJS.ErrnoException) => {
    process.stderr.write(
      err.code === "EADDRINUSE" ? `[bridge] port ${port} is already in use — another bridge (or MCP server) is probably running.\n` : `[bridge] ${err.message}\n`,
    );
    process.exit(1);
  },
);
