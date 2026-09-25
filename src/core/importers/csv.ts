// Delimited text import with separator sniffing. Polish/EU Excel writes ';', Chrome writes ','.

export const DELIMITERS = [",", ";", "\t", "|"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

function countOutsideQuotes(line: string, d: string): number {
  let n = 0, q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (!q && c === d) n++;
  }
  return n;
}

/** Picks the delimiter that splits the first lines most consistently. */
export function sniffDelimiter(text: string): Delimiter {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 20);
  let best: Delimiter = ",", bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map(l => countOutsideQuotes(l, d));
    if (!counts.length || counts[0] === 0) continue;
    const mode = counts[0];
    const consistent = counts.filter(c => c === mode).length / counts.length;
    const score = consistent * 100 + Math.min(mode, 50);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** RFC 4180-style parser: quoted fields, doubled quotes, embedded newlines, CRLF. */
export function parseDelimited(input: string, delimiter?: Delimiter): { rows: string[][]; delimiter: Delimiter } {
  const text = input.replace(/^﻿/, "");
  const d = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === "") q = true;
    else if (c === d) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return { rows: rows.filter(r => r.some(f => f.trim() !== "")), delimiter: d };
}

/** Quote a value for CSV output. */
export function csvCell(v: string): string {
  return /[",\r\n;]/.test(v) || /^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
