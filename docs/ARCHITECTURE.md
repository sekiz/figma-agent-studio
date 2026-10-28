# Architecture

## Data flow

```
figma_transpose_surface(sourceNodeId, ["ios"])
  │
  ├─▶ plugin: snapshot(sourceNodeId)        → NodeSnapshot (serialisable tree)
  ├─▶ plugin: scan_design_system()           → DsIndex (cached 5 min; merged with the library index)
  │
  ├─  surface-engine.planTranspose(snapshot, { resolver: ds-sentinel.createResolver(ds) })
  │      → MutationPlan { root: clone(source), ops: [...] } + missing components
  │
  ├─▶ plugin: apply_plan(plan)               → { rootId, tags, warnings }  (chunked, progress events)
  └─  register decisions for missing components → returned to the agent
```

Every module follows the same shape: **snapshot → pure engine → plan → plugin executor**. Engines never import Figma types or do I/O, so they're covered by fast unit tests.

## Mutation plans

`packages/shared-types/src/plan.ts` defines the op language (validated with zod at the server boundary):

| Op | Purpose |
|---|---|
| `resize`, `setLayout`, `setSizing`, `setMinSize`, `setPosition`, `setConstraints` | Geometry and Auto-Layout |
| `setText` | Font size and family (with fallbacks), alignment, characters; fonts are loaded first |
| `reverseChildren`, `flipHorizontal`, `swapComponent` | RTL |
| `replaceWithInstance`, `insertInstance`, `swapComponent` | Design-system components (local id or library key) |
| `insertSpacer`, `insertPlaceholder`, `replaceWithPlaceholder`, `flag` | Safe areas and the missing-component protocol |
| `wrapChildren` | Moves children into a new Auto-Layout column (content column, split view) |
| `focusRing`, `removeShadows`, `bindVariable` | TV focus, M3 tonal elevation, token binding |
| `rename`, `remove`, `setPluginData` | Bookkeeping |

**Addressing.** `path` is a list of child indices from the plan root (`[]` is the root). The executor resolves *all* paths before the first op, so `reverseChildren([])` followed by `rename([0])` renames the layer that *was* first. Insert ops use the parent's children at the time they run (`-1` appends). A clone has the same tree shape as its source, so a plan computed from the source snapshot applies unchanged to the duplicate.

**Tags.** Insert ops can carry a `tag`. The executor returns `tag → nodeId`, which is how the server finds placeholders and flags to resolve later.

**Failure isolation.** Each op runs in its own try/catch. A failing op becomes a warning and the rest of the plan still applies. One `figma.commitUndo()` per plan means one undo step per tool call.

## Bridge protocol (v1)

JSON over WebSocket, validated with zod (`packages/shared-types/src/protocol.ts`).

```
plugin → bridge  { type: "register_plugin", protocolVersion: 1, pairingCode, fileName }
bridge → plugin  { type: "registered", pairingCode }
agent  → bridge  { type: "join", protocolVersion: 1, pairingCode }
bridge → agent   { type: "joined", pairingCode, fileName }
agent  → bridge  { type: "request", id, method, params }     # bridge rewrites id → plugin
plugin → bridge  { type: "progress", id, done, total }       # forwarded, resets agent idle timeout
plugin → bridge  { type: "response", id, result | error }    # forwarded with the agent's original id
bridge → *       { type: "peer_left", role } | { type: "error", code, message }
```

- **Rooms** are keyed by pairing code. Several agents can share one plugin. If the plugin reloads with the same code, waiting agents are re-attached automatically. In-flight requests fail with `plugin_disconnected`.
- **Heartbeat:** the bridge pings every 5s and terminates peers that miss a pong.
- **Origin policy:** only `null`, absent or `https://*.figma.com` origins can connect (see SECURITY.md).

## Plugin internals

- `src/ui.html`: owns the WebSocket, the pairing code (kept in `figma.clientStorage`) and reconnect with backoff. It relays requests to the sandbox and results back.
- `src/code.ts`: RPC dispatch.
- `src/snapshot.ts`: `NodeSnapshot` serialisation (async main-component lookup, bound variables, plugin data; budget of 5,000 nodes).
- `src/scan.ts`: local design-system index (resolves variable aliases).
- `src/apply.ts`: the plan executor (chunking, path pre-resolution, component cache, `importComponentByKeyAsync`).
- `src/render.ts`: flags, placeholders, synthesized components and handoff sections.
- `src/fonts.ts`: the font protocol.

## Testing strategy

| Layer | Test type |
|---|---|
| Engines | Pure unit tests on fixture snapshots (`packages/shared-types/test/fixtures.ts`) |
| Bridge | Real WebSockets on an ephemeral port: pairing, relay, progress, origin rejection, reconnect |
| MCP server | `Studio` against a fake gateway that validates every plan against the wire schema; MCP surface via an in-memory transport |
| End-to-end | Spawns `dist/index.js` over stdio, connects a fake plugin, pairs and runs a transpose |
| Plugin executor | Runs real engine plans on `test/fake-figma.ts`, a strict fake of the Plugin API (rejects FILL outside Auto-Layout, missing fonts, removed nodes, …) |

The fake Figma API is a model of Figma, not a replacement for it: behaviour verified there still needs a pass in the real desktop app (see the QA matrix in the PRD).
