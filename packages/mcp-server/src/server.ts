import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeRequestError, type BridgeClient } from "@figma-studio/bridge-server";
import { formatPairingCode, hexToRgba, PairingCodeSchema, SurfaceSchema, type NodeSnapshot } from "@figma-studio/shared-types";
import type { Studio } from "./studio.js";

export const VERSION = "0.1.0";

export const SERVER_INSTRUCTIONS = `figma-agent-studio drives the Figma canvas through a local plugin.

Workflow:
1. If any tool reports "not_paired", ask the designer to open the "Agent Studio (MCP bridge)" plugin in Figma and read you the 8-character pairing code, then call figma_connect.
2. Use figma_get_selection to find node ids (format "123:456").
3. High-level tools: figma_transpose_surface, figma_mirror_rtl, figma_audit_design_system, figma_generate_dev_handoff.
4. Missing design-system components are NEVER drawn as detached shapes. When a tool returns decisions, ask the designer which option to take (A synthesize from tokens / B adapt closest variant / C keep wireframe placeholder) and call figma_resolve_missing_component with their answer. Do not choose for them unless they told you to.
5. For RTL translation, figma_mirror_rtl returns the strings to translate; translate them yourself and call figma_apply_text.`;

function ok(summary: string, data?: unknown): CallToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): CallToolResult {
  const err = e as Error;
  const code = e instanceof BridgeRequestError ? ` [${e.code}]` : "";
  let hint = "";
  if (e instanceof BridgeRequestError && (e.code === "not_paired" || e.code === "unknown_code")) {
    hint = "\nAsk the designer for the pairing code shown in the Figma plugin window and call figma_connect.";
  } else if (e instanceof BridgeRequestError && (e.code === "bridge_disconnected" || e.code === "bridge_unreachable")) {
    hint = "\nThe local bridge restarts automatically within a few seconds — retry, then pair again with the code shown in the Figma plugin if asked.";
  } else if (e instanceof BridgeRequestError && e.code === "plugin_offline") {
    hint = "\nAsk the designer to re-open the plugin in Figma; the session resumes automatically.";
  }
  return { isError: true, content: [{ type: "text", text: `Error${code}: ${err.message ?? String(e)}${hint}` }] };
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

const nodeId = z.string().regex(/^(I?\d+[:;-]\d+)(;\d+:\d+)*$/, "Figma node ids look like 123:456").describe("Figma node ID, e.g. '123:456' (from figma_get_selection)");

function outline(n: NodeSnapshot, depth = 0, lines: string[] = [], max = 120): string[] {
  if (lines.length >= max) return lines;
  const layout = n.layoutMode && n.layoutMode !== "NONE" ? ` ${n.layoutMode.toLowerCase()}` : "";
  const text = n.type === "TEXT" ? ` "${(n.characters ?? "").slice(0, 40)}"` : "";
  const comp = n.component?.mainComponentName ? ` ⟶ ${n.component.componentSetName ? `${n.component.componentSetName}/` : ""}${n.component.mainComponentName}` : "";
  lines.push(`${"  ".repeat(depth)}- [${n.id}] ${n.type} "${n.name}" ${Math.round(n.width)}×${Math.round(n.height)}${layout}${comp}${text}`);
  (n.children ?? []).forEach((c) => outline(c, depth + 1, lines, max));
  if (n.truncatedChildren) lines.push(`${"  ".repeat(depth + 1)}… ${n.truncatedChildren} more (increase depth)`);
  return lines;
}

export function createServer(studio: Studio, client: BridgeClient, bridgeUrl: string): McpServer {
  const server = new McpServer({ name: "figma-agent-studio", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

  // ---------------------------------------------------------------- session
  server.registerTool(
    "figma_connect",
    {
      title: "Pair with the Figma plugin",
      description: "Pairs this agent with the open Figma plugin using the 8-character code the plugin displays (e.g. 'K7QM-2XPA'). Ask the designer for the code.",
      inputSchema: { pairingCode: z.string().describe("Code shown in the plugin window, with or without the dash") },
    },
    wrap(async ({ pairingCode }) => {
      const code = PairingCodeSchema.parse(pairingCode);
      const r = await client.pair(code);
      studio.decisions.clear();
      return ok(`Paired with Figma plugin ${formatPairingCode(code)}${r.fileName ? ` in file "${r.fileName}"` : ""}.`);
    }),
  );

  server.registerTool(
    "figma_status",
    { title: "Connection status", description: "Shows whether the local bridge and Figma plugin are connected.", inputSchema: {}, annotations: { readOnlyHint: true } },
    wrap(async () =>
      ok("Status", { bridge: bridgeUrl, bridgeConnected: client.connected, paired: client.paired, pluginOnline: client.pluginOnline, fileName: client.fileName, pendingDecisions: [...studio.decisions.keys()] }),
    ),
  );

  // ---------------------------------------------------------------- read
  server.registerTool(
    "figma_get_selection",
    { title: "Get selection", description: "Returns the layers currently selected in Figma (ids, names, sizes) plus file and page names.", inputSchema: {}, annotations: { readOnlyHint: true } },
    wrap(async () => {
      const info = await client.request("get_document_info", {});
      return ok(info.selection.length ? `${info.selection.length} layer(s) selected on page "${info.pageName}".` : `Nothing selected on page "${info.pageName}". Ask the designer to select a frame.`, info);
    }),
  );

  server.registerTool(
    "figma_get_node",
    {
      title: "Inspect a node",
      description: "Returns a layer tree outline (ids, types, sizes, Auto-Layout, component links, text). Set raw=true for the full JSON snapshot.",
      inputSchema: { nodeId, depth: z.number().int().min(0).max(50).default(3), raw: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ nodeId, depth, raw }) => {
      const snap = await client.request("snapshot", { nodeId, depth });
      return raw ? ok(`Snapshot of "${snap.name}"`, snap) : ok(outline(snap).join("\n"));
    }),
  );

  server.registerTool(
    "figma_scan_design_system",
    {
      title: "Scan design system",
      description: "Indexes the file's components, variables and paint styles (plus team-library components when FIGMA_ACCESS_TOKEN and FIGMA_LIBRARY_FILE_KEYS are set). Cached for 5 minutes.",
      inputSchema: { refresh: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ refresh }) => {
      const ds = await studio.designSystem(refresh);
      const local = ds.components.filter((c) => c.source === "local").length;
      return ok(`Design system: ${ds.components.length} components (${local} local, ${ds.components.length - local} library), ${ds.variables.length} variables, ${ds.paintStyles.length} paint styles.`, {
        sampleComponents: ds.components.slice(0, 40).map((c) => (c.componentSetName ? `${c.componentSetName} / ${c.name}` : c.name)),
        sampleVariables: ds.variables.slice(0, 40).map((v) => `${v.name} (${v.resolvedType})`),
      });
    }),
  );

  // ---------------------------------------------------------------- raw mutations
  const rgba = z.string().regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/).describe("Hex color, e.g. #1E293B");
  server.registerTool(
    "figma_create_frame",
    {
      title: "Create frame",
      description: "Low-level: creates an empty frame. Prefer high-level tools and design-system components.",
      inputSchema: { name: z.string(), width: z.number().positive(), height: z.number().positive(), x: z.number().optional(), y: z.number().optional(), parentId: nodeId.optional(), fill: rgba.optional() },
    },
    wrap(async ({ fill, ...p }) => ok("Frame created", await client.request("create_frame", { ...p, fill: fill ? hexToRgba(fill) : undefined }))),
  );

  server.registerTool(
    "figma_set_fills",
    {
      title: "Set fill",
      description: "Low-level: sets a single solid fill. Pass variableId to bind a color variable (preferred over raw hex).",
      inputSchema: { nodeId, color: rgba.optional(), variableId: z.string().optional() },
    },
    wrap(async ({ nodeId, color, variableId }) => ok("Fill set", await client.request("set_fills", { nodeId, color: color ? hexToRgba(color) : undefined, variableId }))),
  );

  server.registerTool(
    "figma_set_auto_layout",
    {
      title: "Set Auto-Layout",
      description: "Low-level: sets Auto-Layout direction, spacing, padding and alignment on a frame.",
      inputSchema: {
        nodeId,
        layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]),
        itemSpacing: z.number().optional(),
        padding: z.object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() }).optional(),
        primaryAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
        counterAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
        layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
      },
    },
    wrap(async (p) => ok("Auto-Layout set", await client.request("set_auto_layout", p))),
  );

  // ---------------------------------------------------------------- Module 1
  server.registerTool(
    "figma_transpose_surface",
    {
      title: "Transpose to device surfaces",
      description:
        "Transposes a source frame (typically 1440px desktop) into iOS (393pt), Android M3 (412dp), Smart TV 10-foot (1920×1080) and/or Tablet (834pt) frames: reflows Auto-Layout, wraps grids, injects safe areas and swaps navigation to design-system components. Missing components produce decisions you must ask the designer about.",
      inputSchema: {
        sourceNodeId: nodeId,
        targetSurfaces: z.array(SurfaceSchema).min(1).describe("ios | android_m3 | smart_tv_10ft | tablet"),
        enforceDesignSystem: z.boolean().default(true).describe("Flag missing DS components and ask instead of improvising"),
        placeBesideSource: z.boolean().default(true),
        androidNavigation: z.enum(["three_button", "gesture"]).optional(),
        tvOverscan: z.object({ horizontal: z.number().min(0), vertical: z.number().min(0) }).optional().describe("Default 80px on every edge"),
      },
    },
    wrap(async ({ sourceNodeId, targetSurfaces, enforceDesignSystem, placeBesideSource, androidNavigation, tvOverscan }) => {
      const results = await studio.transpose({ sourceNodeId, targetSurfaces, enforceDesignSystem, placeBesideSource, overrides: { androidNavigation, tvOverscan } });
      const decisions = results.flatMap((r) => r.decisions);
      const lines = results.map((r) => `• ${r.label} → frame ${r.frameId} (${r.opsApplied} ops, ${r.usedComponents.length} DS components${r.decisions.length ? `, ${r.decisions.length} missing` : ""})`);
      let summary = `Created ${results.length} frame(s):\n${lines.join("\n")}`;
      if (decisions.length) {
        summary +=
          `\n\nACTION REQUIRED — ${decisions.length} design-system component(s) are missing and were flagged in fuchsia on the canvas. ` +
          `Ask the designer, for each one, which option to use, then call figma_resolve_missing_component:\n` +
          decisions
            .map(
              (d) =>
                `- ${d.decisionId}: "${d.label}" for ${d.surface}. Options: A) synthesize a new master component from tokens, ` +
                `B) adapt closest variant${d.candidates[0] ? ` ("${d.candidates[0].name}")` : " (none available)"}, C) keep a wireframe placeholder.`,
            )
            .join("\n");
      }
      return ok(summary, { status: decisions.length ? "needs_decision" : "done", results });
    }),
  );

  server.registerTool(
    "figma_resolve_missing_component",
    {
      title: "Resolve a missing component",
      description: "Applies the designer's choice for a missing design-system component flagged by figma_transpose_surface.",
      inputSchema: {
        decisionId: z.string(),
        choice: z.enum(["synthesize", "variant_fallback", "placeholder"]).describe("A = synthesize, B = variant_fallback, C = placeholder"),
        candidateIndex: z.number().int().min(0).default(0).describe("Which candidate to use for variant_fallback"),
      },
    },
    wrap(async ({ decisionId, choice, candidateIndex }) => {
      const r = await studio.resolveDecision(decisionId, choice, candidateIndex);
      return ok(r.outcome, { remainingDecisions: r.remainingDecisions });
    }),
  );

  // ---------------------------------------------------------------- Module 3
  server.registerTool(
    "figma_mirror_rtl",
    {
      title: "Mirror to RTL",
      description:
        "Zero-loss Right-to-Left mirroring: reverses horizontal Auto-Layout, swaps padding, flips text alignment and directional icons, mirrors absolute positions, and shields phone numbers, URLs, numbers and code. With targetLanguage it also returns the strings for you to translate.",
      inputSchema: {
        nodeId,
        targetLanguage: z.enum(["ar", "he", "none"]).default("none"),
        swapDirectionalIcons: z.boolean().default(true),
        createDuplicate: z.boolean().default(true).describe("Keep the LTR original and mirror a clone"),
      },
    },
    wrap(async (args) => {
      const r = await studio.mirrorRtl(args);
      const s = r.stats;
      let summary =
        `Mirrored to RTL → frame ${r.frameId}: ${s.reversedContainers} rows reversed, ${s.alignmentFlips} alignments flipped, ${s.paddingSwaps} paddings swapped, ` +
        `${s.textAlignmentFlips} text alignments flipped, ${s.iconsFlipped + s.iconsSwapped} icons mirrored, ${s.mirroredPositions} absolute layers repositioned, ` +
        `${s.shieldedTexts + s.shieldedContainers} layers shielded.`;
      if (r.toTranslate.length) {
        summary += `\n\nNEXT STEP: translate the ${r.toTranslate.length} strings below into ${args.targetLanguage === "ar" ? "Arabic" : "Hebrew"} (natural UI copy, keep placeholders/numbers), then call figma_apply_text with [{nodeId, characters}].`;
      }
      return ok(summary, { warnings: r.warnings, shielded: r.shielded, toTranslate: r.toTranslate });
    }),
  );

  server.registerTool(
    "figma_apply_text",
    {
      title: "Write text",
      description: "Writes text into text layers (fonts are loaded first; missing fonts fall back to Inter). Used after translating figma_mirror_rtl output.",
      inputSchema: { updates: z.array(z.object({ nodeId, characters: z.string() })).min(1) },
    },
    wrap(async ({ updates }) => {
      const r = await studio.applyText(updates);
      return ok(`Updated ${r.updated}/${updates.length} text layers.`, r.warnings.length ? { warnings: r.warnings } : undefined);
    }),
  );

  // ---------------------------------------------------------------- Module 2
  server.registerTool(
    "figma_audit_design_system",
    {
      title: "Audit against the design system",
      description: "Audits a frame for detached components, hardcoded colors that match variables, off-palette colors, off-grid spacing, unbound spacing tokens and WCAG AA text contrast. autoFixSafeTokens binds identical values to their variables.",
      inputSchema: { nodeId, autoFixSafeTokens: z.boolean().default(false) },
    },
    wrap(async (args) => {
      const { report, fixed, fixWarnings } = await studio.audit(args);
      const c = report.counts;
      const summary =
        `DS health score ${report.score}/100 for "${report.nodeName}" (${report.scannedNodes} layers). ` +
        `Detached: ${c.detached_component}, hardcoded colors: ${c.hardcoded_color}, off-palette: ${c.off_palette_color}, off-grid spacing: ${c.off_grid_spacing}, ` +
        `unbound spacing: ${c.unbound_spacing}, contrast failures: ${c.contrast}.` +
        (args.autoFixSafeTokens ? ` Auto-fixed ${fixed} binding(s).` : report.fixPlan ? ` ${report.fixPlan.ops.length} safe fix(es) available — rerun with autoFixSafeTokens=true.` : "");
      return ok(summary, { findings: report.findings.slice(0, 100).map(({ fix: _fix, ...f }) => f), fixWarnings });
    }),
  );

  // ---------------------------------------------------------------- Module 4
  server.registerTool(
    "figma_generate_dev_handoff",
    {
      title: "Generate dev handoff",
      description: "Creates a [HANDOFF] section next to the frame with a token ledger (CSS / Tailwind v4 / native), responsive constraint notes and a code scaffold for the target stack. Also returns the handoff as Markdown.",
      inputSchema: {
        nodeId,
        targetStack: z.enum(["react_tailwind", "swiftui", "jetpack_compose", "react_native"]),
        renderOnCanvas: z.boolean().default(true),
      },
    },
    wrap(async (args) => {
      const r = await studio.handoff(args);
      return ok(r.sectionId ? `Handoff section ${r.sectionId} created with ${r.tokens} ledger rows.\n\n${r.markdown}` : r.markdown);
    }),
  );

  return server;
}
