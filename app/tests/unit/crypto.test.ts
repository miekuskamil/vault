import { createEnvelope, isEnvelopeV1, isEnvelopeV2, openJSON, openV1, rewrapPassword, sealBytes, openBytes, unlockEnvelope, WrongPasswordError, CorruptDataError } from "../../src/core/crypto";
import { fromB64, toB64, utf8, randomBytes, randomInt, dataUrlToBytes } from "../../src/core/bytes";
import { webcrypto } from "node:crypto";

const IT = 100_000; // fast but still >= the minimum the app accepts

describe("bytes", () => {
  it("round-trips base64 including large buffers", () => {
    const b = randomBytes(200_000);
    expect(fromB64(toB64(b))).toEqual(b);
  });
  it("randomInt stays in range and covers it", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) { const r = randomInt(7); expect(r).toBeGreaterThanOrEqual(0); expect(r).toBeLessThan(7); seen.add(r); }
    expect(seen.size).toBe(7);
  });
  it("decodes data URLs without fetch", () => {
    const d = dataUrlToBytes("data:image/png;base64," + toB64(utf8.encode("hello")))!;
    expect(d.mime).toBe("image/png");
    expect(utf8.decode(d.bytes)).toBe("hello");
  });
});

describe("envelope v2", () => {
  it("creates, unlocks and decrypts", async () => {
    const { env, dek } = await createEnvelope("correct horse battery staple", { hello: "world" }, IT);
    expect(isEnvelopeV2(env)).toBe(true);
    expect(env.kdf.iterations).toBe(IT);
    expect(await openJSON(env.data, dek)).toEqual({ hello: "world" });
    const dek2 = await unlockEnvelope(env, "correct horse battery staple");
    expect(await openJSON(env.data, dek2)).toEqual({ hello: "world" });
  });
  it("rejects a wrong password with WrongPasswordError", async () => {
    const { env } = await createEnvelope("right password here", {}, IT);
    await expect(unlockEnvelope(env, "wrong password here")).rejects.toBeInstanceOf(WrongPasswordError);
  });
  it("session key is not extractable", async () => {
    const { dek } = await createEnvelope("pw pw pw pw pw", {}, IT);
    expect(dek.extractable).toBe(false);
  });
  it("changing password re-wraps the key; old data still decrypts, old password fails", async () => {
    const { env } = await createEnvelope("old password 123", { n: 1 }, IT);
    const env2 = await rewrapPassword(env, "old password 123", "new password 456", IT);
    expect(env2.data).toEqual(env.data);
    expect(env2.kdf.salt).not.toBe(env.kdf.salt);
    const dek = await unlockEnvelope(env2, "new password 456");
    expect(await openJSON(env2.data, dek)).toEqual({ n: 1 });
    await expect(unlockEnvelope(env2, "old password 123")).rejects.toBeInstanceOf(WrongPasswordError);
  });
  it("detects tampered data", async () => {
    const { env, dek } = await createEnvelope("pw pw pw pw pw", { a: 1 }, IT);
    const ct = fromB64(env.data.ct); ct[5] ^= 1;
    await expect(openJSON({ iv: env.data.iv, ct: toB64(ct) }, dek)).rejects.toBeInstanceOf(CorruptDataError);
  });
  it("refuses absurd iteration counts from a file", async () => {
    const { env } = await createEnvelope("pw pw pw pw pw", {}, IT);
    await expect(unlockEnvelope({ ...env, kdf: { ...env.kdf, iterations: 5 } }, "pw pw pw pw pw")).rejects.toBeInstanceOf(CorruptDataError);
  });
  it("seals attachment bytes", async () => {
    const { dek } = await createEnvelope("pw pw pw pw pw", {}, IT);
    const bytes = randomBytes(5000);
    const s = await sealBytes(bytes, dek);
    expect(await openBytes(s, dek)).toEqual(bytes);
  });
});

// A v1 blob exactly as the original single-file app wrote it.
async function makeV1(password: string, vault: unknown, iterations = 600_000) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const km = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(vault)));
  return { v: 1 as const, salt: toB64(salt), iv: toB64(iv), ct: toB64(new Uint8Array(ct)), kdf: "PBKDF2-SHA256", iterations };
}
export { makeV1 };

describe("v1 compatibility", () => {
  it("opens a v1 blob and honours its stored iteration count", async () => {
    const v1 = await makeV1("legacy password", { categories: [{ name: "A", entries: [] }] }, 150_000);
    expect(isEnvelopeV1(v1)).toBe(true);
    expect(await openV1(v1, "legacy password")).toEqual({ categories: [{ name: "A", entries: [] }] });
    await expect(openV1(v1, "nope nope")).rejects.toBeInstanceOf(WrongPasswordError);
  });
});
