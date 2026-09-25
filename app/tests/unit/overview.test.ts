import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// docs/overview.html is the one-page project overview. The repo's _headers CSP
// (script-src 'self') applies to it when hosted, so it must work without scripts.
// Vitest runs from app/ (see DOCS.md).
const page = readFileSync(resolve(process.cwd(), "../docs/overview.html"), "utf-8");

describe("docs/overview.html", () => {
  it("has no scripts and only loads Google Fonts", () => {
    expect(page).not.toContain("<script");
    const hosts = new Set([...page.matchAll(/(?:href|src)="https?:\/\/([^/"]+)/g)].map((m) => m[1]));
    for (const h of hosts) expect(["fonts.googleapis.com", "fonts.gstatic.com"]).toContain(h);
  });

  it("defines every SVG marker it references", () => {
    const used = new Set([...page.matchAll(/url\(#([\w-]+)\)/g)].map((m) => m[1]));
    const defined = new Set([...page.matchAll(/<marker id="([\w-]+)"/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const id of used) expect(defined.has(id)).toBe(true);
  });

  it("supports both themes and opens exactly one phase", () => {
    expect(page).toContain("prefers-color-scheme:light");
    expect(page).toContain(':root[data-theme="light"]');
    expect(page.match(/<details class="pc/g)).toHaveLength(6);
    expect(page.match(/name="phase" open/g)).toHaveLength(1);
  });
});
