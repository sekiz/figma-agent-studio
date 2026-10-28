# Figma plugin — Agent Studio (MCP bridge)

Executes mutation plans sent by `@figma-studio/mcp-server`.

## Install

Download `agent-studio-figma-plugin-<version>.zip` from the repository's Releases, unzip it, then in the Figma **desktop** app choose *Plugins → Development → Import plugin from manifest…* and pick `manifest.json`.

The **Create demo screen + design system** button in the plugin window seeds a test file (landing page, tokens, iOS/Android navigation components, and deliberate issues). See `docs/QA.md`.

## Build from source

```bash
pnpm install
pnpm --filter @figma-studio/figma-plugin build   # → dist/code.js, dist/ui.html
```

In the Figma **desktop** app: *Plugins → Development → Import plugin from manifest…* → choose `manifest.json` in this folder. Run the plugin, then give the pairing code to your agent.

## Notes

- `documentAccess: "dynamic-page"`: the plugin only uses async document APIs.
- The sandbox has no network access. `ui.html` owns the WebSocket to `ws://localhost:3055` and relays JSON-RPC to the sandbox.
- The bridge port can be changed at the bottom of the plugin window. It must match `FIGMA_STUDIO_PORT`, and a non-default port must also be added to `networkAccess.allowedDomains` in `manifest.json`, because Figma's CSP blocks any socket that isn't listed.
- Before publishing to the Community, replace `"id"` in `manifest.json` with the id Figma assigns to your plugin.
