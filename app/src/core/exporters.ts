// Plaintext CSV export (the way out to another manager). Re-importable by this app ("Vault CSV" preset).

import { csvCell } from "./importers/csv";
import { liveItems, type Vault } from "./model";

export const CSV_COLUMNS = ["type", "category", "title", "username", "password", "url", "totp", "notes", "favorite", "fields"] as const;

export function toCsv(v: Vault): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const it of liveItems(v)) {
    const fields = it.fields.filter(f => f.value).map(f => `${f.label}: ${f.value}`).join("\n");
    rows.push([it.type, it.category, it.title, it.username, it.password, it.url, it.totp, it.notes, it.favorite ? "1" : "", fields].map(csvCell).join(","));
  }
  return "﻿" + rows.join("\r\n") + "\r\n";
}
