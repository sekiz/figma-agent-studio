# Contributing

Thanks for helping. This project is easiest to contribute to through its **pure engines**: most features are a change to a planner plus a test, with no Figma required.

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Node 20+ and pnpm 10 are required.

## Where things go

| You want to… | Change | Test in |
|---|---|---|
| Adjust a platform rule (safe area, type scale, touch target) | `packages/surface-engine/src/platforms.ts` | `surface-engine/test` |
| Improve role detection (nav, grid, button) | `packages/surface-engine/src/roles.ts` | `surface-engine/test` |
| Teach the matcher a naming convention or synonym | `packages/ds-sentinel/src/matcher.ts` | `ds-sentinel/test` |
| Add an audit rule | `packages/ds-sentinel/src/audit.ts` | `ds-sentinel/test` |
| Shield more LTR data or add a directional icon keyword | `packages/rtl-engine/src/shield.ts` | `rtl-engine/test` |
| Add a code-scaffold stack | `packages/devspec/src/codegen.ts` | `devspec/test` |
| Add a new mutation | `shared-types/src/plan.ts` → `figma-plugin/src/apply.ts` (and `test/fake-figma.ts` if it needs new API surface) | `figma-plugin/test` |
| Add an MCP tool | `mcp-server/src/studio.ts` + `server.ts` | `mcp-server/test` |

## Rules of thumb

- Engines stay pure: no Figma globals, no I/O, no randomness.
- Never generate detached UI where a design-system component or variable could be used. If you can't find one, raise a decision.
- Tool names must match `^[a-zA-Z0-9_-]{1,64}$`.
- Never write to stdout from the MCP server; stdout belongs to the MCP protocol. Log to stderr.
- If your change affects the real canvas, describe how you tested it in the Figma desktop app in the PR.

## Commit style

Use short imperative subjects ("Add Compose focus modifier"). Reference issues when relevant.
