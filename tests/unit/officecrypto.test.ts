import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { IDBFactory } from "fake-indexeddb";
import { hash, sha1, sha512, spin, type HashName } from "../../src/core/importers/sha";
import { CfbError, readCfb } from "../../src/core/importers/cfb";
import { decryptXlsx, describeContainer, OfficeCryptoError } from "../../src/core/importers/officecrypto";
import { readXlsx, SpreadsheetError } from "../../src/core/importers/xlsx";
import { planSheet, planToImports } from "../../src/core/importers/mapping";
import { Session } from "../../src/core/session";
import { openStore } from "../../src/core/storage";

const inflate = async (d: Uint8Array<ArrayBuffer>) => new Uint8Array(inflateRawSync(d));
const fixture = (n: string) => new Uint8Array(readFileSync(new URL("../fixtures/" + n, import.meta.url)));
const PASSWORD = "Żółw-Tajny 2024!";
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

describe("sha", () => {
  it("SHA-512 and SHA-1 match WebCrypto across block boundaries", async () => {
    for (const n of [0, 1, 3, 55, 56, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 255, 1000, 4099]) {
      const data = new Uint8Array(n).map((_, i) => (i * 131 + n) & 0xff);
      expect(hex(sha512(data)), `sha512 ${n}`).toBe(hex(new Uint8Array(await crypto.subtle.digest("SHA-512", data))));
      expect(hex(sha1(data)), `sha1 ${n}`).toBe(hex(new Uint8Array(await crypto.subtle.digest("SHA-1", data))));
    }
  });
  it("SHA-256 and SHA-384 match WebCrypto too", async () => {
    for (const n of [0, 5, 55, 56, 64, 111, 112, 128, 999]) {
      const data = new Uint8Array(n).map((_, i) => (i * 7 + 3) & 0xff);
      for (const name of ["SHA-256", "SHA-384"] as HashName[]) expect(hex(hash(name, data)), `${name} ${n}`).toBe(hex(new Uint8Array(await crypto.subtle.digest(name, data))));
    }
  });
  it("every spin variant matches a WebCrypto loop", async () => {
    for (const name of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"] as HashName[]) {
      const first = new Uint8Array([9, 8, 7]);
      let h = new Uint8Array(await crypto.subtle.digest(name, first));
      for (let i = 0; i < 50; i++) {
        const buf = new Uint8Array(4 + h.length); new DataView(buf.buffer).setUint32(0, i, true); buf.set(h, 4);
        h = new Uint8Array(await crypto.subtle.digest(name, buf));
      }
      expect(hex(await spin(name, first, 50)), name).toBe(hex(h));
    }
  });
  it("the spin loop matches a WebCrypto loop", async () => {
    const first = new Uint8Array([1, 2, 3, 4]);
    let h = new Uint8Array(await crypto.subtle.digest("SHA-512", first));
    for (let i = 0; i < 300; i++) {
      const buf = new Uint8Array(4 + h.length); new DataView(buf.buffer).setUint32(0, i, true); buf.set(h, 4);
      h = new Uint8Array(await crypto.subtle.digest("SHA-512", buf));
    }
    expect(hex(await spin("SHA-512", first, 300))).toBe(hex(h));
    let s1 = new Uint8Array(await crypto.subtle.digest("SHA-1", first));
    for (let i = 0; i < 300; i++) {
      const buf = new Uint8Array(4 + s1.length); new DataView(buf.buffer).setUint32(0, i, true); buf.set(s1, 4);
      s1 = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
    }
    expect(hex(await spin("SHA-1", first, 300))).toBe(hex(s1));
    // SHA-256 goes through WebCrypto
    let g = new Uint8Array(await crypto.subtle.digest("SHA-256", first));
    for (let i = 0; i < 10; i++) {
      const buf = new Uint8Array(4 + g.length); new DataView(buf.buffer).setUint32(0, i, true); buf.set(g, 4);
      g = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    }
    expect(hex(await spin("SHA-256", first, 10))).toBe(hex(g));
  });
});

describe("password-protected spreadsheets", () => {
  it("recognises the container", () => {
    expect(describeContainer(fixture("protected-agile.xlsx"))).toBe("encrypted");
    expect(describeContainer(fixture("protected-standard.xlsx"))).toBe("encrypted");
    expect(describeContainer(fixture("sample.xlsx"))).toBe("other");
    const names = readCfb(fixture("protected-agile.xlsx")).entries.map(e => e.name);
    expect(names).toEqual(expect.arrayContaining(["EncryptionInfo", "EncryptedPackage"]));
  });

  for (const [file, producer] of [["protected-agile.xlsx", "Excel 2010+ (agile)"], ["protected-standard.xlsx", "Excel 2007 (standard)"], ["protected-libreoffice.xlsx", "LibreOffice"]] as const) {
    it(`opens a file protected by ${producer} and reads its tabs and pictures`, async () => {
      const progress: number[] = [];
      const plain = await decryptXlsx(fixture(file), PASSWORD, f => progress.push(f));
      expect(progress.at(-1)).toBe(1);
      const expected = fixture("pictures.xlsx");
      if (file !== "protected-libreoffice.xlsx") expect(hex(plain)).toBe(hex(expected));
      const sheets = await readXlsx(plain, inflate);
      expect(sheets.map(s => s.name)).toEqual(["Dom", "Zdrowie"]);
      expect(sheets[0].rows.map(r => r[0])).toEqual(["Nazwa", "Alarm", "Router", "Brama", "Skrytka"]);
      expect(sheets[0].pictures!.map(p => [p.row, p.mime])).toEqual([[1, "image/png"], [3, "image/jpeg"]]);
    });
  }

  it("rejects a wrong password without leaking anything", async () => {
    for (const f of ["protected-agile.xlsx", "protected-standard.xlsx", "protected-libreoffice.xlsx"]) {
      await expect(decryptXlsx(fixture(f), "zolw-tajny 2024!")).rejects.toMatchObject({ code: "password" });
    }
    await expect(decryptXlsx(fixture("protected-agile.xlsx"), "")).rejects.toBeInstanceOf(OfficeCryptoError);
  });

  it("a truncated file is reported as damaged, not as a wrong password", async () => {
    const b = fixture("protected-agile.xlsx");
    await expect(decryptXlsx(b.slice(0, 1024), PASSWORD)).rejects.toBeInstanceOf(Error);
  });
});

describe("pictures in spreadsheets", () => {
  it("floating pictures follow their row; a picture on a blank row joins the row above; in-cell pictures too", async () => {
    const sheets = await readXlsx(fixture("pictures.xlsx"), inflate);
    const [dom, zdrowie] = sheets;
    expect(zdrowie.rows[1]).toEqual(["NHS", "kamil@example.com", "nhs-pass", ""]); // the in-cell picture's #VALUE! is dropped
    expect(zdrowie.pictures!.map(p => [p.row, p.mime, p.name])).toEqual([[1, "image/png", "incell1.png"]]);
    const items = planToImports(planSheet(dom.name, dom.rows, dom.pictures));
    expect(items.map(i => [i.draft.title, i.pictures.length])).toEqual([["Alarm", 1], ["Router", 0], ["Brama", 1], ["Skrytka", 0]]);
    const png = items[0].pictures[0].bytes;
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const z = planToImports(planSheet(zdrowie.name, zdrowie.rows, zdrowie.pictures));
    expect(z.map(i => [i.draft.title, i.pictures.length, i.draft.fields?.length ?? 0])).toEqual([["NHS", 1, 0], ["Dentist", 0, 0]]);
  });

  it("imports pictures as encrypted attachments of their items", async () => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
    const s = new Session();
    await s.init(await openStore());
    await s.create("correct horse battery staple 9");
    const [dom] = await readXlsx(fixture("pictures.xlsx"), inflate);
    const items = planToImports(planSheet(dom.name, dom.rows, dom.pictures));
    const progress: [number, number][] = [];
    const r = await s.importItems(items.map(i => i.draft), items.map(i => i.pictures), (d, t) => progress.push([d, t]));
    expect(r).toEqual({ pictures: 2, skipped: 0 });
    expect(progress.at(-1)).toEqual([2, 2]);
    const alarm = s.vault!.items.find(i => i.title === "Alarm")!;
    expect(alarm.attachments).toHaveLength(1);
    const bytes = await s.attachmentBytes(alarm.attachments[0]);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(s.vault!.items.find(i => i.title === "Router")!.attachments).toHaveLength(0);
  });
});

// Patch same-length text inside the (uncompressed) EncryptionInfo stream of a protected file.
function patched(file: string, from: string, to: string): Uint8Array<ArrayBuffer> {
  expect(to.length).toBe(from.length);
  const b = fixture(file);
  const text = new TextDecoder("latin1").decode(b);
  const at = text.indexOf(from);
  expect(at, from).toBeGreaterThan(0);
  const out = b.slice();
  for (let i = 0; i < to.length; i++) out[at + i] = to.charCodeAt(i);
  return out;
}

describe("hostile or broken files", () => {
  it("corrupted compound-file headers fail fast instead of eating memory", () => {
    const good = fixture("protected-agile.xlsx");
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const t0 = Date.now();
    for (let n = 0; n < 300; n++) {
      const b = good.slice();
      for (let k = 0; k < 6; k++) {
        const at = 0x1c + (rnd() % (0x200 - 0x1c));
        new DataView(b.buffer).setUint32(at - (at % 4), [0xffffffff, 0x7fffffff, 0x0fffffff, 1, 0, rnd()][rnd() % 6], true);
      }
      try { const c = readCfb(b); c.stream("EncryptionInfo"); c.stream("EncryptedPackage"); }
      catch (e) { expect(e, String(e)).toBeInstanceOf(CfbError); }
    }
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("a listed allocation sector past the end of the file is rejected", () => {
    const b = fixture("protected-agile.xlsx").slice();
    const dv = new DataView(b.buffer);
    dv.setUint32(0x2c, 109, true);
    for (let i = 1; i < 109; i++) dv.setUint32(0x4c + i * 4, 0x00ffffff, true);
    expect(() => { const c = readCfb(b); c.stream("EncryptedPackage"); }).not.toThrow(RangeError);
  });

  it("unexpected key, block or hash sizes are refused before any work", async () => {
    await expect(decryptXlsx(patched("protected-agile.xlsx", 'keyBits="256"', 'keyBits="999"'), PASSWORD)).rejects.toMatchObject({ code: "unsupported" });
    await expect(decryptXlsx(patched("protected-agile.xlsx", 'blockSize="16"', 'blockSize="99"'), PASSWORD)).rejects.toMatchObject({ code: "unsupported" });
    await expect(decryptXlsx(patched("protected-agile.xlsx", 'hashAlgorithm="SHA512"', 'hashAlgorithm="SHA384"'), PASSWORD)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("a slow password check can be cancelled", async () => {
    const b = patched("protected-agile.xlsx", 'spinCount="100000"', 'spinCount="999999"');
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const t0 = Date.now();
    await expect(decryptXlsx(b, PASSWORD, undefined, ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("a zip bomb is refused", async () => {
    await expect(readXlsx(fixture("hostile/bomb.xlsx"), inflate)).rejects.toBeInstanceOf(SpreadsheetError);
  });

  it("row numbers past Excel's limit are ignored", async () => {
    const [dom] = await readXlsx(fixture("hostile/huge-row.xlsx"), inflate);
    expect(dom.rows.map(r => r[0])).toEqual(["Nazwa", "Alarm", "Router", "Brama"]);
  });

  it("rich values that aren't local pictures keep their text and add no picture", async () => {
    const [, z] = await readXlsx(fixture("hostile/web-image.xlsx"), inflate);
    expect(z.pictures).toEqual([]);
    expect(z.rows[1][3]).toBe("#VALUE!");
  });

  it("a picture on the blank row under the headings joins the first item", async () => {
    const [dom] = await readXlsx(fixture("hostile/picture-under-headings.xlsx"), inflate);
    const items = planToImports(planSheet(dom.name, dom.rows, dom.pictures));
    expect(items.map(i => [i.draft.title, i.pictures.length])).toEqual([["Alarm", 1], ["Router", 0], ["Brama", 1], ["Skrytka", 0]]);
  });

  it("a vault that locks during a picture import adds nothing", async () => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
    const s = new Session();
    await s.init(await openStore());
    await s.create("correct horse battery staple 9");
    const [dom] = await readXlsx(fixture("pictures.xlsx"), inflate);
    const items = planToImports(planSheet(dom.name, dom.rows, dom.pictures));
    const run = s.importItems(items.map(i => i.draft), items.map(i => i.pictures), () => s.lock("test"));
    await expect(run).rejects.toThrow(/locked/);
    await s.unlock("correct horse battery staple 9");
    expect(s.vault!.items).toHaveLength(0);
  });
});
