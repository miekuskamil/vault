// Byte helpers shared by crypto, storage and importers. No DOM dependencies.

export function toB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const utf8 = {
  encode: (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>,
  decode: (b: Uint8Array): string => new TextDecoder().decode(b),
};

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536))); // per-call limit
  return out;
}

/** 128-bit random id, URL-safe. */
export function newId(): string {
  return toB64(randomBytes(16)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Uniform integer in [0, max) without modulo bias. */
export function randomInt(max: number): number {
  if (max <= 0 || max > 0x100000000) throw new RangeError("randomInt max out of range");
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/** Decode a data: URL (base64 or percent-encoded) without fetch — CSP blocks connect. */
export function dataUrlToBytes(url: string): { mime: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const isB64 = /;base64/i.test(m[2]);
  if (isB64) return { mime, bytes: fromB64(m[3].replace(/\s+/g, "")) };
  return { mime, bytes: utf8.encode(decodeURIComponent(m[3])) };
}
