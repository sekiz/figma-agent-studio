import type { ComponentRole, Rgba, Surface } from "@figma-studio/shared-types";

export interface ChromeSlot {
  role: ComponentRole;
  height: number;
  label: string;
  /** Optional slots fall back to a plain spacer instead of raising a design-system decision. */
  optional: boolean;
}

export interface PlatformSpec {
  surface: Surface;
  label: string;
  device: string;
  width: number;
  height: number;
  unit: "pt" | "dp" | "px";
  /** Horizontal content margin inside the root frame. */
  marginX: number;
  /** Extra vertical padding inside the root (TV overscan); safe areas are separate spacers. */
  marginY: number;
  safeArea: { top: number; bottom: number; topLabel: string; bottomLabel: string };
  typography: {
    textFamily: string;
    displayFamily: string;
    familyFallbacks: string[];
    /** Font sizes >= this are treated as display/headline text. */
    displayThreshold: number;
    minSize: number;
    maxSize: number;
    /** Multiplier for display text (body text keeps its size except on TV). */
    displayScale: number;
    bodyScale: number;
  };
  spacing: { keepUpTo: number; scale: number; min: number };
  minTouchTarget: number | null;
  grid: "stack" | "two_column" | "dpad_row";
  /** Replaces a detected desktop top navigation. */
  topNav: ChromeSlot | null;
  /** Inserted at the bottom of the screen when the source had navigation. */
  bottomNav: ChromeSlot | null;
  /** Inserted as the first column when the platform uses a sidebar (tablet split view). */
  sidebar: (ChromeSlot & { width: number }) | null;
  statusBar: ChromeSlot | null;
  homeIndicator: ChromeSlot | null;
  focusRing: { color: Rgba; weight: number; glowRadius: number } | null;
  elevation: "shadow" | "tonal";
}

export interface SurfaceOverrides {
  /** Smart TV title/action-safe margin. Default 80px on every edge (PRD); tvOS/Android TV often use ~80-96 x 48-60. */
  tvOverscan?: { horizontal: number; vertical: number };
  /** Android bottom safe area: 3-button navigation (48dp, default) or gesture navigation (24dp). */
  androidNavigation?: "three_button" | "gesture";
}

const SF = ["SF Pro", "Inter"];

export function platformSpec(surface: Surface, overrides: SurfaceOverrides = {}): PlatformSpec {
  switch (surface) {
    case "ios":
      return {
        surface,
        label: "iOS",
        device: "iPhone 16 (393×852 pt)",
        width: 393,
        height: 852,
        unit: "pt",
        marginX: 16,
        marginY: 0,
        safeArea: { top: 59, bottom: 34, topLabel: "Dynamic Island", bottomLabel: "Home Indicator" },
        typography: {
          textFamily: "SF Pro Text",
          displayFamily: "SF Pro Display",
          familyFallbacks: SF,
          displayThreshold: 20,
          minSize: 11,
          maxSize: 34,
          displayScale: 0.75,
          bodyScale: 1,
        },
        spacing: { keepUpTo: 16, scale: 0.5, min: 16 },
        minTouchTarget: 44,
        grid: "stack",
        topNav: { role: "nav_top", height: 96, label: "Large Title Navigation Bar (96pt)", optional: false },
        bottomNav: { role: "nav_bottom", height: 49, label: "Tab Bar (49pt)", optional: false },
        sidebar: null,
        statusBar: { role: "status_bar", height: 59, label: "Status Bar", optional: true },
        homeIndicator: { role: "home_indicator", height: 34, label: "Home Indicator", optional: true },
        focusRing: null,
        elevation: "shadow",
      };
    case "android_m3": {
      const gesture = overrides.androidNavigation === "gesture";
      return {
        surface,
        label: "Android (Material 3)",
        device: "Android compact (412×917 dp)",
        width: 412,
        height: 917,
        unit: "dp",
        marginX: 16,
        marginY: 0,
        safeArea: {
          top: 24,
          bottom: gesture ? 24 : 48,
          topLabel: "Status Bar",
          bottomLabel: gesture ? "Gesture Navigation" : "System Navigation Bar",
        },
        typography: {
          textFamily: "Roboto",
          displayFamily: "Roboto",
          familyFallbacks: ["Google Sans", "Roboto Flex", "Inter"],
          displayThreshold: 20,
          minSize: 11,
          maxSize: 36,
          displayScale: 0.75,
          bodyScale: 1,
        },
        spacing: { keepUpTo: 16, scale: 0.5, min: 16 },
        minTouchTarget: 48,
        grid: "stack",
        topNav: { role: "nav_top", height: 64, label: "Top App Bar (64dp)", optional: false },
        bottomNav: { role: "nav_bottom", height: 80, label: "M3 Navigation Bar (80dp)", optional: false },
        sidebar: null,
        statusBar: { role: "status_bar", height: 24, label: "Status Bar", optional: true },
        homeIndicator: null,
        focusRing: null,
        elevation: "tonal",
      };
    }
    case "smart_tv_10ft": {
      const o = overrides.tvOverscan ?? { horizontal: 80, vertical: 80 };
      return {
        surface,
        label: "Smart TV (10-foot UI)",
        device: "1080p TV (1920×1080 px)",
        width: 1920,
        height: 1080,
        unit: "px",
        marginX: o.horizontal,
        marginY: o.vertical,
        safeArea: { top: 0, bottom: 0, topLabel: "Overscan", bottomLabel: "Overscan" },
        typography: {
          textFamily: "",
          displayFamily: "",
          familyFallbacks: [],
          displayThreshold: 32,
          minSize: 24,
          maxSize: 96,
          displayScale: 1.5,
          bodyScale: 1.5,
        },
        spacing: { keepUpTo: 0, scale: 1.5, min: 16 },
        minTouchTarget: null,
        grid: "dpad_row",
        topNav: { role: "tab_bar_top", height: 96, label: "Top Tab Bar (D-pad)", optional: false },
        bottomNav: null,
        sidebar: null,
        statusBar: null,
        homeIndicator: null,
        focusRing: { color: { r: 1, g: 1, b: 1, a: 1 }, weight: 3, glowRadius: 16 },
        elevation: "shadow",
      };
    }
    case "tablet":
      return {
        surface,
        label: "Tablet",
        device: "iPad 11\" (834×1194 pt)",
        width: 834,
        height: 1194,
        unit: "pt",
        marginX: 24,
        marginY: 0,
        safeArea: { top: 24, bottom: 20, topLabel: "Status Bar", bottomLabel: "Home Indicator" },
        typography: {
          textFamily: "SF Pro Text",
          displayFamily: "SF Pro Display",
          familyFallbacks: SF,
          displayThreshold: 20,
          minSize: 11,
          maxSize: 48,
          displayScale: 0.85,
          bodyScale: 1,
        },
        spacing: { keepUpTo: 24, scale: 0.75, min: 24 },
        minTouchTarget: 44,
        grid: "two_column",
        topNav: null,
        bottomNav: null,
        sidebar: { role: "sidebar", height: 1194, width: 320, label: "Sidebar (320pt)", optional: false },
        statusBar: null,
        homeIndicator: null,
        focusRing: null,
        elevation: "shadow",
      };
  }
}

/** Snap to the 4-pt grid. */
export function snap4(v: number): number {
  return Math.max(0, Math.round(v / 4) * 4);
}

export function mapFontSize(size: number, spec: PlatformSpec): number {
  const t = spec.typography;
  const scaled = size >= t.displayThreshold ? size * t.displayScale : size * t.bodyScale;
  const floor = size >= t.displayThreshold ? Math.max(t.minSize, Math.min(t.displayThreshold, size)) : t.minSize;
  return Math.round(Math.min(t.maxSize, Math.max(floor, scaled)));
}

export function mapSpacing(value: number, spec: PlatformSpec): number {
  const s = spec.spacing;
  if (value <= s.keepUpTo) return value;
  if (s.scale >= 1) return snap4(value * s.scale);
  return snap4(Math.max(s.min, value * s.scale));
}
