import { z } from "zod";

export const SurfaceSchema = z.enum(["ios", "android_m3", "smart_tv_10ft", "tablet"]);
export type Surface = z.infer<typeof SurfaceSchema>;

export const SURFACE_LABELS: Record<Surface, string> = {
  ios: "iOS",
  android_m3: "Android M3",
  smart_tv_10ft: "Smart TV",
  tablet: "Tablet",
};

/** Plugin-data key used to remember which surface a generated frame targets. */
export const PLUGIN_DATA_SURFACE = "fas.surface";
/** Plugin-data key marking audit flags so they can be found and removed later. */
export const PLUGIN_DATA_FLAG = "fas.flag";
