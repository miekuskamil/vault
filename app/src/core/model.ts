// Vault data model and pure operations. Every function returns a new Vault — no mutation —
// so saves, snapshots and undo stay predictable and unit-testable.

import { newId } from "./bytes";

export type ItemType = "login" | "bank" | "card" | "note" | "identity";
export const ITEM_TYPES: { id: ItemType; label: string }[] = [
  { id: "login", label: "Login" },
  { id: "bank", label: "Bank account" },
  { id: "card", label: "Card" },
  { id: "identity", label: "ID document" },
  { id: "note", label: "Secure note" },
];

export interface CustomField { id: string; label: string; value: string; hidden: boolean }
export interface AttachmentMeta { id: string; name: string; mime: string; size: number; width?: number; height?: number; addedAt: number }
export interface PasswordHistoryEntry { password: string; changedAt: number }

export interface ItemCore {
  id: string;
  type: ItemType;
  title: string;
  category: string;
  username: string;
  password: string;
  url: string;
  totp: string;
  notes: string;
  fields: CustomField[];
  attachments: AttachmentMeta[];
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  passwordChangedAt: number | null;
  lastUsedAt: number | null;
  history: PasswordHistoryEntry[];
  deletedAt: number | null;
}
/** Unknown keys are allowed and preserved, so data written by newer versions survives edits. */
export type Item = ItemCore & { [extra: string]: unknown };

export type SortMode = "category" | "az" | "recent" | "updated";
export interface VaultSettings {
  idleLockMin: number;       // auto-lock after inactivity
  leaveLockSec: number;      // lock after leaving the app (0 = immediately)
  clipboardSec: number;      // clear clipboard after (0 = never)
  sort: SortMode;
  lastBackupAt: number | null;
  [extra: string]: unknown;
}

export interface Vault {
  schema: 2;
  items: Item[];
  categoryOrder: string[];
  settings: VaultSettings;
  [extra: string]: unknown;
}

export const UNCATEGORIZED = "Uncategorized";
export const HISTORY_LIMIT = 5;
export const TRASH_DAYS = 30;
const DAY = 86_400_000;

export const DEFAULT_SETTINGS: VaultSettings = { idleLockMin: 5, leaveLockSec: 30, clipboardSec: 30, sort: "category", lastBackupAt: null };

export function emptyVault(): Vault {
  return { schema: 2, items: [], categoryOrder: [], settings: { ...DEFAULT_SETTINGS } };
}

/** Preset custom fields per item type, so bank/card/ID items open with the right slots. */
export function presetFields(type: ItemType): CustomField[] {
  const f = (label: string, hidden = false): CustomField => ({ id: newId(), label, value: "", hidden });
  switch (type) {
    case "bank": return [f("Account holder"), f("Account number"), f("Sort code"), f("IBAN"), f("SWIFT / BIC")];
    case "card": return [f("Cardholder"), f("Card number", true), f("Expiry"), f("CVV", true), f("PIN", true)];
    case "identity": return [f("Full name"), f("Document"), f("Number"), f("Issued"), f("Expires")];
    default: return [];
  }
}

export function hasLoginFields(type: ItemType): boolean {
  return type === "login" || type === "bank";
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Fill defaults and coerce types; unknown keys are kept so newer fields survive older code paths. */
export function normalizeItem(raw: Partial<Item> & Record<string, unknown>, now = Date.now()): Item {
  const type = (ITEM_TYPES.some(t => t.id === raw.type) ? raw.type : "login") as ItemType;
  return {
    ...raw,
    id: str(raw.id) || newId(),
    type,
    title: str(raw.title).trim() || "(untitled)",
    category: str(raw.category).trim() || UNCATEGORIZED,
    username: str(raw.username),
    password: str(raw.password),
    url: str(raw.url).trim(),
    totp: str(raw.totp).trim(),
    notes: str(raw.notes),
    fields: Array.isArray(raw.fields) ? raw.fields.map(f => ({ id: str(f?.id) || newId(), label: str(f?.label), value: str(f?.value), hidden: !!f?.hidden })) : [],
    attachments: Array.isArray(raw.attachments) ? raw.attachments.filter(a => a && typeof a.id === "string") : [],
    favorite: !!raw.favorite,
    createdAt: num(raw.createdAt) ?? now,
    updatedAt: num(raw.updatedAt) ?? now,
    passwordChangedAt: num(raw.passwordChangedAt),
    lastUsedAt: num(raw.lastUsedAt),
    history: Array.isArray(raw.history) ? raw.history.filter(h => h && typeof h.password === "string").slice(0, HISTORY_LIMIT) : [],
    deletedAt: num(raw.deletedAt),
  };
}

export function normalizeVault(raw: unknown): Vault {
  const v = (raw ?? {}) as Partial<Vault>;
  const items = Array.isArray(v.items) ? v.items.map(i => normalizeItem(i as Item)) : [];
  return {
    ...v,
    schema: 2,
    items,
    categoryOrder: Array.isArray(v.categoryOrder) ? v.categoryOrder.filter(c => typeof c === "string") : [],
    settings: { ...DEFAULT_SETTINGS, ...(v.settings ?? {}) },
  };
}

// ---------- item operations ----------

export type ItemDraft = Partial<Omit<ItemCore, "id" | "createdAt" | "updatedAt" | "history" | "deletedAt">> & { [extra: string]: unknown };

export function addItem(v: Vault, draft: ItemDraft, now = Date.now()): { vault: Vault; item: Item } {
  const item = normalizeItem({ ...draft, id: newId(), createdAt: now, updatedAt: now, passwordChangedAt: draft.password ? now : null, history: [], deletedAt: null }, now);
  return { vault: withCategory({ ...v, items: [...v.items, item] }, item.category), item };
}

/** Add many items at once (imports). Keeps provided timestamps; assigns new ids. */
export function addItems(v: Vault, drafts: ItemDraft[], now = Date.now()): Vault {
  const items = drafts.map(d => normalizeItem({ ...d, id: newId(), createdAt: num(d.createdAt) ?? now, updatedAt: now, deletedAt: null }, now));
  let out: Vault = { ...v, items: [...v.items, ...items] };
  for (const it of items) out = withCategory(out, it.category);
  return out;
}

/**
 * Update in place: keeps the item's position and any keys the patch doesn't mention.
 * A changed password is pushed onto history (newest first, capped).
 */
export function updateItem(v: Vault, id: string, patch: ItemDraft, now = Date.now()): Vault {
  let found = false;
  const items = v.items.map(it => {
    if (it.id !== id) return it;
    found = true;
    const next = normalizeItem({ ...it, ...patch, id: it.id, createdAt: it.createdAt, updatedAt: now }, now);
    if (patch.password !== undefined && patch.password !== it.password) {
      next.history = it.password ? [{ password: it.password, changedAt: it.passwordChangedAt ?? it.updatedAt }, ...it.history].slice(0, HISTORY_LIMIT) : it.history;
      next.passwordChangedAt = patch.password ? now : null;
    } else {
      next.history = it.history;
      next.passwordChangedAt = it.passwordChangedAt;
    }
    return next;
  });
  if (!found) throw new Error("Item not found");
  const updated = items.find(i => i.id === id)!;
  return withCategory({ ...v, items }, updated.category);
}

export function trashItems(v: Vault, ids: Iterable<string>, now = Date.now()): Vault {
  const set = new Set(ids);
  return { ...v, items: v.items.map(it => (set.has(it.id) && it.deletedAt == null ? { ...it, deletedAt: now } : it)) };
}

export function restoreItems(v: Vault, ids: Iterable<string>): Vault {
  const set = new Set(ids);
  return { ...v, items: v.items.map(it => (set.has(it.id) ? { ...it, deletedAt: null } : it)) };
}

/** Permanently remove items. Returns attachment ids that no longer belong to any item. */
export function purgeItems(v: Vault, ids: Iterable<string>): { vault: Vault; orphanedAttachments: string[] } {
  const set = new Set(ids);
  const orphaned = v.items.filter(it => set.has(it.id)).flatMap(it => it.attachments.map(a => a.id));
  return { vault: { ...v, items: v.items.filter(it => !set.has(it.id)) }, orphanedAttachments: orphaned };
}

export function expiredTrash(v: Vault, now = Date.now(), days = TRASH_DAYS): string[] {
  return v.items.filter(it => it.deletedAt != null && now - it.deletedAt >= days * DAY).map(it => it.id);
}

export function setFavorite(v: Vault, id: string, favorite: boolean): Vault {
  return { ...v, items: v.items.map(it => (it.id === id ? { ...it, favorite } : it)) };
}

export function setFavorites(v: Vault, ids: Iterable<string>, favorite: boolean): Vault {
  const set = new Set(ids);
  return { ...v, items: v.items.map(it => (set.has(it.id) ? { ...it, favorite } : it)) };
}

/** Records use without touching updatedAt (so "recently updated" stays honest). */
export function touchUsed(v: Vault, id: string, now = Date.now()): Vault {
  return { ...v, items: v.items.map(it => (it.id === id ? { ...it, lastUsedAt: now } : it)) };
}

export function moveItems(v: Vault, ids: Iterable<string>, category: string): Vault {
  const set = new Set(ids);
  const cat = category.trim() || UNCATEGORIZED;
  return withCategory({ ...v, items: v.items.map(it => (set.has(it.id) ? { ...it, category: cat } : it)) }, cat);
}

// ---------- categories ----------

function withCategory(v: Vault, cat: string): Vault {
  return v.categoryOrder.includes(cat) ? v : { ...v, categoryOrder: [...v.categoryOrder, cat] };
}

/** Categories that have at least one live item, in the user's order. */
export function categoriesOf(v: Vault): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const it of v.items) if (it.deletedAt == null) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
  const order = [...v.categoryOrder.filter(c => counts.has(c)), ...[...counts.keys()].filter(c => !v.categoryOrder.includes(c))];
  return order.map(name => ({ name, count: counts.get(name)! }));
}

export function renameCategory(v: Vault, from: string, to: string): Vault {
  const target = to.trim() || UNCATEGORIZED;
  if (target === from) return v;
  const items = v.items.map(it => (it.category === from ? { ...it, category: target } : it));
  const order = v.categoryOrder.includes(target)
    ? v.categoryOrder.filter(c => c !== from)
    : v.categoryOrder.map(c => (c === from ? target : c));
  return { ...v, items, categoryOrder: order };
}

// ---------- querying ----------

export interface Query { text?: string; category?: string | null; favoritesOnly?: boolean; ids?: Set<string> }

export function searchText(it: Item): string {
  return [it.title, it.username, it.url, it.notes, it.category, ...it.fields.flatMap(f => (f.hidden ? [f.label] : [f.label, f.value]))].join("\n").toLowerCase();
}

export function liveItems(v: Vault): Item[] {
  return v.items.filter(it => it.deletedAt == null);
}

export function queryItems(v: Vault, q: Query): Item[] {
  const text = (q.text ?? "").trim().toLowerCase();
  const terms = text ? text.split(/\s+/) : [];
  return liveItems(v).filter(it =>
    (!q.category || it.category === q.category) &&
    (!q.favoritesOnly || it.favorite) &&
    (!q.ids || q.ids.has(it.id)) &&
    (terms.length === 0 || (() => { const hay = searchText(it); return terms.every(t => hay.includes(t)); })()),
  );
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortItems(items: Item[], mode: SortMode, categoryOrder: string[] = []): Item[] {
  const arr = [...items];
  switch (mode) {
    case "az": return arr.sort((a, b) => collator.compare(a.title, b.title));
    case "recent": return arr.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || collator.compare(a.title, b.title));
    case "updated": return arr.sort((a, b) => b.updatedAt - a.updatedAt);
    case "category": {
      const rank = (c: string) => { const i = categoryOrder.indexOf(c); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
      return arr.sort((a, b) => rank(a.category) - rank(b.category)); // stable: keeps insertion order within a category
    }
  }
}

// ---------- merge (restore from another vault / backup) ----------

function signature(it: Item): string {
  return [it.type, it.title.trim().toLowerCase(), it.username.trim().toLowerCase(), it.password].join("\u0000");
}

/** Adds incoming live items not already present (same id, or same type+title+username+password). */
export function mergeVaults(base: Vault, incoming: Vault): { vault: Vault; added: Item[]; skipped: number } {
  const ids = new Set(base.items.map(i => i.id));
  const sigs = new Set(liveItems(base).map(signature));
  const added: Item[] = [];
  let skipped = 0;
  for (const it of liveItems(incoming)) {
    if (ids.has(it.id) || sigs.has(signature(it))) { skipped++; continue; }
    added.push(it);
    sigs.add(signature(it));
  }
  let vault: Vault = { ...base, items: [...base.items, ...added] };
  for (const it of added) vault = withCategory(vault, it.category);
  return { vault, added, skipped };
}

/** Attachment ids referenced anywhere in a vault (live or trashed). */
export function referencedAttachments(v: Vault): string[] {
  return v.items.flatMap(it => it.attachments.map(a => a.id));
}

// ---------- migration from the v1 single-file app ----------

interface V1Entry { id?: string; site?: string; username?: string; password?: string; url?: string; notes?: string; image?: string | null; favorite?: boolean; [k: string]: unknown }
interface V1Vault { categories?: { name?: string; entries?: V1Entry[] }[] }

export interface V1Image { itemId: string; dataUrl: string }

/** Converts the v1 {categories:[{name, entries}]} shape. Images come back separately to become encrypted attachments. */
export function migrateV1(raw: unknown, now = Date.now()): { vault: Vault; images: V1Image[] } {
  const v1 = (raw ?? {}) as V1Vault;
  let vault = emptyVault();
  const images: V1Image[] = [];
  for (const cat of v1.categories ?? []) {
    const name = str(cat?.name).trim() || UNCATEGORIZED;
    vault = withCategory(vault, name);
    for (const e of cat?.entries ?? []) {
      const { site, image, id: _oldId, ...rest } = e;
      void _oldId;
      const item = normalizeItem({
        ...rest,
        type: "login",
        title: str(site),
        category: name,
        username: str(e.username),
        password: str(e.password),
        url: str(e.url),
        notes: str(e.notes),
        favorite: !!e.favorite,
        createdAt: now,
        updatedAt: now,
        passwordChangedAt: null,
      }, now);
      vault = { ...vault, items: [...vault.items, item] };
      if (typeof image === "string" && image.startsWith("data:")) images.push({ itemId: item.id, dataUrl: image });
    }
  }
  return { vault, images };
}
