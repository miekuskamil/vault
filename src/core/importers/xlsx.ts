// Minimal .xlsx reader: ZIP (stored/deflate via the browser's DecompressionStream) + SpreadsheetML.
// Replaces the 640 KB SheetJS 0.18.5 bundle (known CVEs) with ~200 lines we control.
// Reads cell text only: shared strings, inline strings, numbers, booleans, formula results.

export class SpreadsheetError extends Error {
  constructor(public code: "encrypted" | "legacy" | "notzip" | "unsupported" | "empty", msg: string) { super(msg); this.name = "SpreadsheetError"; }
}

/** A picture found in the sheet, tied to the row (index into `rows`) it sits on. */
export interface SheetPicture { row: number; below?: boolean; name: string; mime: string; bytes: Uint8Array<ArrayBuffer> }
export interface Sheet { name: string; rows: string[][]; pictures?: SheetPicture[] }
export type Inflate = (data: Uint8Array<ArrayBuffer>, maxBytes: number) => Promise<Uint8Array<ArrayBuffer>>;

// Limits that keep a hostile or broken file from exhausting a phone's memory.
const MAX_PART_BYTES = 64 * 1024 * 1024;   // one sheet's XML, one picture
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // everything unpacked from one file
const MAX_CELLS = 4_000_000;
const MAX_PICTURES = 300;
const MAX_ROWS = 1_048_576, MAX_COLS = 16_384; // Excel's own limits
const tooLarge = () => new SpreadsheetError("unsupported", "This spreadsheet is too large to open here. Split it or save it as CSV.");

export const inflateRaw: Inflate = async (data, maxBytes) => {
  if (typeof DecompressionStream === "undefined") throw new SpreadsheetError("unsupported", "This browser can't open .xlsx files. Save the sheet as CSV instead.");
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw tooLarge(); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};

const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** OLE/CFB container: a password-protected .xlsx or an old binary .xls. */
export function isCfb(b: Uint8Array): boolean {
  return b.length > 8 && CFB.every((v, i) => b[i] === v);
}

interface ZipEntry { name: string; method: number; flags: number; compSize: number; size: number; offset: number }

function readZip(b: Uint8Array): Map<string, ZipEntry> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new SpreadsheetError("notzip", "This doesn't look like an .xlsx file.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff) throw new SpreadsheetError("unsupported", "This spreadsheet is too large to open here. Save it as CSV instead.");
  const entries = new Map<string, ZipEntry>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new SpreadsheetError("notzip", "The spreadsheet file is damaged.");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    entries.set(name.replace(/^\/+/, ""), { name, method, flags, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function entryBytes(b: Uint8Array<ArrayBuffer>, e: ZipEntry, inflate: Inflate, budget: { left: number }): Promise<Uint8Array<ArrayBuffer>> {
  if (e.size > MAX_PART_BYTES || e.size > budget.left) throw tooLarge();
  if (e.flags & 1) throw new SpreadsheetError("encrypted", "This spreadsheet is password-protected.");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new SpreadsheetError("notzip", "The spreadsheet file is damaged.");
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const data = b.slice(start, start + e.compSize);
  const out = e.method === 0 ? data : e.method === 8 ? await inflate(data, Math.min(MAX_PART_BYTES, budget.left)) : null;
  if (out) { budget.left -= out.length; if (budget.left < 0) throw tooLarge(); return out; }
  throw new SpreadsheetError("unsupported", "This spreadsheet uses a compression this app can't read. Save it as CSV instead.");
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new SpreadsheetError("unsupported", "The spreadsheet file is damaged.");
  return doc;
}
const all = (n: Document | Element, tag: string) => Array.from(n.getElementsByTagNameNS("*", tag));
const attr = (el: Element, name: string) => el.getAttribute(name) ?? el.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", name.replace(/^r:/, "")) ?? null;

/** Text of <t> nodes, skipping phonetic runs (<rPh>). */
function richText(el: Element): string {
  return all(el, "t").filter(t => !(t.parentElement && t.parentElement.localName === "rPh")).map(t => t.textContent ?? "").join("");
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Resolve a relationship target against the folder of the part that references it. */
function resolveRel(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const out: string[] = [];
  for (const p of (baseDir + "/" + target).split("/")) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
  return out.join("/");
}
const resolveTarget = (target: string) => (target.replace(/^\/+/, "").startsWith("xl/") ? target.replace(/^\/+/, "") : resolveRel("xl", target));
const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");
const relsPathOf = (path: string) => `${dirOf(path)}/_rels/${path.split("/").pop()}.rels`;

const PICTURE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
const pictureMime = (path: string) => PICTURE_TYPES[(path.split(".").pop() ?? "").toLowerCase()] ?? null;

function numberText(v: string): string {
  // Excel stores 12345678 as "12345678" but some writers use "1.2345678E7" or float noise.
  if (/^-?\d+$/.test(v)) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return BigInt(Math.round(n)).toString();
  return String(Number(n.toPrecision(15)));
}

export async function readXlsx(input: Uint8Array<ArrayBuffer>, inflate: Inflate = inflateRaw): Promise<Sheet[]> {
  if (isCfb(input)) throw new SpreadsheetError("encrypted", "This spreadsheet is password-protected (or an old .xls file).");
  const zip = readZip(input);
  const budget = { left: MAX_TOTAL_BYTES };
  const raw = async (path: string) => { const e = zip.get(path); return e ? entryBytes(input, e, inflate, budget) : null; };
  const text = async (path: string) => { const b = await raw(path); return b ? new TextDecoder().decode(b) : null; };
  const relsOf = async (part: string) => {
    const m = new Map<string, string>();
    const xml = await text(relsPathOf(part));
    if (xml) for (const r of all(parseXml(xml), "Relationship")) if (r.getAttribute("TargetMode") !== "External") m.set(r.getAttribute("Id") ?? "", resolveRel(dirOf(part), r.getAttribute("Target") ?? ""));
    return m;
  };

  const wbXml = await text("xl/workbook.xml");
  if (!wbXml) throw new SpreadsheetError("notzip", "This doesn't look like an .xlsx file.");
  const rels = new Map<string, string>();
  const relsXml = await text("xl/_rels/workbook.xml.rels");
  if (relsXml) for (const r of all(parseXml(relsXml), "Relationship")) rels.set(r.getAttribute("Id") ?? "", resolveTarget(r.getAttribute("Target") ?? ""));

  const shared: string[] = [];
  const ssXml = await text("xl/sharedStrings.xml");
  if (ssXml) for (const si of all(parseXml(ssXml), "si")) shared.push(richText(si));

  const inCell = await inCellPictures(text);
  const media = new Map<string, Uint8Array<ArrayBuffer> | null>();
  let pictureCount = 0;
  const picture = async (path: string, row: number, below: boolean): Promise<SheetPicture | null> => {
    const mime = pictureMime(path);
    if (!mime || pictureCount >= MAX_PICTURES) return null;
    pictureCount++;
    if (!media.has(path)) media.set(path, await raw(path).catch(() => null));
    const bytes = media.get(path);
    return bytes ? { row, below, name: path.split("/").pop() ?? "picture", mime, bytes } : null;
  };

  const sheets: Sheet[] = [];
  const sheetEls = all(parseXml(wbXml), "sheet");
  for (let idx = 0; idx < sheetEls.length; idx++) {
    const s = sheetEls[idx];
    if ((s.getAttribute("state") ?? "") === "veryHidden") continue;
    const rid = attr(s, "r:id") ?? "";
    const path = rels.get(rid) ?? `xl/worksheets/sheet${idx + 1}.xml`;
    const xml = await text(path);
    if (!xml) continue;
    const doc = parseXml(xml);
    const rowMap = new Map<number, string[]>();
    const pics: { row: number; path: string }[] = [];
    let nextRow = 0;
    let cellCount = 0;
    for (const rowEl of all(doc, "row")) {
      const r = rowEl.getAttribute("r");
      const ri = r ? Number(r) - 1 : nextRow;
      if (!Number.isInteger(ri) || ri < 0 || ri >= MAX_ROWS) continue;
      nextRow = ri + 1;
      const cells: string[] = [];
      let nextCol = 0;
      for (const c of Array.from(rowEl.children).filter(ch => ch.localName === "c")) {
        const ref = c.getAttribute("r");
        const ci = ref ? colIndex(ref) : nextCol;
        if (ci < 0 || ci >= MAX_COLS) continue;
        nextCol = ci + 1;
        const t = c.getAttribute("t") ?? "n";
        const vm = c.getAttribute("vm");
        const pic = vm ? inCell.get(Number(vm)) : undefined;
        if (pic) pics.push({ row: ri, path: pic }); // "Place in cell" picture: the cell itself only holds an error value
        const v = Array.from(c.children).find(ch => ch.localName === "v")?.textContent ?? "";
        let value = "";
        if (pic) value = "";
        else if (t === "s") value = shared[Number(v)] ?? "";
        else if (t === "inlineStr") { const is = Array.from(c.children).find(ch => ch.localName === "is"); value = is ? richText(is) : ""; }
        else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (t === "str" || t === "e") value = v;
        else value = v === "" ? "" : numberText(v);
        if (value === "" && !pic && t !== "s" && t !== "inlineStr") {
          const f = Array.from(c.children).find(ch => ch.localName === "f")?.textContent;
          if (f) value = "=" + f; // formula saved without a cached result
        }
        if (ci >= cells.length) { cellCount += ci + 1 - cells.length; if (cellCount > MAX_CELLS) throw tooLarge(); }
        while (cells.length < ci) cells.push("");
        cells[ci] = value;
      }
      rowMap.set(ri, cells);
    }

    // Floating pictures: sheet -> drawing -> anchors -> media.
    const drawingEl = all(doc, "drawing")[0];
    if (drawingEl) {
      const sheetRels = await relsOf(path);
      const drawingPath = sheetRels.get(attr(drawingEl, "r:id") ?? "");
      const dXml = drawingPath ? await text(drawingPath) : null;
      if (drawingPath && dXml) {
        const dRels = await relsOf(drawingPath);
        const ddoc = parseXml(dXml);
        for (const anchor of [...all(ddoc, "twoCellAnchor"), ...all(ddoc, "oneCellAnchor")]) {
          const from = Array.from(anchor.children).find(ch => ch.localName === "from");
          const to = Array.from(anchor.children).find(ch => ch.localName === "to");
          const num = (el: Element | undefined, tag: string) => Number(el ? all(el, tag)[0]?.textContent ?? "0" : "0");
          let row = num(from, "row");
          if (!Number.isInteger(row) || row < 0 || row >= MAX_ROWS) continue;
          // A picture starting low in a row usually belongs to the row below it.
          if (to && num(to, "row") > row && num(from, "rowOff") > 95250) row += 1;
          for (const blip of all(anchor, "blip")) {
            const target = dRels.get(blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ?? blip.getAttribute("r:embed") ?? "");
            if (target) pics.push({ row, path: target });
          }
        }
      }
    }

    // Rows with text become items. A picture on a blank row belongs to the nearest row above it
    // (flagged `below`, so the importer can tell a picture under the headings from one in them).
    const textRows = [...rowMap.keys()].filter(i => rowMap.get(i)!.some(x => (x ?? "").trim() !== "")).sort((a, b) => a - b);
    const finalRows = textRows.map(i => rowMap.get(i)!.map(x => x ?? ""));
    const indexOfRow = new Map(textRows.map((r, k) => [r, k]));
    const finalPics: SheetPicture[] = [];
    for (const p of pics) {
      let k = indexOfRow.get(p.row) ?? -1;
      let below = false;
      if (k < 0) {
        let lo = 0, hi = textRows.length - 1, above = -1; // last text row before p.row
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (textRows[mid] < p.row) { above = mid; lo = mid + 1; } else hi = mid - 1; }
        if (above >= 0) { k = above; below = true; } else if (textRows.length) k = 0;
      }
      if (k < 0) continue;
      const pic = await picture(p.path, k, below);
      if (pic) finalPics.push(pic);
    }
    if (finalRows.length) sheets.push({ name: s.getAttribute("name") ?? `Sheet ${idx + 1}`, rows: finalRows, pictures: finalPics });
  }
  if (!sheets.length) throw new SpreadsheetError("empty", "Every sheet in this file is empty.");
  return sheets;
}

/**
 * Excel 365 "Place in cell" pictures: cell vm="n" -> metadata.xml -> rich value -> richValueRel -> media.
 * Returns a map from the cell's vm number (1-based) to the media path.
 */
async function inCellPictures(text: (p: string) => Promise<string | null>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const metaXml = await text("xl/metadata.xml");
  const rvXml = await text("xl/richData/rdrichvalue.xml");
  const relXml = await text("xl/richData/richValueRel.xml");
  if (!metaXml || !rvXml || !relXml) return out;
  try {
    const meta = parseXml(metaXml);
    const types = all(meta, "metadataType").map(e => e.getAttribute("name") ?? "");
    const future = all(meta, "futureMetadata").find(e => e.getAttribute("name") === "XLRICHVALUE");
    const futureBks = future ? Array.from(future.children).filter(c => c.localName === "bk") : [];
    const rvIndexOfFuture = futureBks.map(bk => Number(all(bk, "rvb")[0]?.getAttribute("i") ?? NaN));
    const valueBks = all(meta, "valueMetadata")[0] ? Array.from(all(meta, "valueMetadata")[0].children).filter(c => c.localName === "bk") : [];

    const structXml = await text("xl/richData/rdrichvaluestructure.xml");
    const structs = structXml ? all(parseXml(structXml), "s").map(s => Array.from(s.children).filter(k => k.localName === "k").map(k => k.getAttribute("n") ?? "")) : [];
    const rvs = all(parseXml(rvXml), "rv");
    const relIds = all(parseXml(relXml), "rel").map(r => r.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? r.getAttribute("r:id") ?? "");
    const relTargets = new Map<string, string>();
    const relsXml = await text("xl/richData/_rels/richValueRel.xml.rels");
    if (relsXml) for (const r of all(parseXml(relsXml), "Relationship")) relTargets.set(r.getAttribute("Id") ?? "", resolveRel("xl/richData", r.getAttribute("Target") ?? ""));

    valueBks.forEach((bk, i) => {
      const rc = all(bk, "rc")[0];
      if (!rc) return;
      if (types[Number(rc.getAttribute("t")) - 1] !== "XLRICHVALUE") return;
      const rvIndex = rvIndexOfFuture[Number(rc.getAttribute("v"))];
      const rv = rvs[rvIndex];
      if (!rv) return;
      const keys = structs[Number(rv.getAttribute("s") ?? 0)] ?? [];
      const vals = Array.from(rv.children).filter(c => c.localName === "v").map(c => c.textContent ?? "");
      const k = keys.indexOf("_rvRel:LocalImageIdentifier");
      if (k < 0) return; // a web image, stock, map or other rich value: keep the cell text
      const relIndex = Number(vals[k]);
      const target = relTargets.get(relIds[relIndex] ?? "");
      if (target) out.set(i + 1, target);
    });
  } catch { /* pictures are a bonus; the text still imports */ }
  return out;
}
