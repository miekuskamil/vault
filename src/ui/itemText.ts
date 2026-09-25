import { hasLoginFields, type Item } from "../core/model";
import { host } from "./util";

export function fieldValue(it: Item, re: RegExp): string {
  return it.fields.find(f => re.test(f.label) && f.value)?.value ?? "";
}

export function last4(v: string): string {
  const d = v.replace(/\D/g, "");
  return d.length >= 4 ? "•••• " + d.slice(-4) : "";
}

export function subtitle(it: Item): string {
  switch (it.type) {
    case "card": return last4(fieldValue(it, /card number|number|numer/i)) || fieldValue(it, /cardholder|name/i) || it.category;
    case "identity": return fieldValue(it, /document|number|numer/i) || fieldValue(it, /name|imie/i) || it.category;
    case "note": return it.notes.split("\n").find(l => l.trim())?.trim() || it.fields.find(f => f.value && !f.hidden)?.value || "Secure note";
    default: return it.username || (it.url ? host(it.url) : "") || fieldValue(it, /account|konto/i) || it.notes.split("\n").find(l => l.trim())?.trim() || it.fields.find(f => f.value && !f.hidden)?.value || "";
  }
}

/** What the row's copy button copies. */
export function quickCopy(it: Item): { value: string; label: string } | null {
  if (hasLoginFields(it.type) && it.password) return { value: it.password, label: "Password" };
  if (it.type === "card") { const n = fieldValue(it, /card number/i); if (n) return { value: n.replace(/\s+/g, ""), label: "Card number" }; }
  if (it.username) return { value: it.username, label: "Username" };
  const f = it.fields.find(x => x.value);
  return f ? { value: f.value, label: f.label || "Value" } : null;
}
