import { z } from "zod";
import { AxisAlignSchema, ConstraintSchema, LayoutModeSchema, RgbaSchema, SizingSchema, TextAlignSchema } from "./snapshot.js";

/**
 * A mutation plan is the only way engines change the canvas.
 *
 * Nodes are addressed by *child-index paths* relative to the plan root (`[]` is the root itself,
 * `[0, 2]` is the third child of the first child). The plugin resolves every path to a live node
 * BEFORE applying the first op, so ops that reorder or insert children never invalidate later paths.
 * Insert ops use `index` against the parent's children *at the moment the op runs* (-1 appends).
 * Because a clone has the same tree shape as its source, a plan computed from the source snapshot
 * applies unchanged to a fresh duplicate.
 */
export const PathSchema = z.array(z.number().int().nonnegative());
export type Path = z.infer<typeof PathSchema>;

export const ComponentTargetSchema = z
  .object({ id: z.string().optional(), key: z.string().optional() })
  .refine((c) => Boolean(c.id ?? c.key), "component target needs an id or a key");
export type ComponentTarget = z.infer<typeof ComponentTargetSchema>;

const Padding = z.object({
  top: z.number().optional(),
  right: z.number().optional(),
  bottom: z.number().optional(),
  left: z.number().optional(),
});

export const PlanOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("resize"), path: PathSchema, width: z.number().positive(), height: z.number().positive().optional() }),
  z.object({
    op: z.literal("setLayout"),
    path: PathSchema,
    layoutMode: LayoutModeSchema.optional(),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
    itemSpacing: z.number().optional(),
    counterAxisSpacing: z.number().optional(),
    padding: Padding.optional(),
    primaryAxisAlignItems: AxisAlignSchema.optional(),
    counterAxisAlignItems: AxisAlignSchema.optional(),
    primaryAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
    counterAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
    clipsContent: z.boolean().optional(),
  }),
  z.object({ op: z.literal("setSizing"), path: PathSchema, horizontal: SizingSchema.optional(), vertical: SizingSchema.optional() }),
  z.object({ op: z.literal("setMinSize"), path: PathSchema, minWidth: z.number().optional(), minHeight: z.number().optional() }),
  z.object({
    op: z.literal("setText"),
    path: PathSchema,
    fontSize: z.number().positive().optional(),
    fontFamily: z.string().optional(),
    /** Tried in order when `fontFamily` is not available; the node's current family is the final fallback. */
    fontFamilyFallbacks: z.array(z.string()).optional(),
    textAlignHorizontal: TextAlignSchema.optional(),
    characters: z.string().optional(),
  }),
  z.object({ op: z.literal("reverseChildren"), path: PathSchema }),
  z.object({ op: z.literal("setPosition"), path: PathSchema, x: z.number().optional(), y: z.number().optional() }),
  z.object({ op: z.literal("setConstraints"), path: PathSchema, horizontal: ConstraintSchema.optional(), vertical: ConstraintSchema.optional() }),
  z.object({ op: z.literal("flipHorizontal"), path: PathSchema }),
  z.object({ op: z.literal("swapComponent"), path: PathSchema, component: ComponentTargetSchema }),
  z.object({
    op: z.literal("replaceWithInstance"),
    path: PathSchema,
    component: ComponentTargetSchema,
    name: z.string().optional(),
    fillWidth: z.boolean().default(true),
    tag: z.string().optional(),
  }),
  z.object({
    op: z.literal("insertInstance"),
    parentPath: PathSchema,
    index: z.number().int(),
    component: ComponentTargetSchema,
    name: z.string().optional(),
    fillWidth: z.boolean().default(true),
    /** Fixed width; ignored when fillWidth is true. */
    width: z.number().positive().optional(),
    fillHeight: z.boolean().default(false),
    tag: z.string().optional(),
  }),
  z.object({
    op: z.literal("insertSpacer"),
    parentPath: PathSchema,
    index: z.number().int(),
    name: z.string(),
    height: z.number().nonnegative(),
    tag: z.string().optional(),
  }),
  z.object({
    op: z.literal("insertPlaceholder"),
    parentPath: PathSchema,
    index: z.number().int(),
    name: z.string(),
    label: z.string(),
    height: z.number().positive(),
    /** Fixed width; when absent the placeholder fills the parent's width. */
    width: z.number().positive().optional(),
    fillHeight: z.boolean().default(false),
    tag: z.string().optional(),
  }),
  z.object({
    op: z.literal("replaceWithPlaceholder"),
    path: PathSchema,
    name: z.string(),
    label: z.string(),
    tag: z.string().optional(),
  }),
  z.object({ op: z.literal("focusRing"), path: PathSchema, color: RgbaSchema, weight: z.number().positive(), glowRadius: z.number().nonnegative() }),
  z.object({ op: z.literal("removeShadows"), path: PathSchema }),
  z.object({
    op: z.literal("bindVariable"),
    path: PathSchema,
    /** "fills" | "strokes" bind the paint at `paintIndex`; anything else is a numeric field (itemSpacing, paddingLeft, ...). */
    field: z.string(),
    variableId: z.string(),
    /** Paint index for "fills" / "strokes" (default 0). */
    paintIndex: z.number().int().nonnegative().optional(),
  }),
  z.object({ op: z.literal("rename"), path: PathSchema, name: z.string() }),
  z.object({ op: z.literal("remove"), path: PathSchema }),
  /** Moves all current children of `path` into a new Auto-Layout frame that fills the parent. */
  z.object({
    op: z.literal("wrapChildren"),
    path: PathSchema,
    name: z.string(),
    layoutMode: z.enum(["HORIZONTAL", "VERTICAL"]),
    itemSpacing: z.number().optional(),
    padding: Padding.optional(),
    tag: z.string().optional(),
  }),
  z.object({ op: z.literal("setPluginData"), path: PathSchema, key: z.string(), value: z.string() }),
  z.object({
    op: z.literal("flag"),
    /** Node the flag points at; the flag itself is placed on the page next to the plan root. */
    path: PathSchema,
    title: z.string(),
    message: z.string(),
    tag: z.string().optional(),
  }),
]);
export type PlanOp = z.infer<typeof PlanOpSchema>;
export type PlanOpOf<K extends PlanOp["op"]> = Extract<PlanOp, { op: K }>;

export const PlanRootSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), nodeId: z.string() }),
  z.object({
    mode: z.literal("clone"),
    sourceId: z.string(),
    name: z.string(),
    /** Place the clone to the right of the source (slot 0 = first column after the source). */
    placeBesideSource: z.boolean().default(true),
    slot: z.number().int().nonnegative().default(0),
  }),
]);
export type PlanRoot = z.infer<typeof PlanRootSchema>;

export const MutationPlanSchema = z.object({
  root: PlanRootSchema,
  ops: z.array(PlanOpSchema),
  /** Label shown in the plugin while applying; also used for the undo checkpoint. */
  label: z.string().default("figma-agent-studio"),
});
export type MutationPlan = z.infer<typeof MutationPlanSchema>;
export type MutationPlanInput = z.input<typeof MutationPlanSchema>;

export const ApplyPlanResultSchema = z.object({
  rootId: z.string(),
  applied: z.number().int(),
  /** tag → created node id */
  tags: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
});
export type ApplyPlanResult = z.infer<typeof ApplyPlanResultSchema>;
