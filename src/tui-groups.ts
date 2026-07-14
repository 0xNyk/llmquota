import type { ProviderSnapshot } from "./types.js";
import { availability, type Avail } from "./tui-model.js";

export interface IndexedProvider {
  p: ProviderSnapshot;
  i: number;
}

const AVAIL_RANK: Record<Avail, number> = {
  ready: 0,
  soon: 1,
  limping: 2,
  tired: 3,
  unknown: 4,
  auth: 5,
  missing: 6,
};

export function providerRouteGroup(p: ProviderSnapshot): string {
  const raw = (p.activeProvider || p.id).trim().toLowerCase();
  if (/openai|codex|chatgpt/.test(raw)) return "OpenAI";
  if (/anthropic|claude/.test(raw)) return "Anthropic";
  if (/\bxai\b|x\.ai/.test(raw)) return "xAI";
  if (/cursor/.test(raw)) return "Cursor";
  if (/nous/.test(raw)) return "Nous";
  return p.activeProvider?.trim() || p.displayName.split(" · ")[0] || p.id;
}

/** Cluster shared routes while retaining the original snapshot and hit index. */
export function clusterProviderRoutes(items: IndexedProvider[]): IndexedProvider[] {
  const groups = new Map<string, IndexedProvider[]>();
  for (const item of items) {
    const key = providerRouteGroup(item.p);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const ranked = [...groups.entries()].map(([key, members]) => ({
    key,
    members: members.sort((a, b) => AVAIL_RANK[availability(a.p)] - AVAIL_RANK[availability(b.p)] || a.i - b.i),
    rank: Math.min(...members.map(({ p }) => AVAIL_RANK[availability(p)])),
    first: Math.min(...members.map(({ i }) => i), 1e9),
  }));
  ranked.sort((a, b) => a.rank - b.rank || a.first - b.first || a.key.localeCompare(b.key));
  return ranked.flatMap((group) => group.members);
}

export function sharedRouteGroups(items: IndexedProvider[]): Array<{ provider: string; names: string[] }> {
  const groups = new Map<string, string[]>();
  for (const { p } of items) {
    const provider = providerRouteGroup(p);
    const names = groups.get(provider) || [];
    const name = p.displayName.split(" · ")[0] || p.displayName;
    if (!names.includes(name)) names.push(name);
    groups.set(provider, names);
  }
  return [...groups.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([provider, names]) => ({ provider, names }));
}
