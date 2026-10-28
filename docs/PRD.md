# figma-agent-studio — Product Requirements & Technical Brief (v1.1)

> **What changed from v1.0.** v1.1 keeps the product vision and the four modules, and fixes the parts that conflicted with the real Figma Plugin API and with MCP:
> team-library discovery (§4.2), the dynamic-page API (§6.3), where the WebSocket lives (§5.2), how the "ask the designer" loop works over MCP (§4.2.4), who translates RTL copy (§4.3.5), and the tool names (§7). Each change is marked **[v1.1]**.

## 1. Problem

Senior product designers spend a large share of their time on repetitive DesignOps work:

- **Multi-surface proliferation.** A 1440px desktop feature has to be rebuilt by hand for iOS (HIG, 393pt), Android (Material 3, 412dp), Smart TV (10-foot, 1920×1080) and tablet. Each needs its own Auto-Layout, touch targets and navigation.
- **Design-system fragmentation.** While adapting, designers detach components or invent one-offs because the target-platform component doesn't exist yet.
- **RTL localization overhead.** Mirroring padding, icon directions and Auto-Layout for Arabic and Hebrew is slow, manual work.
- **Handoff drag.** Writing redlines, token mappings and responsive rules for engineers is a bottleneck.

## 2. Solution

An open-source, local-first engine that connects MCP agents to the Figma canvas through:

1. an **MCP server** (stdio) exposing typed composite tools,
2. a **local WebSocket bridge** on `127.0.0.1:3055` (hosted by the MCP server process),
3. a **Figma plugin**. Its UI iframe owns the WebSocket; its sandbox executes mutation plans.

The engines turn natural-language intent into **deterministic, token-aware mutation plans**.

### 2.1 Deterministic vs. LLM responsibilities **[v1.1]**

| Concern | Owner | Why |
|---|---|---|
| Layout math, safe areas, grid wrapping, type/spacing scales | Engine (deterministic) | Must be reproducible and testable |
| Role detection (nav, grid, button, sidebar) | Engine heuristics on layer names and structure | Deterministic. The agent can rename layers to steer it |
| Component matching | DS-Sentinel scoring with a confidence threshold | Deterministic and explainable (score per candidate) |
| Choosing an option for a missing component | **The designer**, asked by the agent | Product decision, never automated by default |
| Translating copy | **The agent (LLM)** | The server has no LLM; MCP sampling isn't widely supported |
| Code scaffolds | Engine templates | Deterministic starting points, not production code |

## 3. Architecture

```
Agent ⇄ (stdio MCP) ⇄ mcp-server ── engines (pure) ──┐
                         │                            │ MutationPlan (paths, not ids)
                         └─ bridge (ws, 127.0.0.1) ⇄ plugin UI iframe ⇄ (postMessage) ⇄ plugin sandbox
```

- **Snapshots in, plans out.** The plugin serialises a node tree into a `NodeSnapshot`. Engines return a `MutationPlan`. The plugin resolves every child-index path to a live node *before* applying the first operation. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **Bridge hosting.** Every MCP server process tries to host the bridge. The first one wins the port and the others connect as clients. If the host exits, a survivor takes over within about 3 seconds. **[v1.1]**

## 4. Functional modules

### 4.1 Module 1 — SurfaceMatrix (multi-surface adaptation)

| Surface | Viewport | Type | Navigation | Rules |
|---|---|---|---|---|
| iOS (HIG) | 393×852 pt (iPhone 16) | SF Pro Text / Display; display text ≤ 34pt | Large-title nav bar 96pt + tab bar 49pt | Dynamic Island safe area 59pt, Home Indicator 34pt, min touch 44×44pt |
| Android (M3) | 412×917 dp | Roboto (fallbacks: Google Sans, Roboto Flex) | Top app bar 64dp + navigation bar 80dp | Status bar 24dp, system nav 48dp (3-button) or 24dp (gesture) **[v1.1: configurable]**, drop shadows → tonal elevation (binds a `surface-container` token when present), min touch 48×48dp |
| Smart TV (10-foot) | 1920×1080 px | Min body 24px, ×1.5 scale, cap 96px | Top tab bar (D-pad) or left rail when the source has a sidebar | Overscan margin **80px on every edge by default, configurable** **[v1.1]**, no touch targets, 3px focus ring with outer glow on the first focusable card, grids → clipped horizontal D-pad row |
| Tablet | 834×1194 pt | SF Pro | Sidebar 320pt (split view) | Content column, grids → 2 fixed columns |

**Execution:**

1. Snapshot the source; reject nothing. Non-Auto-Layout sources get viewport and typography changes only, plus a warning recommending Auto-Layout. **[v1.1]**
2. For each surface, compute available width (viewport − margins − sidebar) and walk the tree:
   - Rows wider than the available width stack vertically on phones. On tablet and TV, children share the row.
   - Grids become 1 column (phones), 2 fixed columns (tablet) or a clipped D-pad row (TV).
   - Spacing compresses on the 4-pt grid (phones ×0.5 above 16, tablet ×0.75 above 24, TV ×1.5). **Spacing bound to variables is never overwritten.**
3. Phones and tablet: move content into a padded `Content` column so system chrome stays full-bleed. Then insert status-bar or safe-area spacers, the top nav, the bottom nav and the home-indicator spacer.
4. Tag the frame with plugin data `fas.surface` (used later by DevSpec).

### 4.2 Module 2 — DS-Sentinel & missing-component protocol

**Hard rule:** the engine never draws a detached primitive when a component or variable exists. If none exists, it asks.

#### 4.2.1 Discovery **[v1.1]**

- Local: `figma.loadAllPagesAsync()`, then `findAllWithCriteria({ types: ["COMPONENT"] })`, `figma.variables.getLocalVariablesAsync()` (aliases resolved in each collection's default mode) and `getLocalPaintStylesAsync()`.
- **Team libraries:** the Plugin API can't enumerate components in other files. The **Library Indexer** reads `GET /v1/files/:key/components` with the user's own personal access token (`FIGMA_ACCESS_TOKEN`, `FIGMA_LIBRARY_FILE_KEYS`). Matches are imported with `importComponentByKeyAsync(key)`.

#### 4.2.2 Taxonomy resolver

Names are tokenised from every convention (`Navigation/Bar/Bottom/iOS`, `Type=Bottom, Platform=iOS`, set names, camelCase) and compound tokens are added (`tab bar` → `tabbar`). Each role is a list of concept groups with synonyms, plus exclusions (a bottom bar is never a top bar). Platform synonyms: iOS = {ios, iphone, apple, hig, cupertino}, Android = {android, m3, md3, material…}, TV = {tv, 10ft, tvos, androidtv…}, Tablet = {tablet, ipad, foldable}.

Score = 0.7 × (concept groups matched) + 0.3 platform bonus. A platform-agnostic component gets +0.1; another platform's component gets ×0.5. **Exact match ≥ 0.75**. Lower-scoring candidates are kept for option B.

#### 4.2.3 When a match is found

The engine places an instance (`createInstance`, imported by key when needed) that fills the slot's width.

#### 4.2.4 When a component is missing (interactive loop) **[v1.1]**

MCP notifications are one-way and can't collect an answer. The loop therefore runs through **tool results**:

1. The plan inserts a fuchsia-bordered placeholder and a **`[DS-AUDIT-FLAG]`** card (`#D946EF`) on the page above the generated frame. The flag isn't part of the frame, so it never exports with it. It's also added as a Dev Mode annotation on the affected layer where the plan supports it.
2. The tool returns `status: "needs_decision"` with a `decisionId` per missing component and the options in plain language.
3. The agent asks the designer and calls `figma_resolve_missing_component(decisionId, choice)`:
   - **A `synthesize`**: creates a master component named by the taxonomy (e.g. `Navigation/Bar/Bottom/iOS`) on a `🧩 DS Proposals` page. Fill and text are bound to the file's surface / on-surface color variables, padding comes from the spacing token and corners from the radius token. The placeholder is swapped for an instance.
   - **B `variant_fallback`**: places the closest candidate (best score below the threshold), resized to the slot.
   - **C `placeholder`**: keeps an empty, named `[WIREFRAME]` container for the designer.
4. The flag is removed once the decision is resolved.

With `enforceDesignSystem: false`, the closest candidate is used automatically. If there's none, the source layer is kept, with a warning.

#### 4.2.5 Audit (`figma_audit_design_system`)

| Rule | Severity | Auto-fix |
|---|---|---|
| Frame or group named like a DS component (likely detached) | error | — |
| Solid fill or stroke equal to a COLOR variable (scope-aware) | warning | bind variable |
| Solid color not in the palette (only when the file has color variables) | warning | — |
| Spacing or padding off the 4-pt grid | warning | — |
| Spacing equal to exactly one spacing token but unbound | info | bind variable |
| Text contrast below WCAG AA (4.5:1, or 3:1 for ≥ 24px or ≥ 18.66px bold), computed by compositing parent fills and covering sibling rectangles | error | — |
| Gradient or image background behind text | info | manual check |

Health score = 100 − 5·errors − 2·warnings − 0.5·info.

### 4.3 Module 3 — RTLMatrix

1. **Horizontal Auto-Layout:** reverse the order of the flow children **and** flip primary alignment MIN↔MAX. Both are required: reversing alone leaves a left-packed row left-packed. **[v1.1: v1.0 said "or"]** Absolutely positioned children keep their z-order slot.
2. **Vertical Auto-Layout:** flip counter-axis alignment MIN↔MAX.
3. **Padding:** swap left↔right unless the paddings are bound to variables (then warn).
4. **Text:** LEFT↔RIGHT. CENTER and JUSTIFIED stay as they are.
5. **Absolute layers:** `x' = parent.width − x − width`. Horizontal constraints MIN↔MAX.
6. **Directional icons** (`arrow-left`, `chevron-right`, `caret-forward`, `back-button`, `undo`, `send`, …): swap to the mirrored DS component (`…/Left` ↔ `…/Right`) when one exists, otherwise flip horizontally around the icon's centre. **Never flipped:** play/pause/fast-forward, checkmarks, clocks, search, logos.
7. **Instances:** plugins can't reorder an instance's sublayers. The engine swaps to a `Direction=RTL` sibling variant when one exists; otherwise it reports the component that needs one. **[v1.1]**
8. **Shielding (stays LTR, never translated):** phone numbers, URLs and emails, numbers, currency, percentages, times, code, and containers named progress / slider / chart / media / player / code / map / logo / …
9. **Translation [v1.1]:** when `targetLanguage` is `ar` or `he`, the tool returns the translatable strings of the mirrored frame. The agent translates them and calls `figma_apply_text`, which loads fonts first and falls back to Inter if a font is missing.

### 4.4 Module 4 — DevSpec

A `[HANDOFF] <Screen> - <Platform>` **section** is placed below the frame. Platform comes from `fas.surface`, or from the width when that tag is missing.

- **Token ledger.** One row per variable used: value, CSS (`var(--color-surface-primary)`, or the variable's WEB code syntax), Tailwind v4 (`bg-surface-primary`, `p-4`, `rounded-lg`) and native (SwiftUI `Color("surfacePrimary")`, Compose `AppTheme.colors.surfacePrimary`, RN `theme.colors.surfacePrimary`, or the variable's iOS/ANDROID code syntax). Hardcoded colors are listed and marked ⚠.
- **Responsive notes.** Sticky-style cards per container (fixed, fluid or hug; wraps; carousel; min sizes). Figma has no connector API in design files **[v1.1]**, so notes reference layers by name.
- **Code scaffold.** A dark card with React + Tailwind, SwiftUI, Jetpack Compose or React Native that mirrors the Auto-Layout structure and links instances to components. It's a deterministic starting point, not production code. The same handoff is returned to the agent as Markdown.

## 5. Technical stack

### 5.1 Packages

`shared-types`, `surface-engine`, `rtl-engine` **[v1.1: split out]**, `ds-sentinel`, `devspec` **[v1.1: split out]**, `bridge-server`, `mcp-server`, `figma-plugin` — pnpm workspaces + Turborepo. The `mcp-server` bundle inlines the internal packages, so only `@figma-studio/mcp-server` is published to npm.

### 5.2 Choices

- TypeScript 5.9, strict mode, no `any`; zod validates every tool input and wire message.
- `@modelcontextprotocol/sdk`, stdio transport. **[v1.1]** SSE is deprecated in MCP; Streamable HTTP is on the roadmap.
- **Plugin:** manifest `api 1.0.0`, `documentAccess: "dynamic-page"`, `networkAccess` limited to `ws://localhost:3055`. **The sandbox has no network.** The **UI iframe owns the WebSocket** and relays JSON-RPC to the sandbox via `postMessage`. **[v1.1]**
- **Bridge:** `ws`, bound to 127.0.0.1, 5s ping/pong heartbeat, reconnect with exponential backoff on both sides, protocol version check.

## 6. Non-functional requirements

### 6.1 Security **[v1.1]**

Browsers don't apply CORS to WebSockets, so any website could otherwise reach a localhost socket:

- The bridge accepts only Origin `null` (the plugin iframe), no Origin (Node clients) or `https://*.figma.com`.
- Pairing uses an 8-character code from a 31-symbol alphabet (no 0/O/1/I/L), generated in the plugin UI. A connection is closed after 5 failed join attempts.
- The bridge binds to 127.0.0.1 only. There's no remote telemetry.

### 6.2 Performance

- Mutations are chunked every 50 operations with a `setTimeout(0)` yield and a progress message. Progress resets the agent's idle timeout. One `commitUndo()` per tool call.
- Target: a 2,000-node tree is planned in under 500ms (measured in CI) and applied without blocking rendering for more than one chunk.

### 6.3 Figma API correctness **[v1.1]**

Async APIs only (`getNodeByIdAsync`, `getMainComponentAsync`, `get…Async` for styles and variables). `loadAllPagesAsync` runs before searching across pages. `page.loadAsync()` runs before writing to another page.

### 6.4 Fonts

`loadFontAsync` runs for every font in a text layer (`getRangeAllFontNames`) before any change. An uninstalled font falls back to Inter Regular with a warning. Platform font swaps (SF Pro, Roboto) try the platform fallbacks and keep the original font when none is installed.

## 7. MCP tools **[v1.1: underscores instead of dots]**

Some clients only accept tool names matching `^[a-zA-Z0-9_-]{1,64}$`, so `figma.transpose_surface` became `figma_transpose_surface`.

| Tool | Required inputs | Notes |
|---|---|---|
| `figma_transpose_surface` | `sourceNodeId`, `targetSurfaces[]` | `enforceDesignSystem` (default true), `placeBesideSource` (default true), `androidNavigation`, `tvOverscan` |
| `figma_resolve_missing_component` | `decisionId`, `choice` | `candidateIndex` for B |
| `figma_mirror_rtl` | `nodeId` | `targetLanguage` (`ar`, `he`, `none`), `swapDirectionalIcons`, `createDuplicate` |
| `figma_apply_text` | `updates[]` | Used after translation |
| `figma_audit_design_system` | `nodeId` | `autoFixSafeTokens` |
| `figma_generate_dev_handoff` | `nodeId`, `targetStack` | `renderOnCanvas` |
| `figma_preview` | | PNG of a frame for visual self-check (longest side ≤ `maxSize`) |
| `figma_undo` | | `scope: last \| session`; removes created layers, lists in-place edits |
| `figma_connect`, `figma_inspect` | | Pairing/status; compact layer outline |
| `figma_scan_design_system`, `figma_create_frame`, `figma_set_fills`, `figma_set_auto_layout` | | Only with `FIGMA_STUDIO_TOOLSET=full` |

**[v1.2] Token efficiency.** Tool definitions are re-sent on every turn, so the default toolset is 8 consolidated tools. `nodeId` is optional everywhere (the default is the current selection), results are plain text with `detail: concise | detailed`, and repeated warnings are grouped. Budgets are enforced by a CI test. MCP **prompts** (`adapt_screen`, `localize_rtl`, `audit_and_fix`, `dev_handoff`, `ship_all_platforms`) package the recommended workflows as slash commands.

## 8. Acceptance criteria (DoD)

| Criterion | How it is verified |
|---|---|
| No canvas freezes | Plan executor chunks every 50 ops (unit test asserts progress at 50/100/120); 2,000-node plan in under 500ms (CI) |
| Font handling | Executor tests: missing font → Inter fallback, platform font missing → original kept, with a warning |
| Design-system integrity | Without enforcement overrides, transpose emits no shapes, only `insertInstance`, `replaceWithInstance` or placeholder + flag (unit tests) |
| Turnkey setup | `npx -y @figma-studio/mcp-server` + manifest import + pairing code; the stdio e2e test spawns the bundle exactly like a client does |
| Real-canvas QA | **Open:** manual test matrix in the Figma desktop app before 1.0 |

## 9. Roadmap after 0.1

1. Real-canvas QA matrix and a Figma Community release.
2. Library *variables* via `figma.teamLibrary` + `importVariableByKeyAsync`.
3. Split-view and foldable variants for Android tablets. Landscape orientations.
4. A semantic role override: designers tag layers (`fas.role = nav`) when names are ambiguous.
5. Streamable HTTP transport for remote agents.
6. Batch mode: transpose every frame on a page.
7. Per-file persistence of pending decisions (survive MCP server restarts).

## 10. Milestones (as executed)

| Phase | Scope | State |
|---|---|---|
| 1 | Bridge (rooms, pairing, heartbeat, origin policy), plugin RPC, raw primitives | ✅ |
| 2 | SurfaceMatrix, safe areas, DS-Sentinel matcher, missing-component protocol, library indexer | ✅ |
| 3 | RTLMatrix with shielding, DevSpec ledger / notes / scaffolds | ✅ |
| 4 | 177 tests (unit, integration, stdio e2e, fake-Figma executor), packaging; real-canvas QA and store publishing | 🟡 QA and publishing pending |
