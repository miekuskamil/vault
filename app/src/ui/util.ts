import { useEffect, useState, useSyncExternalStore } from "react";
import { session, type SessionState } from "../core/session";
import { toasts } from "../core/toasts";

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState);
}

export function useToast() {
  return useSyncExternalStore(toasts.subscribe, toasts.get);
}

/** Re-render every `ms` (for countdowns and relative times). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// Categories get colours in the order they appear, so the first eight never share one.
let catOrder = new Map<string, number>();
export function setCategoryOrder(names: string[]) {
  if (names.length === catOrder.size && names.every((n, i) => catOrder.get(n) === i)) return;
  catOrder = new Map(names.map((n, i) => [n, i]));
}

export function catIndex(name: string): number {
  const at = catOrder.get(name);
  if (at != null) return at % 8;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 8;
}
export const catClass = (name: string) => "cat-" + catIndex(name);

export function initials(title: string): string {
  const s = title.trim();
  if (!s) return "?";
  const words = s.split(/[\s\-_.@]+/).filter(Boolean);
  if (words.length >= 2 && /\p{L}|\d/u.test(words[1][0])) return (words[0][0] + words[1][0]).toUpperCase();
  return [...s].filter(c => /\p{L}|\d/u.test(c)).slice(0, 2).join("").toUpperCase() || s[0].toUpperCase();
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const d = now - ts;
  const m = Math.round(d / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days === 1) return "yesterday";
  if (days < 45) return `${days} days ago`;
  const months = Math.round(days / 30.4);
  if (months < 18) return `${months} months ago`;
  return `${Math.round(months / 12)} years ago`;
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Display host for a URL-ish string. */
export function host(url: string): string {
  try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "https://" + url).host.replace(/^www\./, ""); } catch { return url; }
}

/** Only http(s)/mailto become links — javascript:, data: etc. stay inert text (v1 hardening kept). */
export function safeHref(url: string): string | null {
  const t = url.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : /^[\w-]+(\.[\w-]+)+/.test(t) ? "https://" + t : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    return ["http:", "https:", "mailto:"].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

/** Split notes into text and safe links (http/https only). */
export function linkify(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = [];
  const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    const href = safeHref(m[0]);
    out.push(href ? { text: m[0], href } : { text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Android share sheet when available (Drive, Gmail…), download otherwise. Returns how it went. */
export async function shareOrDownload(blob: Blob, name: string, title: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([blob], name, { type: "application/octet-stream" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    session.suppressLock();
    try { await nav.share({ files: [file], title }); return "shared"; }
    catch (e) { if ((e as Error).name === "AbortError") return "cancelled"; }
    finally { session.endSuppress(); }
  }
  download(blob, name);
  return "downloaded";
}

/** Open a file picker without the app-switch lock kicking in. */
export function pickFiles(accept: string, multiple = false, capture?: string): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute("capture", capture);
    input.style.display = "none";
    let settled = false;
    const done = (files: File[]) => { if (settled) return; settled = true; session.endSuppress(); input.remove(); resolve(files); };
    input.addEventListener("change", () => done(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => done([]));
    document.body.appendChild(input);
    session.suppressLock();
    input.click();
  });
}

export function readText(file: File): Promise<string> { return file.text(); }

const THEME_KEY = "pwvault_theme";
export type ThemePref = "system" | "dark" | "light";
/** Dark by default (as before); "Match phone" and Light are options in Settings. */
export function getThemePref(): ThemePref {
  try { const t = localStorage.getItem(THEME_KEY); return t === "system" || t === "light" ? t : "dark"; } catch { return "dark"; }
}
export function applyTheme(pref: ThemePref = getThemePref()) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", pref);
  const light = pref === "light" || (pref === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#f3f4f8" : "#0e1014");
}
export function setThemePref(pref: ThemePref) {
  try { if (pref === "dark") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, pref); } catch { /* ignore */ }
  applyTheme(pref);
}
