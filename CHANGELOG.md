# Changelog

## 0.2.0 — 2026-10-28

Token efficiency and workflow prompts.

- Core toolset reduced to 8 consolidated tools (≈1,880 tokens of definitions, against ≈6,470 for a 40-tool primitive server). `FIGMA_STUDIO_TOOLSET=full` restores the design-system listing and low-level primitives.
- `figma_status`, `figma_get_selection` and `figma_get_node` are merged into `figma_connect` (with no code it reports status) and `figma_inspect`.
- `nodeId` / `sourceNodeId` are optional everywhere; tools act on the current selection, and ask which layer to use when several are selected.
- Results are plain text with `detail: "concise" | "detailed"`. Transpose results shrink from ≈2,450 to ≈410 tokens and handoff results from ≈920 to ≈30.
- Repeated warnings are grouped across layers and surfaces.
- Five MCP prompts (slash commands): `adapt_screen`, `localize_rtl`, `audit_and_fix`, `dev_handoff`, `ship_all_platforms`.
- Rewritten tool descriptions and server instructions; actionable error hints for every bridge error code.
- Token budgets enforced in CI.

## 0.1.0 — 2026-10-28

First public alpha.

- SurfaceMatrix: iOS (393pt), Android M3 (412dp), Smart TV 10-foot (1920×1080, configurable overscan), Tablet (834pt split view).
- DS-Sentinel: taxonomy matcher, team-library indexer (REST), missing-component protocol (synthesize / variant fallback / wireframe), design-system audit with WCAG AA contrast.
- RTLMatrix: row reversal with alignment flip, padding swap, icon mirroring or DS swap, absolute mirroring, LTR shielding, agent-driven translation.
- DevSpec: token ledger (CSS / Tailwind v4 / SwiftUI / Compose / RN), responsive notes, code scaffolds.
- Bridge: pairing rooms, origin allow-list, heartbeat, automatic re-attach; the MCP server hosts the bridge or shares an existing one.
- 160 automated tests, including a stdio end-to-end test and a strict fake of the Figma Plugin API.
