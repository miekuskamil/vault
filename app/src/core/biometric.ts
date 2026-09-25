// Fingerprint / face unlock via a WebAuthn passkey with the PRF extension.
// The passkey's PRF output (only released after the phone verifies you) derives a key
// that wraps the vault's data key. Needs a secure https origin, so only the installed app.

import { fromB64, randomBytes, toB64 } from "./bytes";

export type BiometricSupport = "available" | "needs-install" | "unsupported";

export async function biometricSupport(): Promise<BiometricSupport> {
  const secureOrigin = typeof location !== "undefined" && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1");
  if (!secureOrigin || !window.isSecureContext) return "needs-install";
  if (typeof PublicKeyCredential === "undefined" || !navigator.credentials) return "unsupported";
  try {
    const ok = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    return ok ? "available" : "unsupported";
  } catch { return "unsupported"; }
}

export class BiometricError extends Error { constructor(msg: string) { super(msg); this.name = "BiometricError"; } }

interface PrfResults { enabled?: boolean; results?: { first?: ArrayBuffer } }

function prfFrom(cred: PublicKeyCredential | null): PrfResults | undefined {
  return (cred?.getClientExtensionResults() as { prf?: PrfResults } | undefined)?.prf;
}

export async function enrollBiometric(): Promise<{ credId: string; prfSalt: string; prfOutput: ArrayBuffer }> {
  const prfSalt = randomBytes(32);
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Vault", id: location.hostname },
        user: { id: randomBytes(16), name: "vault", displayName: "Vault" },
        challenge: randomBytes(32),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
        timeout: 60_000,
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw new BiometricError((e as Error)?.name === "NotAllowedError" ? "Fingerprint setup was cancelled." : "This phone couldn't set up fingerprint unlock.");
  }
  if (!cred) throw new BiometricError("Fingerprint setup was cancelled.");
  const credId = toB64(new Uint8Array(cred.rawId));
  const prf = prfFrom(cred);
  if (prf?.enabled === false) throw new BiometricError("This phone's passkey provider doesn't support the feature fingerprint unlock needs.");
  const output = prf?.results?.first ?? (await getBiometricPrf(credId, toB64(prfSalt)));
  return { credId, prfSalt: toB64(prfSalt), prfOutput: output };
}

export async function getBiometricPrf(credId: string, prfSalt: string): Promise<ArrayBuffer> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: "public-key", id: fromB64(credId) }],
        userVerification: "required",
        timeout: 60_000,
        extensions: { prf: { eval: { first: fromB64(prfSalt) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw new BiometricError((e as Error)?.name === "NotAllowedError" ? "Fingerprint check was cancelled." : "Fingerprint unlock isn't available right now.");
  }
  const out = prfFrom(cred)?.results?.first;
  if (!out) throw new BiometricError("This phone's passkey provider doesn't support the feature fingerprint unlock needs.");
  return out;
}
