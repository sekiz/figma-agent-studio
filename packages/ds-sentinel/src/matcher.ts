import type {
  ComponentCandidate,
  ComponentQuery,
  ComponentRef,
  ComponentResolver,
  ComponentRole,
  DsComponent,
  DsIndex,
  Surface,
} from "@figma-studio/shared-types";

/**
 * Taxonomy resolver.
 *
 * Component names are split into lowercase tokens from every naming style designers use:
 * slash paths ("Navigation/Bar/Bottom/iOS"), variant strings ("Type=Bottom, Platform=iOS"),
 * component-set names and camel/kebab case. A role is a list of concept groups; a component
 * matches a group when it contains any synonym of that group. Platform is scored separately.
 */

const ROLE_CONCEPTS: Record<ComponentRole, string[][]> = {
  nav_top: [
    ["navigation", "nav", "navbar", "appbar", "topappbar", "header", "toolbar"],
    ["top", "bar", "header", "title", "large", "appbar", "navbar", "toolbar"],
  ],
  nav_bottom: [
    ["navigation", "nav", "tab", "tabbar", "tabs", "navbar", "bottomnav", "bottomnavigation"],
    ["bottom", "tab", "tabbar", "bottomnav", "bottomnavigation"],
  ],
  tab_bar_top: [
    ["tab", "tabs", "tabbar", "navigation", "nav", "menu"],
    ["top", "tab", "tabs", "tabbar", "horizontal"],
  ],
  sidebar: [["sidebar", "sidenav", "rail", "drawer", "navigationrail", "split", "navigation", "nav"], ["sidebar", "side", "rail", "drawer", "left", "split"]],
  status_bar: [["status", "statusbar"], ["bar", "statusbar"]],
  home_indicator: [["home", "homeindicator", "gesture"], ["indicator", "homeindicator", "bar", "handle"]],
  button: [["button", "btn", "cta"]],
  card: [["card", "tile"]],
};

/** Tokens that make a component the WRONG role even if the concepts match (e.g. a bottom bar is not a top bar). */
const ROLE_EXCLUSIONS: Partial<Record<ComponentRole, string[]>> = {
  nav_top: ["bottom", "tabbar", "tab", "rail", "sidebar", "status", "drawer"],
  nav_bottom: ["top", "header", "status", "rail", "sidebar"],
  tab_bar_top: ["bottom", "status"],
  status_bar: ["navigation", "nav", "tab"],
  sidebar: ["bottom", "top", "status"],
};

export const PLATFORM_SYNONYMS: Record<Surface, string[]> = {
  ios: ["ios", "iphone", "apple", "hig", "cupertino", "mobileios"],
  android_m3: ["android", "m3", "md3", "material", "material3", "materialyou"],
  smart_tv_10ft: ["tv", "10ft", "tenfoot", "smarttv", "androidtv", "tvos", "googletv", "television"],
  tablet: ["tablet", "ipad", "foldable"],
};

const ALL_PLATFORM_TOKENS = new Set(Object.values(PLATFORM_SYNONYMS).flat());

export function tokenize(...parts: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    const spaced = part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[=,/\\|_\-.()[\]:]+/g, " ")
      .toLowerCase();
    const words = spaced.split(/\s+/).filter(Boolean);
    words.forEach((w) => out.add(w));
    // Compound tokens so "Tab Bar" also matches "tabbar" and "Top App Bar" matches "topappbar".
    for (let i = 0; i < words.length - 1; i++) {
      out.add(words[i]! + words[i + 1]!);
      if (i < words.length - 2) out.add(words[i]! + words[i + 1]! + words[i + 2]!);
    }
  }
  return [...out];
}

function componentTokens(c: DsComponent): string[] {
  const props = c.variantProperties ? Object.entries(c.variantProperties).map(([k, v]) => `${k} ${v}`) : [];
  return tokenize(c.name, c.componentSetName, ...props);
}

export interface MatchOptions {
  /** Minimum score to accept a component as an exact match (0..1). Default 0.75. */
  threshold?: number;
}

export function scoreComponent(c: DsComponent, query: ComponentQuery): number {
  const tokens = new Set(componentTokens(c));
  const groups = ROLE_CONCEPTS[query.role];
  const hits = groups.filter((g) => g.some((syn) => tokens.has(syn))).length;
  if (hits === 0) return 0;
  let score = (hits / groups.length) * 0.7;

  const excluded = (ROLE_EXCLUSIONS[query.role] ?? []).some((t) => tokens.has(t));
  if (excluded) score *= 0.4;

  const platformTokens = [...tokens].filter((t) => ALL_PLATFORM_TOKENS.has(t));
  if (query.surface) {
    const wanted = PLATFORM_SYNONYMS[query.surface];
    if (platformTokens.some((t) => wanted.includes(t))) score += 0.3;
    else if (platformTokens.length === 0) score += 0.1; // platform-agnostic component
    else score *= 0.5; // explicitly another platform
  } else {
    score += platformTokens.length === 0 ? 0.3 : 0.1;
  }
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

export function rankComponents(index: DsIndex, query: ComponentQuery): ComponentCandidate[] {
  return index.components
    .map((c) => ({
      target: { id: c.id, key: c.key },
      name: c.componentSetName ? `${c.componentSetName} / ${c.name}` : c.name,
      score: scoreComponent(c, query),
      width: c.width,
      height: c.height,
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function createResolver(index: DsIndex, options: MatchOptions = {}): ComponentResolver {
  const threshold = options.threshold ?? 0.75;
  return (query) => {
    const candidates = rankComponents(index, query);
    const best = candidates[0];
    return { match: best && best.score >= threshold ? best : undefined, candidates };
  };
}

// ---------------------------------------------------------------------------
// Mirrored counterparts (RTL)
// ---------------------------------------------------------------------------

const OPPOSITE: Record<string, string> = {
  left: "right",
  right: "left",
  forward: "back",
  back: "forward",
  next: "previous",
  previous: "next",
  prev: "next",
  start: "end",
  end: "start",
};

/** "ChevronLeft" → "Chevron Right", "arrow_back" → "arrow_forward"; "Background" stays untouched. */
export function swapDirectionWords(name: string): string {
  const split = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  return split.replace(/(?<![a-z])(left|right|forward|back|next|previous|prev|start|end)(?![a-z])/gi, (m) => {
    const repl = OPPOSITE[m.toLowerCase()]!;
    return m[0] === m[0]!.toUpperCase() ? repl[0]!.toUpperCase() + repl.slice(1) : repl;
  });
}

const norm = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
const RTL = /direction\s*=\s*rtl|(?<![a-z])rtl(?![a-z])/i;
const withoutDirection = (s: string) => norm(s.replace(/,?\s*direction\s*=\s*\w+/i, "").replace(/(?<![a-z])(rtl|ltr)(?![a-z])/gi, ""));

export function createMirrorFinder(index: DsIndex) {
  return (ref: ComponentRef, kind: "flipped_icon" | "rtl_variant"): { id?: string; key?: string; name: string } | null => {
    const name = ref.mainComponentName ?? "";
    if (!name) return null;
    const sameSet = (c: DsComponent) => (ref.componentSetName ? c.componentSetName === ref.componentSetName : !c.componentSetName);

    let hit: DsComponent | undefined;
    if (kind === "flipped_icon") {
      const wanted = norm(swapDirectionWords(name));
      if (wanted === norm(name)) return null;
      hit = index.components.find((c) => sameSet(c) && norm(c.name) === wanted);
    } else {
      if (RTL.test(name)) return null;
      const base = withoutDirection(name);
      hit = index.components.find((c) => sameSet(c) && RTL.test(c.name) && withoutDirection(c.name) === base);
    }
    return hit ? { id: hit.id, key: hit.key, name: hit.name } : null;
  };
}
