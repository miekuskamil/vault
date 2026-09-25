// Reader for the OLE "compound file" container. A password-protected .xlsx is one of these,
// holding two streams: EncryptionInfo (how the key is made) and EncryptedPackage (the real .xlsx).
// Old binary .xls files use the same container with a "Workbook" stream instead.

const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAXREG = 0xfffffffa; // sector numbers above this are markers (end of chain, free, …)

export class CfbError extends Error { constructor(msg: string) { super(msg); this.name = "CfbError"; } }

export interface CfbEntry { name: string; type: number; start: number; size: number }
export interface Cfb { entries: CfbEntry[]; stream(name: string): Uint8Array<ArrayBuffer> | null }

export function isCfb(b: Uint8Array): boolean {
  return b.length >= 512 && SIG.every((v, i) => b[i] === v);
}

export function readCfb(b: Uint8Array<ArrayBuffer>): Cfb {
  if (!isCfb(b)) throw new CfbError("Not a compound file");
  const damaged = () => new CfbError("The file is damaged.");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (o: number) => { if (o + 4 > b.length) throw damaged(); return dv.getUint32(o, true); };
  const shift = dv.getUint16(0x1e, true);
  if (shift !== 9 && shift !== 12) throw damaged();
  const secSize = 1 << shift;
  const MINI_SIZE = 64;
  if (dv.getUint16(0x20, true) !== 6 || u32(0x38) !== 4096) throw damaged();
  const cutoff = 4096;
  const dirStart = u32(0x30);
  const miniFatStart = u32(0x3c);
  // Every sector number must point inside the file; this also bounds every allocation below by the file size.
  const nSectors = Math.floor((b.length - secSize) / secSize) + (b.length % secSize ? 1 : 0);
  const secOff = (s: number) => (s + 1) * secSize;
  const valid = (s: number) => s < nSectors;

  // Which sectors hold the allocation table (header list, then chained DIFAT sectors).
  const nFat = Math.min(u32(0x2c), nSectors);
  const fatSecs: number[] = [];
  const seenFat = new Set<number>();
  const addFat = (v: number) => { if (v < MAXREG && valid(v) && !seenFat.has(v) && fatSecs.length < nFat) { seenFat.add(v); fatSecs.push(v); } };
  for (let i = 0; i < 109; i++) addFat(u32(0x4c + i * 4));
  const seenDifat = new Set<number>();
  for (let difat = u32(0x44); difat < MAXREG && fatSecs.length < nFat;) {
    if (!valid(difat) || seenDifat.has(difat)) throw damaged();
    seenDifat.add(difat);
    const off = secOff(difat);
    for (let j = 0; j < secSize / 4 - 1; j++) addFat(u32(off + j * 4));
    difat = u32(off + secSize - 4);
  }
  const per = secSize / 4;
  const fat = new Uint32Array(fatSecs.length * per);
  fatSecs.forEach((s, k) => { const off = secOff(s); for (let j = 0; j < per && off + j * 4 + 4 <= b.length; j++) fat[k * per + j] = dv.getUint32(off + j * 4, true); });

  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s < MAXREG; s = table[s]) {
      if (s >= table.length || s >= limit || seen.has(s)) throw damaged();
      seen.add(s); out.push(s);
    }
    return out;
  };
  const readChain = (start: number, size?: number): Uint8Array<ArrayBuffer> => {
    const secs = chain(start, fat, nSectors);
    if (size != null && secs.length * secSize < size) throw damaged();
    const out = new Uint8Array(size != null ? Math.min(secs.length * secSize, Math.ceil(size / secSize) * secSize) : secs.length * secSize);
    for (let i = 0; i * secSize < out.length; i++) out.set(b.subarray(secOff(secs[i]), Math.min(b.length, secOff(secs[i]) + secSize)), i * secSize);
    return size == null ? out : out.slice(0, size);
  };

  const dir = readChain(dirStart);
  const ddv = new DataView(dir.buffer);
  const entries: CfbEntry[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const type = dir[o + 0x42];
    if (type === 0) continue;
    const nameLen = Math.min(64, ddv.getUint16(o + 0x40, true));
    let name = "";
    for (let i = 0; i + 1 < nameLen - 1; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true));
    entries.push({ name, type, start: ddv.getUint32(o + 0x74, true), size: ddv.getUint32(o + 0x78, true) });
  }
  const root = entries.find(e => e.type === 5);

  let mini: { stream: Uint8Array<ArrayBuffer>; fat: Uint32Array } | null = null;
  const miniParts = () => {
    if (mini) return mini;
    if (!root) throw damaged();
    const stream = root.start < MAXREG ? readChain(root.start, Math.min(root.size, nSectors * secSize)) : new Uint8Array(0);
    const raw = miniFatStart < MAXREG ? readChain(miniFatStart) : new Uint8Array(0);
    const mfat = new Uint32Array(raw.length / 4);
    const mdv = new DataView(raw.buffer);
    for (let i = 0; i < mfat.length; i++) mfat[i] = mdv.getUint32(i * 4, true);
    return (mini = { stream, fat: mfat });
  };

  return {
    entries,
    stream(name: string) {
      const e = entries.find(x => x.type === 2 && x.name === name);
      if (!e) return null;
      if (e.size > b.length) throw damaged();
      if (e.size >= cutoff) return readChain(e.start, e.size);
      const m = miniParts();
      const secs = chain(e.start, m.fat, Math.floor(m.stream.length / MINI_SIZE));
      if (secs.length * MINI_SIZE < e.size) throw damaged();
      const out = new Uint8Array(secs.length * MINI_SIZE);
      secs.forEach((s, i) => out.set(m.stream.subarray(s * MINI_SIZE, s * MINI_SIZE + MINI_SIZE), i * MINI_SIZE));
      return out.slice(0, e.size);
    },
  };
}
