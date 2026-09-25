// Turns spreadsheet rows into vault items: detects known exports (Chrome, Bitwarden,
// 1Password, Firefox, this app's CSV), guesses columns in English and Polish, and keeps
// every unmapped column as a custom field so nothing in the source sheet is lost.

import { newId } from "../bytes";
import { type CustomField, type ItemDraft, type ItemType, UNCATEGORIZED } from "../model";
import type { SheetPicture } from "./xlsx";

export type Target = "title" | "username" | "password" | "url" | "notes" | "totp" | "category" | "favorite" | "type";
export const TARGETS: { id: Target; label: string }[] = [
  { id: "title", label: "Name" },
  { id: "username", label: "Username / email" },
  { id: "password", label: "Password" },
  { id: "url", label: "Website" },
  { id: "notes", label: "Notes" },
  { id: "totp", label: "2FA secret" },
  { id: "category", label: "Category column" },
];

export type Mapping = Partial<Record<Target, number>>;

export interface SheetPlan {
  name: string;
  rows: string[][];
  headerRow: number;        // index into rows
  mapping: Mapping;
  preset: string | null;    // detected export format
  include: boolean;
  type: ItemType;
  category: string;         // used when no category column
  keepExtra: boolean;       // unmapped columns -> custom fields
  pictures: SheetPicture[]; // row = index into rows
}

const norm = (h: string) => h.toLowerCase().replace(/^﻿/, "").replace(/[_\-./]+/g, " ").replace(/\s+/g, " ").trim()
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l");

const SYNONYMS: Record<Target, string[]> = {
  title: ["name", "title", "site", "service", "account", "app", "website name", "vendor", "provider", "company", "nazwa", "serwis", "konto", "tytul", "dostawca", "firma", "item", "entry"],
  username: ["username", "user name", "user", "login", "email", "e mail", "login username", "uzytkownik", "nazwa uzytkownika", "email address", "login name", "userid", "user id"],
  password: ["password", "pass", "pwd", "passwd", "login password", "haslo", "passcode"],
  url: ["url", "website", "web site", "login uri", "uri", "link", "address", "site url", "website url", "strona", "adres", "www"],
  notes: ["notes", "note", "comment", "comments", "description", "extra", "uwagi", "notatki", "notatka", "opis", "komentarz", "info"],
  totp: ["totp", "otp", "otpauth", "2fa", "login totp", "one time password", "authenticator", "mfa"],
  category: ["category", "folder", "group", "grouping", "kategoria", "grupa", "folder name"],
  favorite: ["favorite", "favourite", "starred", "ulubione"],
  type: ["type"],
};

const SECRET_WORDS = /\b(pin|cvv2?|cvc|puk|secret|passcode|answer|odpowiedz|odpowiedź|security (code|answer|question)|recovery( codes?| key)?|backup codes?|kod pin|kod zabezpieczajacy|private key)\b/i;
// Columns that known exports include but carry nothing worth keeping.
const IGNORED = new Set(["reprompt", "archived", "httprealm", "formactionorigin", "guid", "timecreated", "timelastused", "timepasswordchanged"]);

function findHeader(headers: string[], target: Target, taken: Set<number>): number {
  const hs = headers.map(norm);
  const syn = SYNONYMS[target];
  for (let i = 0; i < hs.length; i++) if (!taken.has(i) && syn.includes(hs[i])) return i;
  for (let i = 0; i < hs.length; i++) if (!taken.has(i) && hs[i] && syn.some(s => s.length > 3 && hs[i].includes(s))) return i;
  return -1;
}

function detectPreset(headers: string[]): string | null {
  const h = new Set(headers.map(norm));
  const has = (...k: string[]) => k.every(x => h.has(x));
  if (has("type", "category", "title", "username", "password", "totp")) return "Vault CSV";
  if (has("login uri", "login username", "login password")) return "Bitwarden";
  if (has("url", "username", "password", "httprealm")) return "Firefox";
  if (has("title", "username", "password") && (h.has("otpauth") || h.has("url"))) return "1Password";
  if (has("name", "url", "username", "password") && headers.length <= 6) return "Chrome";
  return null;
}

/** Guess the header row: the first row within the top 5 that looks like labels, not data. */
export function guessHeaderRow(rows: string[][]): number {
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const cells = rows[r].filter(c => c.trim());
    if (cells.length < 2) continue;
    const taken = new Set<number>();
    const hits = (["title", "username", "password", "url", "notes"] as Target[]).filter(t => findHeader(rows[r], t, taken) >= 0).length;
    if (hits >= 2) return r;
  }
  return 0;
}

export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  const taken = new Set<number>();
  for (const t of ["password", "username", "url", "totp", "notes", "category", "favorite", "type", "title"] as Target[]) {
    const i = findHeader(headers, t, taken);
    if (i >= 0) { m[t] = i; taken.add(i); }
  }
  if (m.title == null) {
    const first = headers.findIndex((_, i) => !taken.has(i));
    if (first >= 0) m.title = first; // sheets usually lead with the name, whatever it's called
  }
  return m;
}

export function planSheet(name: string, rows: string[][], pictures: SheetPicture[] = []): SheetPlan {
  const headerRow = guessHeaderRow(rows);
  const headers = rows[headerRow] ?? [];
  const mapping = guessMapping(headers);
  const hasPassword = mapping.password != null;
  return {
    name, rows, headerRow, mapping, preset: detectPreset(headers), include: true,
    type: hasPassword ? "login" : "note",
    category: name.replace(/\.(csv|tsv|txt)$/i, "").trim() || UNCATEGORIZED,
    keepExtra: true,
    pictures,
  };
}

export function withHeaderRow(plan: SheetPlan, headerRow: number): SheetPlan {
  const headers = plan.rows[headerRow] ?? [];
  const mapping = guessMapping(headers);
  return { ...plan, headerRow, mapping, preset: detectPreset(headers) };
}

export function dataRows(plan: SheetPlan): string[][] {
  return plan.rows.slice(plan.headerRow + 1);
}

const TRUE = /^(1|true|yes|tak|y|x|\*)$/i;
const TYPE_ALIASES: Record<string, ItemType> = { login: "login", note: "note", securenote: "note", card: "card", identity: "identity", bank: "bank" };

export function rowToDraft(plan: SheetPlan, row: string[]): ItemDraft | null {
  const get = (t: Target) => { const i = plan.mapping[t]; return i != null && i >= 0 ? (row[i] ?? "").trim() : ""; };
  const title = get("title");
  const password = get("password");
  const headers = plan.rows[plan.headerRow] ?? [];
  const mapped = new Set(Object.values(plan.mapping).filter((i): i is number => i != null && i >= 0));
  const extra: CustomField[] = [];
  if (plan.keepExtra) {
    row.forEach((raw, i) => {
      const v = (raw ?? "").trim();
      if (!v || mapped.has(i)) return;
      const label = (headers[i] ?? "").trim() || `Column ${i + 1}`;
      if (IGNORED.has(norm(label).replace(/\s+/g, ""))) return;
      if (norm(label) === "fields" && /^[^:\n]{1,60}: /m.test(v)) {
        // "label: value" lines, as written by this app's CSV export and Bitwarden
        for (const line of v.split(/\r?\n/)) {
          const m = /^([^:]{1,60}):\s?(.*)$/.exec(line);
          if (m && m[2]) extra.push({ id: newId(), label: m[1].trim(), value: m[2], hidden: SECRET_WORDS.test(m[1]) });
        }
        return;
      }
      extra.push({ id: newId(), label, value: v, hidden: SECRET_WORDS.test(label) });
    });
  }
  if (!title && !password && !get("username") && !get("notes") && extra.length === 0) return null;
  const typeRaw = get("type").toLowerCase().replace(/\s+/g, "");
  const type: ItemType = TYPE_ALIASES[typeRaw] ?? plan.type;
  return {
    type,
    title: title || get("username") || get("url") || "(untitled)",
    category: get("category") || plan.category,
    username: get("username"),
    password,
    url: get("url"),
    notes: get("notes"),
    totp: get("totp"),
    favorite: TRUE.test(get("favorite")),
    fields: extra,
  };
}

export interface PlannedItem { draft: ItemDraft; pictures: SheetPicture[] }

/** Items for a sheet, each with the pictures on its row. A picture on a row that yields no item joins the item above (or the first item). */
export function planToImports(plan: SheetPlan): PlannedItem[] {
  if (!plan.include) return [];
  const byRow = new Map<number, SheetPicture[]>();
  for (const p of plan.pictures) byRow.set(p.row, [...(byRow.get(p.row) ?? []), p]);
  const out: PlannedItem[] = [];
  let orphans: SheetPicture[] = [];
  plan.rows.forEach((row, i) => {
    // Pictures in or above the headings (a logo, say) are left out; ones on blank rows just under them join the first item.
    if (i < plan.headerRow) return;
    if (i === plan.headerRow) { orphans.push(...(byRow.get(i) ?? []).filter(p => p.below)); return; }
    const pics = byRow.get(i) ?? [];
    const draft = rowToDraft(plan, row);
    if (draft) { out.push({ draft, pictures: [...orphans, ...pics] }); orphans = []; }
    else if (out.length) out[out.length - 1].pictures.push(...pics);
    else orphans.push(...pics);
  });
  return out;
}

export function planToDrafts(plan: SheetPlan): ItemDraft[] {
  return planToImports(plan).map(p => p.draft);
}
