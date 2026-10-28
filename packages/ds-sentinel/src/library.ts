import type { DsComponent, DsIndex } from "@figma-studio/shared-types";

/**
 * Team-library indexer.
 *
 * The Plugin API cannot enumerate components that live in another (library) file; it can only import
 * them by key. This indexer reads published components through the Figma REST API with the user's
 * own Personal Access Token so DS-Sentinel can match and import them.
 */

interface RestComponent {
  key: string;
  name: string;
  description?: string;
  node_id?: string;
  containing_frame?: { name?: string; containingComponentSet?: { name?: string } | null } | null;
}

export interface LibraryIndexOptions {
  token: string;
  fileKeys: string[];
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

export function parseVariantName(name: string): Record<string, string> | undefined {
  if (!name.includes("=")) return undefined;
  const props: Record<string, string> = {};
  for (const part of name.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (k && v !== undefined) props[k] = v;
  }
  return Object.keys(props).length > 0 ? props : undefined;
}

export async function fetchLibraryComponents(options: LibraryIndexOptions): Promise<DsComponent[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.apiBase ?? "https://api.figma.com";
  const out: DsComponent[] = [];
  for (const fileKey of options.fileKeys) {
    const res = await doFetch(`${base}/v1/files/${encodeURIComponent(fileKey)}/components`, {
      headers: { "X-Figma-Token": options.token },
    });
    if (!res.ok) {
      throw new Error(`Figma REST API ${res.status} for library ${fileKey}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { meta?: { components?: RestComponent[] } };
    for (const c of body.meta?.components ?? []) {
      const setName = c.containing_frame?.containingComponentSet?.name ?? undefined;
      out.push({
        key: c.key,
        name: c.name,
        componentSetName: setName,
        variantProperties: setName ? parseVariantName(c.name) : undefined,
        description: c.description || undefined,
        source: "library",
        libraryName: fileKey,
      });
    }
  }
  return out;
}

/** Local components win over library ones with the same key. */
export function mergeIndexes(local: DsIndex, libraryComponents: DsComponent[]): DsIndex {
  const localKeys = new Set(local.components.map((c) => c.key).filter(Boolean));
  return { ...local, components: [...local.components, ...libraryComponents.filter((c) => !c.key || !localKeys.has(c.key))] };
}
