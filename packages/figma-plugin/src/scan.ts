import type { DsComponent, DsIndex, DsVariable, Rgba } from "@figma-studio/shared-types";

async function resolveValue(value: VariableValue, modeHint: string | undefined, depth = 0): Promise<DsVariable["value"]> {
  if (typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS") {
    if (depth > 8) return undefined;
    const target = await figma.variables.getVariableByIdAsync(value.id);
    if (!target) return undefined;
    const collection = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
    const mode = collection?.defaultModeId ?? modeHint ?? Object.keys(target.valuesByMode)[0];
    const next = mode ? target.valuesByMode[mode] : undefined;
    return next === undefined ? undefined : resolveValue(next, mode, depth + 1);
  }
  if (typeof value === "object" && value !== null && "r" in value) {
    const c = value as RGB | RGBA;
    return { r: c.r, g: c.g, b: c.b, a: "a" in c ? c.a : 1 } satisfies Rgba;
  }
  return value as number | string | boolean;
}

/** Indexes local components, variables and paint styles of the open file. */
export async function scanDesignSystem(): Promise<DsIndex> {
  // dynamic-page documents must be fully loaded before searching across pages.
  await figma.loadAllPagesAsync();

  const components: DsComponent[] = [];
  const nodes = figma.root.findAllWithCriteria({ types: ["COMPONENT"] });
  for (const c of nodes) {
    const set = c.parent && c.parent.type === "COMPONENT_SET" ? c.parent : null;
    let variantProperties: Record<string, string> | undefined;
    if (set) {
      try {
        variantProperties = c.variantProperties ?? undefined;
      } catch {
        variantProperties = undefined;
      }
    }
    components.push({
      id: c.id,
      key: c.key,
      name: c.name,
      componentSetName: set?.name,
      variantProperties,
      description: c.description || undefined,
      width: c.width,
      height: c.height,
      source: "local",
    });
  }

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionById = new Map(collections.map((c) => [c.id, c]));
  const variables: DsVariable[] = [];
  for (const v of await figma.variables.getLocalVariablesAsync()) {
    if (v.resolvedType !== "COLOR" && v.resolvedType !== "FLOAT" && v.resolvedType !== "STRING" && v.resolvedType !== "BOOLEAN") continue;
    const collection = collectionById.get(v.variableCollectionId);
    const mode = collection?.defaultModeId ?? Object.keys(v.valuesByMode)[0];
    const raw = mode ? v.valuesByMode[mode] : undefined;
    variables.push({
      id: v.id,
      key: v.key,
      name: v.name,
      collectionName: collection?.name,
      resolvedType: v.resolvedType,
      value: raw === undefined ? undefined : await resolveValue(raw, mode),
      scopes: [...v.scopes],
      codeSyntax: { ...v.codeSyntax },
    });
  }

  const paintStyles = (await figma.getLocalPaintStylesAsync()).map((s) => {
    const solid = s.paints.find((p): p is SolidPaint => p.type === "SOLID");
    return { id: s.id, name: s.name, color: solid ? { r: solid.color.r, g: solid.color.g, b: solid.color.b, a: solid.opacity ?? 1 } : undefined };
  });

  return { fileName: figma.root.name, components, variables, paintStyles, scannedAt: new Date().toISOString() };
}
