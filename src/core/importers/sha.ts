// Small synchronous SHA-1/256/384/512, used only for the Office password "spin"
// (100,000 chained hashes). Awaiting WebCrypto 100k times takes several seconds on a phone;
// this runs the same loop in a fraction of a second. Checked against WebCrypto in unit tests.

// SHA-512 round constants and initial state, as 32-bit (hi, lo) pairs.
const K = new Int32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);
const IV512 = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];

const IV384 = [0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
  0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4];
const IV256 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV1 = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];

const TWO32 = 4294967296;

function block512(H: Int32Array, W: Int32Array, dv: DataView, off: number): void {
  for (let i = 0; i < 32; i++) W[i] = dv.getInt32(off + i * 4);
  for (let i = 32; i < 160; i += 2) {
    let h = W[i - 30], l = W[i - 29];
    const s0h = ((h >>> 1) | (l << 31)) ^ ((h >>> 8) | (l << 24)) ^ (h >>> 7);
    const s0l = ((l >>> 1) | (h << 31)) ^ ((l >>> 8) | (h << 24)) ^ ((l >>> 7) | (h << 25));
    h = W[i - 4]; l = W[i - 3];
    const s1h = ((h >>> 19) | (l << 13)) ^ ((l >>> 29) | (h << 3)) ^ (h >>> 6);
    const s1l = ((l >>> 19) | (h << 13)) ^ ((h >>> 29) | (l << 3)) ^ ((l >>> 6) | (h << 26));
    const lo = (s0l >>> 0) + (s1l >>> 0) + (W[i - 13] >>> 0) + (W[i - 31] >>> 0);
    W[i] = (s0h + s1h + W[i - 14] + W[i - 32] + Math.floor(lo / TWO32)) | 0;
    W[i + 1] = lo | 0;
  }
  let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
  let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
  for (let i = 0; i < 160; i += 2) {
    const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
    let lo = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K[i + 1] >>> 0) + (W[i + 1] >>> 0);
    const t1h = (hh + S1h + chh + K[i] + W[i] + Math.floor(lo / TWO32)) | 0;
    const t1l = lo | 0;
    const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
    lo = (S0l >>> 0) + (mjl >>> 0);
    const t2h = (S0h + mjh + Math.floor(lo / TWO32)) | 0;
    const t2l = lo | 0;
    hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
    lo = (dl >>> 0) + (t1l >>> 0);
    eh = (dh + t1h + Math.floor(lo / TWO32)) | 0; el = lo | 0;
    dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
    lo = (t1l >>> 0) + (t2l >>> 0);
    ah = (t1h + t2h + Math.floor(lo / TWO32)) | 0; al = lo | 0;
  }
  const regs = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
  for (let j = 0; j < 16; j += 2) {
    const lo = (H[j + 1] >>> 0) + (regs[j + 1] >>> 0);
    H[j] = (H[j] + regs[j] + Math.floor(lo / TWO32)) | 0;
    H[j + 1] = lo | 0;
  }
}

function pad(data: Uint8Array, blockSize: 64 | 128): { buf: Uint8Array<ArrayBuffer>; dv: DataView } {
  const lenBytes = blockSize === 128 ? 16 : 8;
  const n = Math.ceil((data.length + 1 + lenBytes) / blockSize) * blockSize;
  const buf = new Uint8Array(n);
  buf.set(data);
  buf[data.length] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = data.length * 8;
  dv.setUint32(n - 8, Math.floor(bits / TWO32));
  dv.setUint32(n - 4, bits >>> 0);
  return { buf, dv };
}

function out32(words: ArrayLike<number>, bytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < bytes / 4; i++) dv.setInt32(i * 4, words[i]);
  return out;
}

function block256(H: Int32Array, W: Int32Array, dv: DataView, off: number): void {
  for (let i = 0; i < 16; i++) W[i] = dv.getInt32(off + i * 4);
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15], b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}

function block1(H: Int32Array, W: Int32Array, dv: DataView, off: number): void {
  for (let i = 0; i < 16; i++) W[i] = dv.getInt32(off + i * 4);
  for (let i = 16; i < 80; i++) { const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16]; W[i] = (x << 1) | (x >>> 31); }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
  for (let i = 0; i < 80; i++) {
    const f = i < 20 ? ((b & c) | (~b & d)) + 0x5a827999 : i < 40 ? (b ^ c ^ d) + 0x6ed9eba1 : i < 60 ? ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc : (b ^ c ^ d) + 0xca62c1d6;
    const t = (((a << 5) | (a >>> 27)) + f + e + W[i]) | 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
}

export type HashName = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

interface Algo { blockSize: 64 | 128; iv: number[]; words: number; outBytes: number; block: (H: Int32Array, W: Int32Array, dv: DataView, off: number) => void; wLen: number }
const ALGOS: Record<HashName, Algo> = {
  "SHA-1": { blockSize: 64, iv: IV1, words: 5, outBytes: 20, block: block1, wLen: 80 },
  "SHA-256": { blockSize: 64, iv: IV256, words: 8, outBytes: 32, block: block256, wLen: 64 },
  "SHA-384": { blockSize: 128, iv: IV384, words: 16, outBytes: 48, block: block512, wLen: 160 },
  "SHA-512": { blockSize: 128, iv: IV512, words: 16, outBytes: 64, block: block512, wLen: 160 },
};
export const HASH_BYTES: Record<HashName, number> = { "SHA-1": 20, "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 };

export function hash(name: HashName, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const A = ALGOS[name];
  const { buf, dv } = pad(data, A.blockSize);
  const H = Int32Array.from(A.iv);
  const W = new Int32Array(A.wLen);
  for (let off = 0; off < buf.length; off += A.blockSize) A.block(H, W, dv, off);
  return out32(H, A.outBytes);
}
export const sha512 = (d: Uint8Array) => hash("SHA-512", d);
export const sha1 = (d: Uint8Array) => hash("SHA-1", d);

export async function digest(name: HashName, ...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  return hash(name, concat(...parts));
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export class Cancelled extends Error { constructor() { super("Cancelled"); this.name = "AbortError"; } }

/**
 * H = hash(first); then `count` times H = hash(LE32(i) || H).
 * LE32(i) || H always fits one block, so padding is written once and H is hashed in place.
 * Yields to the page every few thousand rounds so the progress bar moves and Cancel works.
 */
export async function spin(name: HashName, first: Uint8Array, count: number, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const A = ALGOS[name];
  const h = hash(name, first);
  const blk = new Uint8Array(A.blockSize);
  const dv = new DataView(blk.buffer);
  const len = 4 + A.outBytes;
  blk.set(h, 4);
  blk[len] = 0x80;
  dv.setUint32(A.blockSize - 4, len * 8);
  const H = new Int32Array(A.words);
  const W = new Int32Array(A.wLen);
  const STEP = 5000;
  for (let i = 0; i < count; i++) {
    dv.setUint32(0, i, true);
    H.set(A.iv);
    A.block(H, W, dv, 0);
    for (let j = 0; j < A.outBytes / 4; j++) dv.setInt32(4 + j * 4, H[j]);
    if (i % STEP === STEP - 1) {
      onProgress?.((i + 1) / count);
      await new Promise(r => setTimeout(r, 0));
      if (signal?.aborted) throw new Cancelled();
    }
  }
  onProgress?.(1);
  return blk.slice(4, len);
}
