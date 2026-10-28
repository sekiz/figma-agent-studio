import { z } from "zod";
import { RgbaSchema } from "./snapshot.js";

export const DsComponentSchema = z.object({
  /** Local node id; absent for library components that are not imported yet. */
  id: z.string().optional(),
  /** Publish key; required to import a component from a team library. */
  key: z.string().optional(),
  /** Full component name, e.g. "Navigation/Bar/Bottom/iOS" or "Type=Bottom, Platform=iOS". */
  name: z.string(),
  /** Name of the parent component set, if the component is a variant. */
  componentSetName: z.string().optional(),
  /** Variant properties, e.g. { Type: "Bottom", Platform: "iOS" }. */
  variantProperties: z.record(z.string(), z.string()).optional(),
  description: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  source: z.enum(["local", "library"]),
  libraryName: z.string().optional(),
});
export type DsComponent = z.infer<typeof DsComponentSchema>;

export const DsVariableSchema = z.object({
  id: z.string(),
  key: z.string().optional(),
  name: z.string(),
  collectionName: z.string().optional(),
  resolvedType: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]),
  /** Value in the collection's default mode. Aliases are resolved by the plugin when possible. */
  value: z.union([RgbaSchema, z.number(), z.string(), z.boolean()]).optional(),
  scopes: z.array(z.string()).optional(),
  /** Figma "code syntax" overrides (WEB / ANDROID / iOS). */
  codeSyntax: z.record(z.string(), z.string()).optional(),
});
export type DsVariable = z.infer<typeof DsVariableSchema>;

export const DsPaintStyleSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: RgbaSchema.optional(),
});
export type DsPaintStyle = z.infer<typeof DsPaintStyleSchema>;

export const DsIndexSchema = z.object({
  fileName: z.string().optional(),
  components: z.array(DsComponentSchema),
  variables: z.array(DsVariableSchema),
  paintStyles: z.array(DsPaintStyleSchema),
  scannedAt: z.string(),
});
export type DsIndex = z.infer<typeof DsIndexSchema>;

export function emptyDsIndex(): DsIndex {
  return { components: [], variables: [], paintStyles: [], scannedAt: new Date(0).toISOString() };
}

// ---------------------------------------------------------------------------
// Component resolution contract (implemented by ds-sentinel, consumed by engines)
// ---------------------------------------------------------------------------

export const ComponentRoleSchema = z.enum([
  "nav_top",
  "nav_bottom",
  "tab_bar_top",
  "sidebar",
  "status_bar",
  "home_indicator",
  "button",
  "card",
]);
export type ComponentRole = z.infer<typeof ComponentRoleSchema>;

export interface ComponentQuery {
  role: ComponentRole;
  /** Platform the component must belong to; undefined accepts platform-agnostic components. */
  surface?: "ios" | "android_m3" | "smart_tv_10ft" | "tablet";
}

export interface ComponentCandidate {
  target: { id?: string; key?: string };
  name: string;
  score: number;
  width?: number;
  height?: number;
}

export interface ComponentResolution {
  /** Best candidate at or above the confidence threshold. */
  match?: ComponentCandidate;
  /** Every scored candidate, best first (includes sub-threshold ones for "variant fallback"). */
  candidates: ComponentCandidate[];
}

export type ComponentResolver = (query: ComponentQuery) => ComponentResolution;

export const noComponentResolver: ComponentResolver = () => ({ candidates: [] });
