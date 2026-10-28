import { randomBytes } from "node:crypto";
import type { RequestOptions } from "@figma-studio/bridge-server";
import { buildHandoff, handoffToMarkdown, type TargetStack } from "@figma-studio/devspec";
import { auditDesignSystem, createMirrorFinder, createResolver, fetchLibraryComponents, mergeIndexes, type AuditReport } from "@figma-studio/ds-sentinel";
import { planRtl, translatableTexts, type RtlLanguage, type RtlStats } from "@figma-studio/rtl-engine";
import {
  SURFACE_LABELS,
  type ApplyPlanResult,
  type ComponentCandidate,
  type ComponentRole,
  type DsComponent,
  type DsIndex,
  type DsVariable,
  type MutationPlan,
  type PluginMethod,
  type PluginParams,
  type PluginResult,
  type Rgba,
  type Surface,
  type SynthesizeSpec,
} from "@figma-studio/shared-types";
import { planTranspose, type SurfaceOverrides } from "@figma-studio/surface-engine";

/** Anything that can execute plugin methods — the bridge client in production, a fake in tests. */
export interface FigmaGateway {
  request<M extends PluginMethod>(method: M, params: PluginParams<M>, options?: RequestOptions): Promise<PluginResult<M>>;
}

export interface StudioConfig {
  figmaToken?: string;
  libraryFileKeys?: string[];
  /** DS index cache lifetime (ms). */
  dsCacheMs?: number;
  log?: (msg: string) => void;
}

export type DecisionChoice = "synthesize" | "variant_fallback" | "placeholder";

export interface PendingDecision {
  decisionId: string;
  surface: Surface;
  role: ComponentRole;
  label: string;
  rootId: string;
  placeholderId?: string;
  flagId?: string;
  width?: number;
  height: number;
  candidates: ComponentCandidate[];
}

const PLAN_TIMEOUT = { timeoutMs: 120_000 };

const TAXONOMY: Record<ComponentRole, string> = {
  nav_top: "Navigation/Bar/Top",
  nav_bottom: "Navigation/Bar/Bottom",
  tab_bar_top: "Navigation/Tabs/Top",
  sidebar: "Navigation/Sidebar",
  status_bar: "System/StatusBar",
  home_indicator: "System/HomeIndicator",
  button: "Actions/Button",
  card: "Containers/Card",
};

const PLATFORM_SUFFIX: Record<Surface, string> = { ios: "iOS", android_m3: "Android", smart_tv_10ft: "TV", tablet: "Tablet" };

const WIDTH: Record<Surface, number> = { ios: 393, android_m3: 412, smart_tv_10ft: 1760, tablet: 834 };

export class Studio {
  private dsIndex: DsIndex | null = null;
  private dsIndexAt = 0;
  private libraryComponents: DsComponent[] | null = null;
  readonly decisions = new Map<string, PendingDecision>();

  constructor(
    private readonly figma: FigmaGateway,
    private readonly config: StudioConfig = {},
  ) {}

  // -------------------------------------------------------------------------
  // Design-system index
  // -------------------------------------------------------------------------

  async designSystem(refresh = false): Promise<DsIndex> {
    const fresh = Date.now() - this.dsIndexAt < (this.config.dsCacheMs ?? 5 * 60_000);
    if (this.dsIndex && fresh && !refresh) return this.dsIndex;
    const local = await this.figma.request("scan_design_system", {}, { timeoutMs: 120_000 });
    let merged = local;
    if (this.config.figmaToken && this.config.libraryFileKeys?.length) {
      if (!this.libraryComponents || refresh) {
        try {
          this.libraryComponents = await fetchLibraryComponents({ token: this.config.figmaToken, fileKeys: this.config.libraryFileKeys });
        } catch (e) {
          this.config.log?.(`library index failed: ${(e as Error).message}`);
          this.libraryComponents = [];
        }
      }
      merged = mergeIndexes(local, this.libraryComponents);
    }
    this.dsIndex = merged;
    this.dsIndexAt = Date.now();
    return merged;
  }

  private remember(component: DsComponent): void {
    this.dsIndex?.components.push(component);
  }

  /**
   * Resolves the layer a tool acts on: an explicit id, or the single selected layer. Saves the agent
   * a separate selection round-trip on every call.
   */
  async target(nodeId?: string): Promise<string> {
    if (nodeId) {
      if (!/^I?\d+[:;-]\d+(;\d+:\d+)*$/.test(nodeId)) throw new Error(`"${nodeId}" isn't a Figma layer id. Ids look like "123:456"; get them from figma_inspect, or omit nodeId to use the selection.`);
      return nodeId.replace("-", ":");
    }
    const sel = await this.figma.request("get_selection", {});
    if (sel.length === 1) return sel[0]!.id;
    if (sel.length === 0) throw new Error("Nothing is selected in Figma. Ask the designer to select one frame, or pass nodeId.");
    throw new Error(
      `${sel.length} layers are selected; pass nodeId for one of them: ${sel
        .slice(0, 8)
        .map((n) => `${n.id} "${n.name}"`)
        .join(", ")}${sel.length > 8 ? ", …" : ""}.`,
    );
  }

  private apply(plan: MutationPlan): Promise<ApplyPlanResult> {
    return this.figma.request("apply_plan", plan, PLAN_TIMEOUT);
  }

  // -------------------------------------------------------------------------
  // Module 1: SurfaceMatrix
  // -------------------------------------------------------------------------

  async transpose(input: {
    sourceNodeId?: string;
    targetSurfaces: Surface[];
    enforceDesignSystem?: boolean;
    placeBesideSource?: boolean;
    overrides?: SurfaceOverrides;
  }) {
    const sourceNodeId = await this.target(input.sourceNodeId);
    const [source, ds] = await Promise.all([this.figma.request("snapshot", { nodeId: sourceNodeId }, { timeoutMs: 60_000 }), this.designSystem()]);
    const resolver = createResolver(ds);
    const surfaceContainer = findVariable(ds, "COLOR", /surface[\s/_-]*container/i);
    const results = [];
    for (const [slot, surface] of input.targetSurfaces.entries()) {
      const t = planTranspose(source, {
        surface,
        resolver,
        enforceDesignSystem: input.enforceDesignSystem ?? true,
        placeBesideSource: input.placeBesideSource ?? true,
        slot,
        overrides: input.overrides,
        tokens: { surfaceContainerVariableId: surfaceContainer?.id },
      });
      const applied = await this.apply(t.plan);
      const decisions = t.missing.map((m) => {
        const d: PendingDecision = {
          decisionId: `dec_${randomBytes(4).toString("hex")}`,
          surface,
          role: m.role,
          label: m.label,
          rootId: applied.rootId,
          placeholderId: applied.tags[m.placeholderTag],
          flagId: applied.tags[m.flagTag],
          width: m.width,
          height: m.height,
          candidates: m.candidates,
        };
        this.decisions.set(d.decisionId, d);
        return d;
      });
      results.push({
        surface,
        label: SURFACE_LABELS[surface],
        device: t.spec.device,
        frameId: applied.rootId,
        opsApplied: applied.applied,
        usedComponents: t.usedComponents,
        warnings: [...t.warnings, ...applied.warnings],
        decisions,
      });
    }
    return { source: { id: source.id, name: source.name }, results };
  }

  async resolveDecision(decisionId: string, choice: DecisionChoice, candidateIndex = 0) {
    const d = this.decisions.get(decisionId);
    if (!d) throw new Error(`Unknown decision ${decisionId}. Pending: ${[...this.decisions.keys()].join(", ") || "none"}.`);
    if (!d.placeholderId) throw new Error(`Decision ${decisionId} has no placeholder on the canvas (it may have been deleted).`);
    const replace = (target: { id?: string; key?: string }, name: string) =>
      this.apply({ root: { mode: "existing", nodeId: d.placeholderId! }, ops: [{ op: "replaceWithInstance", path: [], component: target, name, fillWidth: d.width === undefined }], label: "Resolve missing component" });

    let outcome: string;
    switch (choice) {
      case "synthesize": {
        const ds = await this.designSystem();
        const spec = synthesizeSpec(d, ds);
        const made = await this.figma.request("synthesize_component", spec, PLAN_TIMEOUT);
        this.remember({ id: made.componentId, name: made.name, source: "local", width: spec.width, height: spec.height });
        const r = await replace({ id: made.componentId }, d.label);
        outcome = `Synthesized master component "${made.name}" on the "🧩 DS Proposals" page and placed an instance.${r.warnings.length ? ` Warnings: ${r.warnings.join(" ")}` : ""}`;
        break;
      }
      case "variant_fallback": {
        const c = d.candidates[candidateIndex];
        if (!c) throw new Error(`No candidate #${candidateIndex}. The design system has no related component — choose "synthesize" or "placeholder".`);
        const r = await replace(c.target, `${d.label} (adapted from ${c.name})`);
        outcome = `Placed closest variant "${c.name}" (match score ${c.score}). Review its sizing for ${SURFACE_LABELS[d.surface]}.${r.warnings.length ? ` Warnings: ${r.warnings.join(" ")}` : ""}`;
        break;
      }
      case "placeholder": {
        await this.apply({ root: { mode: "existing", nodeId: d.placeholderId }, ops: [{ op: "rename", path: [], name: `[WIREFRAME] ${d.label}` }], label: "Keep wireframe" });
        outcome = `Kept a wireframe placeholder "[WIREFRAME] ${d.label}" for the designer to complete.`;
        break;
      }
    }
    if (d.flagId) await this.figma.request("remove_nodes", { nodeIds: [d.flagId] });
    this.decisions.delete(decisionId);
    return { decisionId, choice, outcome, remainingDecisions: [...this.decisions.keys()] };
  }

  // -------------------------------------------------------------------------
  // Module 3: RTLMatrix
  // -------------------------------------------------------------------------

  async mirrorRtl(input: { nodeId?: string; targetLanguage?: RtlLanguage; swapDirectionalIcons?: boolean; createDuplicate?: boolean }) {
    const nodeId = await this.target(input.nodeId);
    const [source, ds] = await Promise.all([this.figma.request("snapshot", { nodeId }, { timeoutMs: 60_000 }), this.designSystem()]);
    const rtl = planRtl(source, {
      targetLanguage: input.targetLanguage,
      swapDirectionalIcons: input.swapDirectionalIcons,
      createDuplicate: input.createDuplicate,
      findMirrorComponent: createMirrorFinder(ds),
    });
    const applied = await this.apply(rtl.plan);
    let toTranslate: Array<{ nodeId: string; name: string; characters: string }> = [];
    if (input.targetLanguage && input.targetLanguage !== "none") {
      const mirrored = await this.figma.request("snapshot", { nodeId: applied.rootId }, { timeoutMs: 60_000 });
      toTranslate = translatableTexts(mirrored);
    }
    return {
      frameId: applied.rootId,
      stats: rtl.stats satisfies RtlStats,
      shielded: rtl.shielded.map((s) => ({ name: s.name, reason: s.reason })),
      warnings: [...rtl.warnings, ...applied.warnings],
      toTranslate,
    };
  }

  applyText(updates: Array<{ nodeId: string; characters: string }>) {
    return this.figma.request("apply_text", { updates }, PLAN_TIMEOUT);
  }

  // -------------------------------------------------------------------------
  // Module 2: DS-Sentinel audit
  // -------------------------------------------------------------------------

  async audit(input: { nodeId?: string; autoFixSafeTokens?: boolean }): Promise<{ report: AuditReport; fixed: number; fixWarnings: string[] }> {
    const nodeId = await this.target(input.nodeId);
    const [root, ds] = await Promise.all([this.figma.request("snapshot", { nodeId }, { timeoutMs: 60_000 }), this.designSystem()]);
    const report = auditDesignSystem(root, ds);
    if (!input.autoFixSafeTokens || !report.fixPlan) return { report, fixed: 0, fixWarnings: [] };
    const applied = await this.apply(report.fixPlan);
    return { report, fixed: applied.applied, fixWarnings: applied.warnings };
  }

  // -------------------------------------------------------------------------
  // Module 4: DevSpec
  // -------------------------------------------------------------------------

  async handoff(input: { nodeId?: string; targetStack: TargetStack; renderOnCanvas?: boolean }) {
    const nodeId = await this.target(input.nodeId);
    const [root, ds] = await Promise.all([this.figma.request("snapshot", { nodeId }, { timeoutMs: 60_000 }), this.designSystem()]);
    const spec = buildHandoff(root, ds, input.targetStack);
    const sectionId = input.renderOnCanvas === false ? undefined : (await this.figma.request("render_handoff", { nodeId, spec }, PLAN_TIMEOUT)).sectionId;
    return { sectionId, title: spec.title, markdown: handoffToMarkdown(spec), tokens: spec.ledger.length, notes: spec.notes.length, codeLines: spec.code.text.split("\n").length, language: spec.code.language };
  }
}

function findVariable(ds: DsIndex, type: DsVariable["resolvedType"], name: RegExp): DsVariable | undefined {
  return ds.variables.find((v) => v.resolvedType === type && name.test(v.name));
}

const SLOTS: Partial<Record<ComponentRole, string[]>> = {
  nav_bottom: ["Home", "Search", "Library", "Profile"],
  tab_bar_top: ["Home", "Movies", "Series", "Live", "Settings"],
  sidebar: ["Home", "Browse", "Library", "Settings"],
};

/** Builds a token-only component spec: colors, radius and spacing come from the file's variables. */
export function synthesizeSpec(d: PendingDecision, ds: DsIndex): SynthesizeSpec {
  const surface = findVariable(ds, "COLOR", /(^|\/)(surface|background|bg)([\s/_-]*(primary|default|base))?$/i) ?? findVariable(ds, "COLOR", /surface|background/i);
  const onSurface = findVariable(ds, "COLOR", /on[\s/_-]*surface|text[\s/_-]*(primary|default)|foreground|content[\s/_-]*primary/i);
  const radius = findVariable(ds, "FLOAT", /radius|corner/i);
  const spacing = ds.variables.find((v) => v.resolvedType === "FLOAT" && /spac|gap|pad/i.test(v.name) && v.value === 16);
  const color = (v: DsVariable | undefined, fallback: Rgba): Rgba => (v && typeof v.value === "object" ? (v.value as Rgba) : fallback);
  const slots = SLOTS[d.role] ?? [];
  return {
    name: `${TAXONOMY[d.role]}/${PLATFORM_SUFFIX[d.surface]}`,
    role: d.role,
    width: d.width ?? WIDTH[d.surface],
    height: d.height,
    surfaceVariableId: surface?.id,
    onSurfaceVariableId: onSurface?.id,
    fallbackSurface: color(surface, { r: 1, g: 1, b: 1, a: 1 }),
    fallbackOnSurface: color(onSurface, { r: 0.07, g: 0.07, b: 0.09, a: 1 }),
    cornerRadius: d.role === "sidebar" || d.role.startsWith("nav") || d.role === "status_bar" ? 0 : typeof radius?.value === "number" ? radius.value : 8,
    padding: typeof spacing?.value === "number" ? spacing.value : 16,
    itemSpacing: 8,
    slots,
    orientation: d.role === "sidebar" ? "vertical" : "horizontal",
    title: slots.length ? undefined : d.role === "status_bar" ? "9:41" : d.role === "home_indicator" ? "" : "Title",
  };
}
