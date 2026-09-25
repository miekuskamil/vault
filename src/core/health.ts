// Password health: weak, reused and old passwords across live items.

import { hasLoginFields, liveItems, type Item, type Vault } from "./model";
import { estimate } from "./strength";

export const OLD_AFTER_DAYS = 365;

export interface HealthReport {
  checked: number;
  weak: Item[];
  reused: Item[][];     // groups sharing one password, largest first
  old: Item[];
  flagged: Set<string>;
  score: number;        // 0-100, share of checked items with no issue
}

export function analyzeHealth(v: Vault, now = Date.now()): HealthReport {
  const withPw = liveItems(v).filter(it => hasLoginFields(it.type) && it.password);
  const weak = withPw.filter(it => estimate(it.password, [it.title, it.username, it.url]).score <= 1);
  const groups = new Map<string, Item[]>();
  for (const it of withPw) { const g = groups.get(it.password) ?? []; g.push(it); groups.set(it.password, g); }
  const reused = [...groups.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length);
  const old = withPw.filter(it => it.passwordChangedAt != null && now - it.passwordChangedAt > OLD_AFTER_DAYS * 86_400_000);
  const flagged = new Set<string>([...weak, ...reused.flat(), ...old].map(i => i.id));
  const score = withPw.length ? Math.round(100 * (1 - flagged.size / withPw.length)) : 100;
  return { checked: withPw.length, weak, reused, old, flagged, score };
}
