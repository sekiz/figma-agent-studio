import * as esbuild from "esbuild";

/**
 * Publishes as ONE package: workspace engines are bundled in, npm dependencies stay external,
 * so `npx @figma-studio/mcp-server` works without publishing every internal package.
 */
await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/index.js",
  banner: { js: "#!/usr/bin/env node" },
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "zod", "ws"],
  logLevel: "info",
});
