import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeRequestError } from "@figma-studio/bridge-server";
import { formatPairingCode, hexToRgba, PairingCodeSchema, SURFACE_LABELS, SurfaceSchema } from "@figma-studio/shared-types";
import { auditText, groupWarnings, outline, section, type Detail } from "./format.js";
import { registerPrompts } from "./prompts.js";
import type { FigmaGateway, Studio } from "./studio.js";

export const VERSION = "0.3.0";

/** The live plugin connection (BridgeClient in production). */
export interface Connection extends FigmaGateway {
  pair(code: string): Promise<{ fileName?: string }>;
  readonly connected: boolean;
  paired: boolean;
  pluginOnline: boolean;
  fileName: string | undefined;
}

/**
 * "core" keeps the tool list small (tool definitions are re-sent on every turn); "full" adds the
 * design-system scan and low-level primitives for custom canvas edits.
 */
export type Toolset = "core" | "full";

export const SERVER_INSTRUCTIONS = `Figma DesignOps tools. Each tool does a whole job server-side and applies it to the canvas in one call, so don't rebuild layouts with many small edits.

- Layer ids look like "123:456". Omit nodeId to act on the designer's current selection.
- On "not paired": ask the designer for the 8-character code in the Agent Studio plugin window, then call figma_connect.
- Never improvise UI for a missing design-system component. Relay each decision to the designer verbatim and call figma_resolve_missing_component with their choice.
- Results default to detail="concise". Ask for "detailed" only when you need every item.
- figma_preview shows a frame as an image (it costs tokens, so use it to verify doubtful results). figma_undo removes what this session created.`;

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): CallToolResult {
  const err = e as Error;
  const code = e instanceof BridgeRequestError ? e.code : "";
  const hints: Record<string, string> = {
    not_paired: "Ask the designer for the pairing code shown in the Agent Studio plugin window, then call figma_connect.",
    unknown_code: "That code isn't open in any plugin window. Ask the designer to read the code again (8 characters, e.g. K7QM-2XPA).",
    bridge_disconnected: "The local bridge restarts automatically within a few seconds. Retry, and pair again with figma_connect if asked.",
    bridge_unreachable: "The local bridge restarts automatically within a few seconds. Retry, and pair again with figma_connect if asked.",
    plugin_offline: "Ask the designer to re-open the Agent Studio plugin in the same file; pairing resumes automatically.",
    timeout: "Figma is busy or the plugin window was closed. Ask the designer to keep the plugin open, then retry.",
  };
  const hint = hints[code] ? `\n${hints[code]}` : "";
  return { isError: true, content: [{ type: "text", text: `Error${code ? ` [${code}]` : ""}: ${err.message ?? String(e)}${hint}` }] };
}

const wrap =
  <A>(fn: (args: A) => Promise<CallToolResult>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };

// Id format is checked by the plugin (with an actionable error) instead of a regex repeated in every schema.
const layerId = z.string();
const target = layerId.optional().describe("Layer id; omit = current selection");
const detail = z.enum(["concise", "detailed"]).default("concise");

export function createServer(studio: Studio, conn: Connection, bridgeUrl: string, toolset: Toolset = "core"): McpServer {
  const server = new McpServer({ name: "figma-agent-studio", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

  // ------------------------------------------------------------------ session
  server.registerTool(
    "figma_connect",
    {
      title: "Connect to Figma",
      description:
        "Pairs with the Agent Studio plugin using the code it displays, or reports connection status when called without a code. Call this when another tool says the session isn't paired.",
      inputSchema: { pairingCode: z.string().optional().describe('Code from the plugin window, e.g. "K7QM-2XPA"') },
    },
    wrap(async ({ pairingCode }) => {
      if (!pairingCode) {
        const pending = [...studio.decisions.keys()];
        return ok(
          `Bridge ${bridgeUrl}: ${conn.connected ? "up" : "down"} · ${conn.paired ? `paired${conn.fileName ? ` with "${conn.fileName}"` : ""}` : "not paired"} · plugin ${conn.pluginOnline ? "online" : "offline"}` +
            (pending.length ? ` · pending decisions: ${pending.join(", ")}` : ""),
        );
      }
      const code = PairingCodeSchema.parse(pairingCode);
      const r = await conn.pair(code);
      studio.decisions.clear();
      return ok(`Paired with ${formatPairingCode(code)}${r.fileName ? ` in "${r.fileName}"` : ""}.`);
    }),
  );

  server.registerTool(
    "figma_inspect",
    {
      title: "Inspect layers",
      description:
        "Returns a compact layer outline: one line per layer with id, type, name, size, Auto-Layout, linked component and text. Without nodeId it describes the current selection. Use it to find ids or to understand structure before acting.",
      inputSchema: {
        nodeId: target,
        depth: z.number().int().min(0).max(20).default(3).describe("Levels below the layer (default 3)"),
        maxLines: z.number().int().min(10).max(400).default(80),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ nodeId, depth, maxLines }) => {
      if (nodeId) nodeId = await studio.target(nodeId);
      if (!nodeId) {
        const info = await conn.request("get_document_info", {});
        if (info.selection.length !== 1) {
          const list = info.selection.map((n) => `${n.id} ${n.type} "${n.name}" ${Math.round(n.width ?? 0)}×${Math.round(n.height ?? 0)}`);
          return ok(`File "${info.fileName}", page "${info.pageName}": ${info.selection.length ? `${info.selection.length} layers selected` : "nothing selected; ask the designer to select a frame"}.${section("", list)}`);
        }
        nodeId = info.selection[0]!.id;
      }
      return ok(outline(await conn.request("snapshot", { nodeId, depth }), maxLines));
    }),
  );

  // ------------------------------------------------------------------ Module 1
  server.registerTool(
    "figma_transpose_surface",
    {
      title: "Adapt a screen to other devices",
      description:
        "Clones a desktop/web frame into platform-accurate frames for iOS (393pt), Android Material 3 (412dp), Smart TV 10-foot (1920×1080) and/or Tablet (834pt). It reflows Auto-Layout, wraps grids, scales type, adds safe areas and swaps navigation to design-system components, all in one call. Missing components come back as decisions to put to the designer.",
      inputSchema: {
        sourceNodeId: target,
        targetSurfaces: z.array(SurfaceSchema).min(1),
        enforceDesignSystem: z.boolean().default(true).describe("false = use the closest variant instead of asking"),
        placeBesideSource: z.boolean().default(true),
        androidNavigation: z.enum(["three_button", "gesture"]).optional(),
        tvOverscan: z.object({ horizontal: z.number().min(0), vertical: z.number().min(0) }).optional().describe("Default 80px every edge"),
        detail,
      },
    },
    wrap(async ({ sourceNodeId, targetSurfaces, enforceDesignSystem, placeBesideSource, androidNavigation, tvOverscan, detail }) => {
      const { source, results } = await studio.transpose({ sourceNodeId, targetSurfaces, enforceDesignSystem, placeBesideSource, overrides: { androidNavigation, tvOverscan } });
      const full = detail === "detailed";
      const frames = results.map((r) => {
        const used = full && r.usedComponents.length ? ` · uses ${r.usedComponents.map((u) => u.name).join(", ")}` : ` · ${r.usedComponents.length} DS components`;
        return `${r.label} → ${r.frameId}${used}${r.decisions.length ? ` · ${r.decisions.length} missing` : ""}`;
      });
      const warnings = results.flatMap((r) => r.warnings.map((text) => ({ text, scope: SURFACE_LABELS[r.surface] })));
      const decisions = results.flatMap((r) => r.decisions);
      const asks = decisions.map((d) => {
        const alts = d.candidates.slice(0, full ? 3 : 1).map((c, i) => `${full ? `[${i}] ` : ""}"${c.name}"`);
        return `${d.decisionId} · ${SURFACE_LABELS[d.surface]} "${d.label}": A) synthesize from tokens  B) adapt ${alts.length ? alts.join(" / ") : "(no close variant)"}  C) wireframe placeholder`;
      });
      return ok(
        `Adapted "${source.name}" (${source.id}) to ${results.length} surface(s).` +
          section("Frames", frames) +
          section("Warnings", full ? warnings.map((w) => `${w.scope}: ${w.text}`) : groupWarnings(warnings)) +
          (asks.length ? section(`DECISIONS NEEDED: ask the designer, then call figma_resolve_missing_component(decisionId, choice)`, asks) : ""),
      );
    }),
  );

  server.registerTool(
    "figma_resolve_missing_component",
    {
      title: "Apply the designer's decision",
      description:
        "Applies the designer's answer for a missing design-system component reported by figma_transpose_surface. A=synthesize a token-bound master component, B=variant_fallback (closest existing variant), C=placeholder (named wireframe). Only call it with the designer's own choice.",
      inputSchema: {
        decisionId: z.string(),
        choice: z.enum(["synthesize", "variant_fallback", "placeholder"]),
        candidateIndex: z.number().int().min(0).default(0).describe("Variant to use for variant_fallback"),
      },
    },
    wrap(async ({ decisionId, choice, candidateIndex }) => {
      const r = await studio.resolveDecision(decisionId, choice, candidateIndex);
      return ok(`${r.outcome}${r.remainingDecisions.length ? `\nStill pending: ${r.remainingDecisions.join(", ")}` : "\nNo decisions pending."}`);
    }),
  );

  // ------------------------------------------------------------------ Module 3
  server.registerTool(
    "figma_mirror_rtl",
    {
      title: "Mirror a screen to RTL",
      description:
        "Creates a Right-to-Left version of a frame. It reverses rows and flips their alignment, swaps padding, inverts text alignment, mirrors directional icons and absolute layers, and keeps phone numbers, URLs, numbers and code LTR. With targetLanguage it returns the strings to translate as `id|text` lines; translate them and send them back with figma_apply_text.",
      inputSchema: {
        nodeId: target,
        targetLanguage: z.enum(["ar", "he", "none"]).default("none"),
        swapDirectionalIcons: z.boolean().default(true),
        createDuplicate: z.boolean().default(true).describe("false = mirror in place"),
        detail,
      },
    },
    wrap(async ({ detail, ...args }) => {
      const r = await studio.mirrorRtl(args);
      const s = r.stats;
      const stats = [
        s.reversedContainers && `${s.reversedContainers} rows reversed`,
        s.alignmentFlips && `${s.alignmentFlips} alignments flipped`,
        s.paddingSwaps && `${s.paddingSwaps} paddings swapped`,
        s.textAlignmentFlips && `${s.textAlignmentFlips} text alignments`,
        s.iconsFlipped + s.iconsSwapped && `${s.iconsFlipped + s.iconsSwapped} icons mirrored`,
        s.mirroredPositions && `${s.mirroredPositions} absolute layers`,
        s.shieldedTexts + s.shieldedContainers && `${s.shieldedTexts + s.shieldedContainers} kept LTR`,
      ].filter(Boolean);
      const shielded = detail === "detailed" ? section("Kept LTR", r.shielded.map((x) => `"${x.name}" (${x.reason})`)) : "";
      const lang = args.targetLanguage === "ar" ? "Arabic" : "Hebrew";
      const translate = r.toTranslate.length
        ? `\n\nTRANSLATE to natural ${lang} UI copy (keep numbers/placeholders), then call figma_apply_text with {nodeId, characters} per line:\n` +
          r.toTranslate.map((t) => `${t.nodeId}|${t.characters.replace(/\n/g, "\\n")}`).join("\n")
        : "";
      return ok(`RTL frame ${r.frameId}: ${stats.join(", ") || "nothing to mirror"}.${section("Warnings", detail === "detailed" ? r.warnings : groupWarnings(r.warnings))}${shielded}${translate}`);
    }),
  );

  server.registerTool(
    "figma_apply_text",
    {
      title: "Write text layers",
      description: "Writes new text into text layers in one batch (fonts load first; missing fonts fall back to Inter). Use it to apply translations from figma_mirror_rtl.",
      inputSchema: { updates: z.array(z.object({ nodeId: layerId, characters: z.string() })).min(1).max(2000) },
    },
    wrap(async ({ updates }) => {
      const r = await studio.applyText(updates);
      return ok(`Updated ${r.updated}/${updates.length} text layers.${section("Warnings", groupWarnings(r.warnings))}`);
    }),
  );

  // ------------------------------------------------------------------ Module 2
  server.registerTool(
    "figma_audit_design_system",
    {
      title: "Audit against the design system",
      description:
        "Scores a frame (0-100) against the file's design system. It flags detached components, hardcoded colors that match a variable, off-palette colors, off-grid spacing, unbound spacing tokens and WCAG AA text contrast. autoFixSafeTokens=true binds exact-match values to their variables; nothing else is changed.",
      inputSchema: { nodeId: target, autoFixSafeTokens: z.boolean().default(false), detail },
    },
    wrap(async ({ detail, ...args }) => {
      const { report, fixed, fixWarnings } = await studio.audit(args);
      return ok(auditText(report, detail as Detail, args.autoFixSafeTokens ? fixed : null) + section("Fix warnings", groupWarnings(fixWarnings)));
    }),
  );

  // ------------------------------------------------------------------ Module 4
  server.registerTool(
    "figma_generate_dev_handoff",
    {
      title: "Generate developer handoff",
      description:
        'Adds a "[HANDOFF] <screen> - <platform>" section under the frame. It contains a token ledger (CSS var, Tailwind v4, native), responsive notes and a code scaffold for the chosen stack. detail="detailed" also returns the full handoff as Markdown (ledger plus code) for use outside Figma.',
      inputSchema: {
        nodeId: target,
        targetStack: z.enum(["react_tailwind", "swiftui", "jetpack_compose", "react_native"]),
        renderOnCanvas: z.boolean().default(true),
        detail,
      },
    },
    wrap(async ({ detail, ...args }) => {
      const r = await studio.handoff(args);
      const head = r.sectionId
        ? `Created ${r.title} (${r.sectionId}): ${r.tokens} ledger rows, ${r.notes} responsive notes, ${r.codeLines}-line ${r.language} scaffold.`
        : `${r.title}: ${r.tokens} ledger rows, ${r.notes} notes.`;
      return ok(detail === "detailed" || !r.sectionId ? `${head}\n\n${r.markdown}` : head);
    }),
  );

  // ------------------------------------------------------------------ verify & undo
  server.registerTool(
    "figma_preview",
    {
      title: "See a frame",
      description:
        "Returns a PNG of a frame so you can check the result visually (overflow, clipped text, wrong order). It costs roughly (width×height)/750 tokens, so use it sparingly: one frame at a time, and only when a layout result looks doubtful.",
      inputSchema: { nodeId: target, maxSize: z.number().int().min(256).max(1536).default(768).describe("Longest side in px") },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ nodeId, maxSize }) => {
      const img = await studio.preview(nodeId, maxSize);
      return { content: [{ type: "text", text: `"${img.name}" at ${img.width}×${img.height}px` }, { type: "image", data: img.base64, mimeType: "image/png" }] };
    }),
  );

  server.registerTool(
    "figma_undo",
    {
      title: "Undo agent changes",
      description:
        'Removes what this session created: frames, flags, handoff sections and synthesized components. scope="last" (default) undoes the latest operation; "session" undoes everything. In-place edits such as token bindings or rewritten text are listed for the designer to undo with Cmd/Ctrl+Z.',
      inputSchema: { scope: z.enum(["last", "session"]).default("last") },
    },
    wrap(async ({ scope }) => {
      const r = await studio.undo(scope);
      if (!r.undone.length) return ok("Nothing to undo in this session.");
      const manual = r.manual.length ? section("Needs Cmd/Ctrl+Z in Figma (edited existing layers)", r.manual) : "";
      return ok(`Undid ${r.undone.length} operation(s), removed ${r.removed} layer(s).${section("Undone", r.undone)}${manual}`);
    }),
  );

  if (toolset === "full") registerFullTools(server, studio, conn);
  registerPrompts(server);
  return server;
}

/** Optional tools: design-system listing and low-level primitives for custom edits. */
function registerFullTools(server: McpServer, studio: Studio, conn: Connection): void {
  server.registerTool(
    "figma_scan_design_system",
    {
      title: "List the design system",
      description: "Lists the components and variables the engines can use: local ones, plus team-library components when FIGMA_ACCESS_TOKEN and FIGMA_LIBRARY_FILE_KEYS are set. The result is cached for 5 minutes.",
      inputSchema: { refresh: z.boolean().default(false), query: z.string().optional().describe("Filter names (case-insensitive)"), limit: z.number().int().min(1).max(500).default(40) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ refresh, query, limit }) => {
      const ds = await studio.designSystem(refresh);
      const q = query?.toLowerCase();
      const comps = ds.components.map((c) => (c.componentSetName ? `${c.componentSetName} / ${c.name}` : c.name)).filter((n) => !q || n.toLowerCase().includes(q));
      const vars = ds.variables.map((v) => `${v.name} (${v.resolvedType.toLowerCase()})`).filter((n) => !q || n.toLowerCase().includes(q));
      const more = (all: string[]) => (all.length > limit ? [`…${all.length - limit} more (narrow with query)`] : []);
      return ok(
        `${ds.components.length} components, ${ds.variables.length} variables, ${ds.paintStyles.length} paint styles${q ? ` · filter "${query}"` : ""}.` +
          section(`Components (${comps.length})`, [...comps.slice(0, limit), ...more(comps)]) +
          section(`Variables (${vars.length})`, [...vars.slice(0, limit), ...more(vars)]),
      );
    }),
  );

  const hex = z.string().regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/).describe("Hex, e.g. #1E293B");
  server.registerTool(
    "figma_create_frame",
    {
      title: "Create frame (low-level)",
      description: "Creates an empty frame. Prefer the high-level tools and design-system components.",
      inputSchema: { name: z.string(), width: z.number().positive(), height: z.number().positive(), x: z.number().optional(), y: z.number().optional(), parentId: layerId.optional(), fill: hex.optional() },
    },
    wrap(async ({ fill, ...p }) => {
      const n = await conn.request("create_frame", { ...p, fill: fill ? hexToRgba(fill) : undefined });
      return ok(`Created ${n.id} "${n.name}".`);
    }),
  );

  server.registerTool(
    "figma_set_fills",
    {
      title: "Set fill (low-level)",
      description: "Sets one solid fill. Pass variableId to bind a color variable (preferred over a raw hex value).",
      inputSchema: { nodeId: layerId, color: hex.optional(), variableId: z.string().optional() },
    },
    wrap(async ({ nodeId, color, variableId }) => {
      const n = await conn.request("set_fills", { nodeId, color: color ? hexToRgba(color) : undefined, variableId });
      return ok(`Fill set on ${n.id}.`);
    }),
  );

  server.registerTool(
    "figma_set_auto_layout",
    {
      title: "Set Auto-Layout (low-level)",
      description: "Sets a frame's Auto-Layout direction, gap, padding, alignment and wrap.",
      inputSchema: {
        nodeId: layerId,
        layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]),
        itemSpacing: z.number().optional(),
        padding: z.object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() }).optional(),
        primaryAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
        counterAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
        layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
      },
    },
    wrap(async (p) => {
      const n = await conn.request("set_auto_layout", p);
      return ok(`Auto-Layout set on ${n.id}.`);
    }),
  );
}
