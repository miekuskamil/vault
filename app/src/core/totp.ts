// RFC 6238 time-based one-time passwords (the 6-digit 2FA codes), via WebCrypto HMAC.

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";
export interface TotpConfig { secret: Uint8Array<ArrayBuffer>; digits: number; period: number; algorithm: TotpAlgorithm; issuer?: string; account?: string }

export function base32Decode(input: string): Uint8Array<ArrayBuffer> | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

const ALGS: Record<string, TotpAlgorithm> = { SHA1: "SHA-1", "SHA-1": "SHA-1", SHA256: "SHA-256", "SHA-256": "SHA-256", SHA512: "SHA-512", "SHA-512": "SHA-512" };

/** Accepts an otpauth://totp/... URI or a bare base32 secret. Returns null if unusable. */
export function parseTotp(input: string): TotpConfig | null {
  const s = input.trim();
  if (!s) return null;
  if (/^otpauth:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    if (u.host.toLowerCase() !== "totp") return null;
    const secret = base32Decode(u.searchParams.get("secret") ?? "");
    if (!secret || secret.length < 5) return null;
    const digits = Number(u.searchParams.get("digits") ?? 6);
    const period = Number(u.searchParams.get("period") ?? 30);
    const algorithm = ALGS[(u.searchParams.get("algorithm") ?? "SHA1").toUpperCase()];
    if (!algorithm || ![6, 7, 8].includes(digits) || !(period >= 10 && period <= 300)) return null;
    const label = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const [maybeIssuer, account] = label.includes(":") ? label.split(/:(.*)/s) : [undefined, label];
    return { secret, digits, period, algorithm, issuer: u.searchParams.get("issuer") ?? maybeIssuer, account: account?.trim() || undefined };
  }
  const secret = base32Decode(s);
  if (!secret || secret.length < 5) return null;
  return { secret, digits: 6, period: 30, algorithm: "SHA-1" };
}

export async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number, digits = 6, algorithm: TotpAlgorithm = "SHA-1"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export async function totpAt(cfg: TotpConfig, timeMs: number): Promise<{ code: string; remaining: number }> {
  const step = Math.floor(timeMs / 1000 / cfg.period);
  const code = await hotp(cfg.secret, step, cfg.digits, cfg.algorithm);
  const remaining = cfg.period - (Math.floor(timeMs / 1000) % cfg.period);
  return { code, remaining };
}

export function formatCode(code: string): string {
  return code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : code.length === 8 ? code.slice(0, 4) + " " + code.slice(4) : code;
}
