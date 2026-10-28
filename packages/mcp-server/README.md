# @figma-studio/mcp-server

The MCP server for [figma-agent-studio](https://github.com/sekiz/figma-agent-studio), a local-first AI DesignOps engine for Figma.

```bash
claude mcp add figma-studio -- npx -y @figma-studio/mcp-server
```

```json
{ "mcpServers": { "figma-studio": { "command": "npx", "args": ["-y", "@figma-studio/mcp-server"] } } }
```

Then open the **Agent Studio (MCP bridge)** plugin in Figma and give your agent the pairing code it shows.

Core tools (10): `figma_connect`, `figma_inspect`, `figma_transpose_surface`, `figma_resolve_missing_component`, `figma_mirror_rtl`, `figma_apply_text`, `figma_audit_design_system`, `figma_generate_dev_handoff`, `figma_preview`, `figma_undo`. Set `FIGMA_STUDIO_TOOLSET=full` to add `figma_scan_design_system`, `figma_create_frame`, `figma_set_fills` and `figma_set_auto_layout`.

Prompts (slash commands): `adapt_screen`, `localize_rtl`, `audit_and_fix`, `dev_handoff`, `ship_all_platforms`.

Environment: `FIGMA_STUDIO_PORT` (default 3055), `FIGMA_ACCESS_TOKEN` + `FIGMA_LIBRARY_FILE_KEYS` (optional team-library indexing), `FIGMA_STUDIO_PAIRING_CODE` (optional auto-pair), `FIGMA_STUDIO_TOOLSET` (`core` or `full`).

See the repository README for full documentation. MIT licensed. Not affiliated with Figma, Inc.
