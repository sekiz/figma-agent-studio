import { z } from "zod";

/** RGB(A) color with 0..1 channels, exactly as the Figma Plugin API stores it. */
export const RgbaSchema = z.object({
  r: z.number(),
  g: z.number(),
  b: z.number(),
  a: z.number().default(1),
});
export type Rgba = z.infer<typeof RgbaSchema>;

export const PaintSnapshotSchema = z.object({
  type: z.string(),
  visible: z.boolean().default(true),
  opacity: z.number().default(1),
  /** Present only for SOLID paints. */
  color: RgbaSchema.optional(),
  /** Id of the COLOR variable bound to this paint, if any. */
  boundVariableId: z.string().optional(),
});
export type PaintSnapshot = z.infer<typeof PaintSnapshotSchema>;

export const ComponentRefSchema = z.object({
  mainComponentId: z.string().optional(),
  mainComponentKey: z.string().optional(),
  mainComponentName: z.string().optional(),
  componentSetName: z.string().optional(),
  remote: z.boolean().default(false),
});
export type ComponentRef = z.infer<typeof ComponentRefSchema>;

export const LayoutModeSchema = z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]);
export type LayoutMode = z.infer<typeof LayoutModeSchema>;
export const AxisAlignSchema = z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN", "SPACE_EVENLY", "SPACE_AROUND", "BASELINE"]);
export type AxisAlign = z.infer<typeof AxisAlignSchema>;
export const SizingSchema = z.enum(["FIXED", "HUG", "FILL"]);
export type Sizing = z.infer<typeof SizingSchema>;
export const ConstraintSchema = z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]);
export type Constraint = z.infer<typeof ConstraintSchema>;
export const TextAlignSchema = z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]);
export type TextAlign = z.infer<typeof TextAlignSchema>;

/** Bindings for numeric fields (spacing, padding, radius) → variable id. */
export const NumericBindingsSchema = z.record(z.string(), z.string());

/**
 * A serialisable, read-only projection of a Figma scene node.
 * The plugin produces it; every pure engine consumes it. Engines never touch the live Figma API.
 */
export interface NodeSnapshot {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  /** Auto-Layout container fields (frames, components, instances). */
  layoutMode?: LayoutMode;
  layoutWrap?: "NO_WRAP" | "WRAP";
  primaryAxisAlignItems?: AxisAlign;
  counterAxisAlignItems?: AxisAlign;
  itemSpacing?: number;
  counterAxisSpacing?: number | null;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  clipsContent?: boolean;
  /** Child-in-Auto-Layout fields. */
  layoutSizingHorizontal?: Sizing;
  layoutSizingVertical?: Sizing;
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  minWidth?: number | null;
  minHeight?: number | null;
  constraints?: { horizontal: Constraint; vertical: Constraint };
  cornerRadius?: number | null;
  fills?: PaintSnapshot[];
  strokes?: PaintSnapshot[];
  effects?: Array<{ type: string; visible: boolean }>;
  boundVariables?: Record<string, string>;
  /** TEXT nodes. */
  characters?: string;
  fontSize?: number | null;
  fontWeight?: number | null;
  fontFamily?: string | null;
  fontStyle?: string | null;
  textAlignHorizontal?: TextAlign;
  /** INSTANCE nodes. */
  component?: ComponentRef;
  /** Plugin data written by figma-agent-studio itself (e.g. "surface"). */
  pluginData?: Record<string, string>;
  /** Number of descendants omitted because of the depth limit. */
  truncatedChildren?: number;
  children?: NodeSnapshot[];
}

export const NodeSnapshotSchema: z.ZodType<NodeSnapshot> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    visible: z.boolean(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    rotation: z.number().optional(),
    layoutMode: LayoutModeSchema.optional(),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
    primaryAxisAlignItems: AxisAlignSchema.optional(),
    counterAxisAlignItems: AxisAlignSchema.optional(),
    itemSpacing: z.number().optional(),
    counterAxisSpacing: z.number().nullable().optional(),
    paddingLeft: z.number().optional(),
    paddingRight: z.number().optional(),
    paddingTop: z.number().optional(),
    paddingBottom: z.number().optional(),
    clipsContent: z.boolean().optional(),
    layoutSizingHorizontal: SizingSchema.optional(),
    layoutSizingVertical: SizingSchema.optional(),
    layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
    minWidth: z.number().nullable().optional(),
    minHeight: z.number().nullable().optional(),
    constraints: z.object({ horizontal: ConstraintSchema, vertical: ConstraintSchema }).optional(),
    cornerRadius: z.number().nullable().optional(),
    fills: z.array(PaintSnapshotSchema).optional(),
    strokes: z.array(PaintSnapshotSchema).optional(),
    effects: z.array(z.object({ type: z.string(), visible: z.boolean() })).optional(),
    boundVariables: z.record(z.string(), z.string()).optional(),
    characters: z.string().optional(),
    fontSize: z.number().nullable().optional(),
    fontWeight: z.number().nullable().optional(),
    fontFamily: z.string().nullable().optional(),
    fontStyle: z.string().nullable().optional(),
    textAlignHorizontal: TextAlignSchema.optional(),
    component: ComponentRefSchema.optional(),
    pluginData: z.record(z.string(), z.string()).optional(),
    truncatedChildren: z.number().optional(),
    children: z.array(NodeSnapshotSchema).optional(),
  }),
) as z.ZodType<NodeSnapshot>;

/** Depth-first walk that yields every node with its child-index path relative to the root. */
export function* walk(
  root: NodeSnapshot,
  path: number[] = [],
  ancestors: NodeSnapshot[] = [],
): Generator<{ node: NodeSnapshot; path: number[]; ancestors: NodeSnapshot[] }> {
  yield { node: root, path, ancestors };
  const children = root.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    yield* walk(child, [...path, i], [...ancestors, root]);
  }
}

export function countNodes(root: NodeSnapshot): number {
  let n = 0;
  for (const _ of walk(root)) n++;
  return n;
}
