# Changelog

## 0.3.0 — 2026-10-28

Ready to try without a build or a design file.

- **Demo seed:** the plugin's "Create demo screen + design system" button builds a 1440px landing page, a token collection and iOS/Android navigation components. It also seeds deliberate gaps (TV tabs, tablet sidebar) and issues (hardcoded fill, off-grid padding, low contrast) so every tool has something to do.
- **`figma_preview`:** returns a PNG of a frame so the agent can check its own result visually.
- **`figma_undo`:** removes what the last operation, or the whole session, created; in-place edits are listed for Cmd/Ctrl+Z.
- **Release workflow:** tags publish a ready-to-import plugin zip to GitHub Releases, and the MCP server to npm when `NPM_TOKEN` is set. `pnpm package:plugin` builds the zip locally.
- **Fix:** two-column grids inside narrow containers now fall back to one column instead of producing negative widths.
- **Fix:** contrast checks no longer treat neighbouring text layers or Auto-Layout siblings as the background.
- **Docs:** real-canvas QA checklist (`docs/QA.md`).
- **Tests:** 177, including the full demo pipeline (seed → scan → snapshot → transpose / RTL / audit → apply) on the fake Figma API.

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
