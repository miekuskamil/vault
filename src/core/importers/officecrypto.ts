// Opens password-protected Excel files (ECMA-376 "Agile" encryption from Excel 2010 onward,
// and "Standard" encryption from Excel 2007) right on the phone, so an unprotected copy of
// the spreadsheet never has to exist. AES runs in WebCrypto; nothing leaves the page.

import { fromB64 } from "../bytes";
import { isCfb, readCfb } from "./cfb";
import { concat, digest, HASH_BYTES, spin, type HashName } from "./sha";

export class OfficeCryptoError extends Error {
  constructor(public code: "password" | "unsupported" | "legacy" | "damaged", msg: string) { super(msg); this.name = "OfficeCryptoError"; }
}

/** What's inside an OLE container: a protected .xlsx, an old binary .xls, or something else. */
export function describeContainer(bytes: Uint8Array<ArrayBuffer>): "encrypted" | "legacy" | "other" {
  if (!isCfb(bytes)) return "other";
  try {
    const cfb = readCfb(bytes);
    const names = new Set(cfb.entries.map(e => e.name));
    if (names.has("EncryptionInfo") && names.has("EncryptedPackage")) return "encrypted";
    if (names.has("Workbook") || names.has("Book")) return "legacy";
  } catch { /* fall through */ }
  return "other";
}

const utf16le = (s: string) => {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i * 2] = c & 0xff; out[i * 2 + 1] = c >> 8; }
  return out;
};
const le32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const fit = (b: Uint8Array, n: number, fill: number) => { const out = new Uint8Array(n).fill(fill); out.set(b.subarray(0, n)); return out; };
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 16 && raw.length !== 32) throw new OfficeCryptoError("unsupported", "This spreadsheet uses an encryption this app can't open.");
  return crypto.subtle.importKey("raw", fit(raw, raw.length, 0), "AES-CBC", false, ["encrypt", "decrypt"]);
}

/**
 * AES-CBC without padding. WebCrypto insists on PKCS#7, so we append one extra block that
 * decrypts to a full padding block (E_k(0x10… XOR last ciphertext block)) and let it strip that.
 */
async function cbcNoPad(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (data.length % 16) throw new OfficeCryptoError("damaged", "The spreadsheet file is damaged.");
  if (!data.length) return new Uint8Array(0);
  const last = data.slice(data.length - 16);
  const tail = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: last }, key, new Uint8Array(16).fill(16))).subarray(0, 16);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: fit(iv, 16, 0) }, key, concat(data, tail)));
}

async function ecbNoPad(key: CryptoKey, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const out = await cbcNoPad(key, new Uint8Array(16), data);
  for (let i = out.length - 1; i >= 16; i--) out[i] ^= data[i - 16];
  return out;
}

function b64(s: string | null): Uint8Array<ArrayBuffer> {
  try { return fromB64(s ?? ""); } catch { throw new OfficeCryptoError("damaged", "The spreadsheet file is damaged."); }
}

const HASHES: Record<string, HashName> = { SHA1: "SHA-1", "SHA-1": "SHA-1", SHA256: "SHA-256", "SHA-256": "SHA-256", SHA384: "SHA-384", "SHA-384": "SHA-384", SHA512: "SHA-512", "SHA-512": "SHA-512" };

interface CipherParams { salt: Uint8Array; blockSize: number; keyBits: number; hashSize: number; hash: HashName }

function params(el: Element): CipherParams {
  const hash = HASHES[(el.getAttribute("hashAlgorithm") ?? "").toUpperCase()];
  const cipher = (el.getAttribute("cipherAlgorithm") ?? "").toUpperCase();
  const chaining = el.getAttribute("cipherChaining") ?? "";
  if (!hash || cipher !== "AES" || chaining !== "ChainingModeCBC") throw new OfficeCryptoError("unsupported", "This spreadsheet uses an encryption this app can't open.");
  const p = {
    salt: b64(el.getAttribute("saltValue")),
    blockSize: Number(el.getAttribute("blockSize") ?? 16),
    keyBits: Number(el.getAttribute("keyBits") ?? 256),
    hashSize: Number(el.getAttribute("hashSize") ?? HASH_BYTES[hash]),
    hash,
  };
  // Everything the file says about sizes is checked before any work is done with it.
  if (![128, 256].includes(p.keyBits) || p.blockSize !== 16 || p.hashSize !== HASH_BYTES[hash] || p.salt.length < 1 || p.salt.length > 64)
    throw new OfficeCryptoError("unsupported", "This spreadsheet uses an encryption this app can't open.");
  return p;
}

const BLOCK_VERIFIER_INPUT = new Uint8Array([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
const BLOCK_VERIFIER_VALUE = new Uint8Array([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
const BLOCK_KEY = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);

async function agile(xml: string, pkg: Uint8Array, password: string, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const keyData = doc.getElementsByTagNameNS("*", "keyData")[0];
  const encKey = Array.from(doc.getElementsByTagNameNS("*", "encryptedKey")).find(e => e.hasAttribute("spinCount"));
  if (!keyData || !encKey) throw new OfficeCryptoError("unsupported", "This spreadsheet is protected with a certificate, not a password.");
  const kd = params(keyData);
  const pk = params(encKey);
  const spinCount = Number(encKey.getAttribute("spinCount") ?? 100000);
  if (!(Number.isInteger(spinCount) && spinCount >= 0 && spinCount <= 10_000_000)) throw new OfficeCryptoError("damaged", "The spreadsheet file is damaged.");

  const h = await spin(pk.hash, concat(pk.salt, utf16le(password.slice(0, 255))), spinCount, f => onProgress?.(f * 0.8), signal);
  const keyFor = async (block: Uint8Array) => aesKey(fit(await digest(pk.hash, h, block), pk.keyBits / 8, 0x36));

  const verifierInput = (await cbcNoPad(await keyFor(BLOCK_VERIFIER_INPUT), pk.salt, b64(encKey.getAttribute("encryptedVerifierHashInput")))).subarray(0, pk.salt.length);
  const verifierHash = (await cbcNoPad(await keyFor(BLOCK_VERIFIER_VALUE), pk.salt, b64(encKey.getAttribute("encryptedVerifierHashValue")))).subarray(0, pk.hashSize);
  if (!equal(await digest(pk.hash, verifierInput), verifierHash)) throw new OfficeCryptoError("password", "Wrong password for this spreadsheet.");
  const secret = (await cbcNoPad(await keyFor(BLOCK_KEY), pk.salt, b64(encKey.getAttribute("encryptedKeyValue")))).subarray(0, kd.keyBits / 8);
  const key = await aesKey(secret);

  const size = packageSize(pkg);
  const SEG = 4096;
  const body = pkg.subarray(8);
  const out = new Uint8Array(Math.ceil(body.length / 16) * 16);
  for (let i = 0, o = 0; o < body.length; i++, o += SEG) {
    const iv = fit(await digest(kd.hash, kd.salt, le32(i)), kd.blockSize, 0);
    let seg = body.subarray(o, Math.min(body.length, o + SEG));
    if (seg.length % 16) seg = fit(seg, Math.ceil(seg.length / 16) * 16, 0);
    out.set(await cbcNoPad(key, iv, seg), o);
    if (i % 64 === 0) { onProgress?.(0.8 + 0.2 * (o / body.length)); if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); }
  }
  onProgress?.(1);
  return out.slice(0, size);
}

function packageSize(pkg: Uint8Array): number {
  if (pkg.length < 8) throw new OfficeCryptoError("damaged", "The spreadsheet file is damaged.");
  const dv = new DataView(pkg.buffer, pkg.byteOffset, 8);
  const size = dv.getUint32(0, true) + dv.getUint32(4, true) * 2 ** 32;
  if (size > pkg.length - 8) throw new OfficeCryptoError("damaged", "The spreadsheet file is damaged.");
  return size;
}

async function standard(info: Uint8Array, pkg: Uint8Array, password: string, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const headerSize = dv.getUint32(8, true);
  const h = 12;
  const algId = dv.getUint32(h + 8, true);
  const keyBits = dv.getUint32(h + 16, true);
  if (![0, 0x660e, 0x6610].includes(algId) || ![128, 256].includes(keyBits)) throw new OfficeCryptoError("unsupported", "This spreadsheet uses an encryption this app can't open.");
  const v = h + headerSize;
  if (headerSize < 32 || v + 4 > info.length) throw new OfficeCryptoError("damaged", "The spreadsheet file is damaged.");
  const saltSize = dv.getUint32(v, true);
  if (saltSize !== 16 || v + 24 + saltSize + 32 > info.length) throw new OfficeCryptoError("damaged", "The spreadsheet file is damaged.");
  const salt = info.slice(v + 4, v + 4 + saltSize);
  const encVerifier = info.slice(v + 4 + saltSize, v + 20 + saltSize);
  const hashSize = dv.getUint32(v + 20 + saltSize, true);
  const encVerifierHash = info.slice(v + 24 + saltSize, v + 24 + saltSize + 32);

  let hash = await spin("SHA-1", concat(salt, utf16le(password.slice(0, 255))), 50000, f => onProgress?.(f * 0.8), signal);
  hash = await digest("SHA-1", hash, le32(0));
  const x1 = new Uint8Array(64).fill(0x36), x2 = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < hash.length; i++) { x1[i] ^= hash[i]; x2[i] ^= hash[i]; }
  const derived = concat(await digest("SHA-1", x1), await digest("SHA-1", x2)).subarray(0, keyBits / 8);
  const key = await aesKey(derived);

  const verifier = await ecbNoPad(key, encVerifier);
  if (hashSize !== 20) throw new OfficeCryptoError("damaged", "The spreadsheet file is damaged.");
  const verifierHash = (await ecbNoPad(key, encVerifierHash)).subarray(0, hashSize);
  if (!equal(await digest("SHA-1", verifier), verifierHash)) throw new OfficeCryptoError("password", "Wrong password for this spreadsheet.");

  const size = packageSize(pkg);
  let body = pkg.subarray(8);
  if (body.length % 16) body = fit(body, Math.ceil(body.length / 16) * 16, 0);
  const out = await ecbNoPad(key, body);
  onProgress?.(1);
  return out.slice(0, size);
}

/** Decrypt a password-protected .xlsx and return the plain .xlsx (zip) bytes. */
export async function decryptXlsx(bytes: Uint8Array<ArrayBuffer>, password: string, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const cfb = readCfb(bytes);
  const info = cfb.stream("EncryptionInfo");
  const pkg = cfb.stream("EncryptedPackage");
  if (!info || !pkg) throw new OfficeCryptoError("legacy", "This is an old .xls file.");
  if (info.length < 8) throw new OfficeCryptoError("damaged", "The spreadsheet file is damaged.");
  const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const major = dv.getUint16(0, true), minor = dv.getUint16(2, true);
  let out: Uint8Array<ArrayBuffer>;
  try {
    if (major === 4 && minor === 4) out = await agile(new TextDecoder().decode(info.subarray(8)), pkg, password, onProgress, signal);
    else if ([2, 3, 4].includes(major) && minor === 2) out = await standard(info, pkg, password, onProgress, signal);
    else throw new OfficeCryptoError("unsupported", "This spreadsheet uses an encryption this app can't open.");
  } catch (e) {
    if (e instanceof OfficeCryptoError || (e as Error)?.name === "AbortError") throw e;
    // WebCrypto rejects bad padding/lengths the same way whether the password or the file is wrong.
    throw new OfficeCryptoError("damaged", "Couldn't open this spreadsheet. The file may be damaged.");
  }
  // The password was already verified, so anything that isn't a zip now is damage, not a typo.
  if (out[0] !== 0x50 || out[1] !== 0x4b) throw new OfficeCryptoError("damaged", "Couldn't open this spreadsheet. The file may be damaged.");
  return out;
}
