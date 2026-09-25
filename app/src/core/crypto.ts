// Vault encryption. WebCrypto only — no custom primitives.
//
// v2 design (key wrapping, as used by mainstream password managers):
//   master password --PBKDF2-SHA256--> KEK  --AES-GCM wrap-->  DEK (random 256-bit)
//   DEK --AES-GCM--> vault JSON, each attachment, each snapshot
// Changing the master password only re-wraps the DEK; data and snapshots stay valid.
// Biometric unlock wraps the same DEK with a key derived from a WebAuthn PRF output.
//
// v1 (the original single-file app): PBKDF2 → AES-GCM directly over the JSON, read-only here.

import { fromB64, randomBytes, toB64, utf8 } from "./bytes";

export const DEFAULT_ITERATIONS = 600_000;
export const MIN_ITERATIONS = 100_000;

export interface KdfParams { alg: "PBKDF2-SHA256"; iterations: number; salt: string }
export interface Wrapped { iv: string; wrapped: string }
export interface Sealed { iv: string; ct: string }
export interface SealedBytes { iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }
export interface BiometricKey { credId: string; prfSalt: string; iv: string; wrapped: string; createdAt: number }

export interface EnvelopeV2 {
  format: "pwvault";
  v: 2;
  kdf: KdfParams;
  keys: { password: Wrapped; biometric?: BiometricKey };
  data: Sealed;
  rev: number;
  updatedAt: number;
}

export interface EnvelopeV1 { v?: 1; salt: string; iv: string; ct: string; kdf?: string; iterations?: number }

export class WrongPasswordError extends Error {
  constructor() { super("Wrong password"); this.name = "WrongPasswordError"; }
}
export class CorruptDataError extends Error {
  constructor(msg = "The vault data is damaged and can't be decrypted") { super(msg); this.name = "CorruptDataError"; }
}

const subtle = () => {
  if (!globalThis.crypto?.subtle) throw new Error("This browser can't do encryption here (no WebCrypto). Open the file in Chrome.");
  return globalThis.crypto.subtle;
};

export function isEnvelopeV2(x: unknown): x is EnvelopeV2 {
  const e = x as EnvelopeV2;
  return !!e && e.format === "pwvault" && e.v === 2 && !!e.kdf?.salt && !!e.keys?.password?.wrapped && !!e.data?.ct;
}
export function isEnvelopeV1(x: unknown): x is EnvelopeV1 {
  const e = x as EnvelopeV1;
  return !!e && typeof e.salt === "string" && typeof e.iv === "string" && typeof e.ct === "string" && (e as unknown as EnvelopeV2).format !== "pwvault";
}

function checkIterations(n: number | undefined): number {
  const it = n ?? DEFAULT_ITERATIONS;
  if (!Number.isInteger(it) || it < MIN_ITERATIONS || it > 10_000_000) throw new CorruptDataError("The vault's key settings are invalid");
  return it;
}

async function pbkdf2Key(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number, usages: KeyUsage[], alg: AesKeyGenParams): Promise<CryptoKey> {
  const material = await subtle().importKey("raw", utf8.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, alg, false, usages);
}

export async function deriveKek(password: string, kdf: KdfParams): Promise<CryptoKey> {
  if (kdf.alg !== "PBKDF2-SHA256") throw new CorruptDataError("Unsupported key derivation: " + kdf.alg);
  return pbkdf2Key(password, fromB64(kdf.salt), checkIterations(kdf.iterations), ["wrapKey", "unwrapKey"], { name: "AES-GCM", length: 256 });
}

export async function wrapDek(dek: CryptoKey, kek: CryptoKey): Promise<Wrapped> {
  const iv = randomBytes(12);
  const w = await subtle().wrapKey("raw", dek, kek, { name: "AES-GCM", iv });
  return { iv: toB64(iv), wrapped: toB64(new Uint8Array(w)) };
}

export async function unwrapDek(w: Wrapped, kek: CryptoKey, extractable = false): Promise<CryptoKey> {
  try {
    return await subtle().unwrapKey("raw", fromB64(w.wrapped), kek, { name: "AES-GCM", iv: fromB64(w.iv) }, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
  } catch {
    throw new WrongPasswordError();
  }
}

export async function sealJSON(value: unknown, dek: CryptoKey): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, dek, utf8.encode(JSON.stringify(value)));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function openJSON<T = unknown>(s: Sealed, dek: CryptoKey): Promise<T> {
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(s.iv) }, dek, fromB64(s.ct));
  } catch {
    throw new CorruptDataError();
  }
  return JSON.parse(utf8.decode(new Uint8Array(plain))) as T;
}

export async function sealBytes(bytes: Uint8Array<ArrayBuffer>, dek: CryptoKey): Promise<SealedBytes> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, dek, bytes));
  return { iv, ct };
}

export async function openBytes(s: SealedBytes, dek: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: s.iv }, dek, s.ct));
  } catch {
    throw new CorruptDataError("An attachment is damaged and can't be decrypted");
  }
}

/** Fresh random data key. Extractable only so it can be wrapped; the session uses a non-extractable copy. */
async function generateDek(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export interface Unlocked { env: EnvelopeV2; dek: CryptoKey }

export async function createEnvelope(password: string, vault: unknown, iterations = DEFAULT_ITERATIONS): Promise<Unlocked> {
  const kdf: KdfParams = { alg: "PBKDF2-SHA256", iterations, salt: toB64(randomBytes(16)) };
  const kek = await deriveKek(password, kdf);
  const raw = await generateDek();
  const wrapped = await wrapDek(raw, kek);
  const dek = await unwrapDek(wrapped, kek, false);
  const data = await sealJSON(vault, dek);
  return { env: { format: "pwvault", v: 2, kdf, keys: { password: wrapped }, data, rev: 1, updatedAt: Date.now() }, dek };
}

/** Throws WrongPasswordError when the password doesn't open the key. */
export async function unlockEnvelope(env: EnvelopeV2, password: string, extractable = false): Promise<CryptoKey> {
  const kek = await deriveKek(password, env.kdf);
  return unwrapDek(env.keys.password, kek, extractable);
}

/** Re-wrap the data key under a new password (new salt). Data, attachments and snapshots are untouched. */
export async function rewrapPassword(env: EnvelopeV2, currentPassword: string, newPassword: string, iterations = DEFAULT_ITERATIONS): Promise<EnvelopeV2> {
  const raw = await unlockEnvelope(env, currentPassword, true);
  const kdf: KdfParams = { alg: "PBKDF2-SHA256", iterations, salt: toB64(randomBytes(16)) };
  const kek = await deriveKek(newPassword, kdf);
  const wrapped = await wrapDek(raw, kek);
  return { ...env, kdf, keys: { ...env.keys, password: wrapped } };
}

/** Decrypt a v1 envelope, honouring its stored iteration count (v1 ignored it — the bug this fixes). */
export async function openV1(env: EnvelopeV1, password: string): Promise<unknown> {
  const it = checkIterations(env.iterations);
  const key = await pbkdf2Key(password, fromB64(env.salt), it, ["decrypt"], { name: "AES-GCM", length: 256 });
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(env.iv) }, key, fromB64(env.ct));
  } catch {
    throw new WrongPasswordError();
  }
  return JSON.parse(utf8.decode(new Uint8Array(plain)));
}

// ---- biometric (WebAuthn PRF) key wrapping ----

async function kekFromPrf(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8.encode("pwvault biometric kek v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"],
  );
}

export async function wrapForBiometric(extractableDek: CryptoKey, prfOutput: ArrayBuffer, credId: string, prfSalt: string): Promise<BiometricKey> {
  const w = await wrapDek(extractableDek, await kekFromPrf(prfOutput));
  return { credId, prfSalt, iv: w.iv, wrapped: w.wrapped, createdAt: Date.now() };
}

export async function unwrapWithBiometric(key: BiometricKey, prfOutput: ArrayBuffer): Promise<CryptoKey> {
  return unwrapDek({ iv: key.iv, wrapped: key.wrapped }, await kekFromPrf(prfOutput), false);
}
