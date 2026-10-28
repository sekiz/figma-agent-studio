# figma-agent-studio

**Local-first AI DesignOps engine for Figma, driven by MCP agents (Claude Code, Cursor, any MCP client).**

Select a desktop frame, ask your agent, and get platform-accurate **iOS**, **Android (Material 3)**, **Smart TV (10-foot)** and **Tablet** versions. It can also mirror screens to **RTL**, **audit them against your design system**, and write a **developer handoff** on the canvas. It uses your design system's components and variables. When a component is missing, it flags it and asks you what to do; it never draws a detached copy.

[Türkçe README](docs/README.tr.md) · [Product requirements (v1.1)](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md)

> **Status: 0.2 (alpha).** The engines, the bridge, the MCP server and the plugin's plan executor are covered by 166 automated tests, including a strict fake of the Figma Plugin API. The plugin hasn't had broad QA in the real Figma desktop app yet, so please [report](https://github.com/sekiz/figma-agent-studio/issues) anything that behaves differently on a real canvas.

```
┌──────────────┐  stdio (MCP)  ┌──────────────────────────┐  ws://127.0.0.1:3055  ┌─────────────────────┐  postMessage  ┌──────────────────┐
│ Claude Code  │──────────────▶│ @figma-studio/mcp-server │──────────────────────▶│ Figma plugin UI     │──────────────▶│ Figma sandbox    │
│ Cursor / …   │◀──────────────│  engines + bridge (host) │◀──────────────────────│ (iframe, WebSocket) │◀──────────────│ (applies plans)  │
└──────────────┘               └──────────────────────────┘    pairing code       └─────────────────────┘               └──────────────────┘
```

## What it does

| Tool | What happens on the canvas |
|---|---|
| `figma_transpose_surface` | Clones the source frame for each target surface. It reflows Auto-Layout, turns a 4-column grid into a 1-column stack (phones), 2 columns (tablet) or a D-pad carousel (TV), scales typography, enforces 44pt/48dp touch targets, and injects safe areas (Dynamic Island 59pt, Home Indicator 34pt, M3 bars, 80px TV overscan). Desktop navigation is swapped for your design system's nav bar, tab bar, sidebar or TV tabs. |
| `figma_resolve_missing_component` | Runs the **missing-component protocol**. A missing component becomes a fuchsia `[DS-AUDIT-FLAG]` plus a placeholder, and the agent asks you to choose: **A** synthesize a master component from your tokens, **B** adapt the closest variant, or **C** keep a wireframe. |
| `figma_mirror_rtl` | Mirrors a screen to RTL with no loss. Horizontal Auto-Layout is reversed *and* its alignment flipped, padding is swapped, text alignment is inverted, directional icons are flipped or swapped to their DS counterparts, and absolute layers are mirrored. Phone numbers, URLs, prices and code stay LTR. Optionally the agent translates the copy to Arabic or Hebrew. |
| `figma_audit_design_system` | Finds detached components, hardcoded colors that equal a variable, off-palette colors, off-grid spacing, unbound spacing tokens and WCAG AA contrast failures, and gives a health score. With `autoFixSafeTokens` it binds identical values to their variables. |
| `figma_generate_dev_handoff` | Adds a `[HANDOFF] <Screen> - <Platform>` section: a token ledger (CSS var / Tailwind v4 / SwiftUI / Compose / RN), responsive-constraint notes and a code scaffold (React+Tailwind, SwiftUI, Jetpack Compose or React Native). |
| `figma_apply_text` | Writes translations (or any copy) into many text layers in one batch. |
| `figma_connect`, `figma_inspect` | Pairing and connection status; a compact layer outline of the selection or any layer. |
| `figma_scan_design_system`, `figma_create_frame`, `figma_set_fills`, `figma_set_auto_layout` | Only with `FIGMA_STUDIO_TOOLSET=full`: design-system listing and low-level primitives. |

Every tool acts on the **current selection** when `nodeId` is omitted.

### Workflow prompts (slash commands)

The server ships five ready-made runbooks. In Claude Code they appear as `/figma-studio:<name>`:

| Prompt | What it runs |
|---|---|
| `adapt_screen [surfaces]` | Transpose → ask about missing components in one message → resolve → summary |
| `localize_rtl [ar\|he]` | Mirror → translate with UI-copy rules (keep length, placeholders, brand names) → apply in one batch |
| `audit_and_fix` | Audit → apply exact-match token bindings → prioritised report (contrast first) |
| `dev_handoff [stack]` | Handoff section, with the stack picked from the frame's platform |
| `ship_all_platforms [surfaces]` | Audit + fix → transpose → one decision round → a handoff per platform → summary table |

## Token efficiency

Write-capable Figma MCP servers usually expose dozens of primitive tools. The model reads the node tree as JSON and then issues one call per change. figma-agent-studio does the layout work server-side and applies it as one plan, and its results are written for a model to read:

- **Small, consolidated toolset:** 8 core tools instead of dozens of primitives (`FIGMA_STUDIO_TOOLSET=full` adds 4 more).
- **One call per job.** The node tree never goes through the model; the engines read it directly.
- **Plain-text results with a `detail` switch.** `concise` is the default; `detailed` lists every item.
- **Grouped warnings.** "48× [iOS, Android M3, Tablet] font … not installed" is one line, not 48.
- **Selection by default.** No separate "get selection" round-trip before each action.
- **Budgets enforced in CI** (`packages/mcp-server/test/token-budget.test.ts`).

Measured on the same machine with the same method (≈3.6 characters per token, `tools/list` JSON):

| Server | Tools | Tool definitions (re-sent every turn) |
|---|---|---|
| cursor-talk-to-figma-mcp 0.3.5 | 40 | ≈ 6,470 tokens |
| **figma-agent-studio 0.2 (core)** | **8** | **≈ 1,880 tokens** |
| figma-agent-studio 0.2 (full) | 12 | ≈ 2,650 tokens |

Results for the 1440px fixture screen in the test suite:

| Call | Result size |
|---|---|
| `figma_transpose_surface` to iOS, Android, TV and Tablet (170 canvas changes) | ≈ 410 tokens |
| `figma_mirror_rtl` with Arabic strings to translate | ≈ 170 tokens |
| `figma_audit_design_system` | ≈ 110 tokens |
| `figma_generate_dev_handoff` (section rendered on canvas) | ≈ 30 tokens |
| `figma_inspect` outline of the whole screen | ≈ 400 tokens (raw node JSON: ≈ 2,130) |

For comparison, applying those 170 changes with primitive tools means reading the tree, then making about 170 tool calls over many turns, each turn re-sending the tool definitions. Even with 10 parallel calls per turn, that's on the order of 100k tokens, against about 4k here. That figure is an estimate from the counts above, not a benchmark, and real screens are 10–50× larger than the fixture, which widens the gap.

## Quick start (about 60 seconds)

**1. Add the MCP server to your agent**

Claude Code:

```bash
claude mcp add figma-studio -- npx -y @figma-studio/mcp-server
```

Cursor (`~/.cursor/mcp.json`) or any MCP client:

```json
{
  "mcpServers": {
    "figma-studio": { "command": "npx", "args": ["-y", "@figma-studio/mcp-server"] }
  }
}
```

**2. Install the Figma plugin.** In the Figma **desktop** app: *Plugins → Development → Import plugin from manifest…* and choose `packages/figma-plugin/manifest.json` (run `pnpm build` first; see [Development](#development)). A Community release is planned.

**3. Pair.** Run the plugin. It shows a code like `K7QM-2XPA`. Tell your agent:

> Connect to Figma with code K7QM-2XPA, then adapt the selected frame for iOS, Android and TV.

The agent calls `figma_connect` and then the tools above. The plugin window must stay open while the agent works.

### Optional: team libraries

The Figma Plugin API can't list components that live in another library file; it can only import them by key. To let DS-Sentinel match published library components, give the server read access to the REST API:

```json
"env": {
  "FIGMA_ACCESS_TOKEN": "figd_…",
  "FIGMA_LIBRARY_FILE_KEYS": "AbCdEf123,GhIjKl456"
}
```

| Variable | Default | Purpose |
|---|---|---|
| `FIGMA_STUDIO_PORT` | `3055` | Bridge port (must match the port in the plugin window). |
| `FIGMA_ACCESS_TOKEN` | — | Personal access token used **only** to read library component metadata. |
| `FIGMA_LIBRARY_FILE_KEYS` | — | Comma-separated library file keys to index. |
| `FIGMA_STUDIO_PAIRING_CODE` | — | Auto-pair on start (useful for scripted runs). |
| `FIGMA_STUDIO_TOOLSET` | `core` | `full` adds the design-system listing and low-level primitives. |

## Design principles

- **The design system wins.** Engines only place instances and bind variables. A missing component is a *decision for the designer*, never an improvised rectangle.
- **Pure engines, dumb executor.** All layout math (`surface-engine`, `rtl-engine`, `ds-sentinel`, `devspec`) is pure TypeScript that turns a serialised node snapshot into a **mutation plan**. The plugin only executes plans. This keeps the logic testable without Figma.
- **Paths, not ids.** Plans address layers by child-index paths, resolved *before* the first mutation. The same plan therefore applies to a fresh clone, and reorders can't invalidate later operations.
- **Never freeze the canvas.** Plans are applied in chunks of 50 operations that yield to the renderer, with progress streamed back to the agent. Each tool call is one undo step.
- **Fonts are loaded first.** Every text mutation loads all of the layer's fonts. Uninstalled fonts fall back to Inter Regular and you get a warning.
- **Local only.** The bridge binds to `127.0.0.1`, refuses browser origins other than the plugin's, and requires a pairing code. Nothing leaves your machine except the optional library-metadata request to `api.figma.com`.

## Repository layout

```
packages/
  shared-types/    zod schemas: wire protocol, node snapshots, mutation plans, DS index
  surface-engine/  SurfaceMatrix — platform specs + transpose planner
  rtl-engine/      RTLMatrix — mirroring planner + LTR shielding
  ds-sentinel/     component taxonomy matcher, token audit, WCAG contrast, library indexer
  devspec/         token ledger, responsive notes, code scaffolds
  bridge-server/   WebSocket gateway (pairing rooms, heartbeat, origin policy) + agent client
  mcp-server/      MCP tools + orchestration; bundles everything into one npm package
  figma-plugin/    manifest, sandbox plan executor, UI iframe (WebSocket relay)
```

## Development

```bash
pnpm install
pnpm build        # builds every package (plugin → packages/figma-plugin/dist)
pnpm test         # 166 tests: engines, bridge, MCP server, stdio e2e, plugin executor on a fake Figma API
pnpm typecheck
```

To try a local build in Claude Code:

```bash
claude mcp add figma-studio-dev -- node /absolute/path/to/packages/mcp-server/dist/index.js
```

While iterating on the plugin, run `pnpm --filter @figma-studio/figma-plugin watch` and re-run the plugin in Figma.

## Known limitations (0.1)

- Sources must use **Auto-Layout** for full reflow. Absolute-positioned frames get viewport and typography changes only, with a warning.
- Role detection (navigation, grids, buttons) uses layer names and structure. Clear layer names give better results.
- Groups are mirrored as a unit in RTL. Convert them to frames to mirror their contents.
- Instance sublayers can't be reordered by plugins, so RTL needs a `Direction=RTL` variant in your library. The tool tells you which components lack one.
- Library **variables** are only matched when they're used in the file. Variables from libraries that aren't used aren't indexed yet.
- Figma has no Plugin API connectors in design files. Handoff notes reference layers by name, and audit flags are also written as Dev Mode annotations where the plan supports them.

See the [roadmap in the PRD](docs/PRD.md#9-roadmap-after-01).

## Contributing

Issues and PRs are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). This is a community project and isn't affiliated with or endorsed by Figma, Inc. "Figma" is a trademark of Figma, Inc.
