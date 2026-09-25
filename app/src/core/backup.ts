// Backup file formats.
//   v2 (.vault): { format: "pwvault-backup", v: 2, envelope, blobs } — attachments included, still encrypted.
//   v1 (.vault): { salt, iv, ct } from the original single-file app.

import { dataUrlToBytes, fromB64, newId, toB64 } from "./bytes";
import { isEnvelopeV1, isEnvelopeV2, openBytes, openJSON, openV1, unlockEnvelope, type EnvelopeV1, type EnvelopeV2 } from "./crypto";
import { migrateV1, normalizeVault, referencedAttachments, type AttachmentMeta, type Vault } from "./model";

export interface BackupFileV2 {
  format: "pwvault-backup";
  v: 2;
  exportedAt: number;
  app: string;
  envelope: EnvelopeV2;
  blobs: Record<string, { iv: string; ct: string }>;
}

export type ParsedBackup =
  | { kind: "v2"; file: BackupFileV2 }
  | { kind: "v1"; env: EnvelopeV1 };

export class BackupFormatError extends Error {
  constructor(msg = "That file isn't a vault backup.") { super(msg); this.name = "BackupFormatError"; }
}

export function parseBackup(text: string): ParsedBackup {
  let p: unknown;
  try { p = JSON.parse(text); } catch { throw new BackupFormatError(); }
  const o = p as Partial<BackupFileV2>;
  if (o && o.format === "pwvault-backup" && o.v === 2 && isEnvelopeV2(o.envelope)) return { kind: "v2", file: { ...o, blobs: o.blobs ?? {} } as BackupFileV2 };
  if (isEnvelopeV2(p)) return { kind: "v2", file: { format: "pwvault-backup", v: 2, exportedAt: (p as EnvelopeV2).updatedAt, app: "", envelope: p as EnvelopeV2, blobs: {} } };
  if (isEnvelopeV1(p)) return { kind: "v1", env: p as EnvelopeV1 };
  throw new BackupFormatError();
}

/** A decrypted backup: plaintext vault plus plaintext attachment bytes keyed by attachment id. */
export interface OpenedBackup {
  kind: "v1" | "v2";
  vault: Vault;
  files: Map<string, { bytes: Uint8Array<ArrayBuffer>; mime: string }>;
  exportedAt: number | null;
  parsed: ParsedBackup;
  missing: number; // attachments referenced but not included in the file
}

/** Decrypts with the backup's own password. Throws WrongPasswordError. */
export async function openBackup(parsed: ParsedBackup, password: string, prepareImage?: (bytes: Uint8Array<ArrayBuffer>, mime: string) => Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; width?: number; height?: number }>): Promise<OpenedBackup> {
  const files = new Map<string, { bytes: Uint8Array<ArrayBuffer>; mime: string }>();
  if (parsed.kind === "v2") {
    const env = parsed.file.envelope;
    const dek = await unlockEnvelope(env, password);
    const vault = normalizeVault(await openJSON(env.data, dek));
    let missing = 0;
    const metas = new Map<string, AttachmentMeta>(vault.items.flatMap(i => i.attachments.map(a => [a.id, a] as const)));
    for (const id of referencedAttachments(vault)) {
      const b = parsed.file.blobs[id];
      if (!b) { missing++; continue; }
      const bytes = await openBytes({ iv: fromB64(b.iv), ct: fromB64(b.ct) }, dek);
      files.set(id, { bytes, mime: metas.get(id)?.mime ?? "application/octet-stream" });
    }
    return { kind: "v2", vault, files, exportedAt: parsed.file.exportedAt ?? null, parsed, missing };
  }
  const raw = await openV1(parsed.env, password);
  const { vault, images } = migrateV1(raw);
  let v = vault;
  for (const img of images) {
    const decoded = dataUrlToBytes(img.dataUrl);
    if (!decoded) continue;
    const prepared = prepareImage ? await prepareImage(decoded.bytes, decoded.mime) : { bytes: decoded.bytes, mime: decoded.mime };
    const id = newId();
    files.set(id, { bytes: prepared.bytes, mime: prepared.mime });
    const meta: AttachmentMeta = { id, name: "Photo.jpg", mime: prepared.mime, size: prepared.bytes.length, width: (prepared as { width?: number }).width, height: (prepared as { height?: number }).height, addedAt: Date.now() };
    v = { ...v, items: v.items.map(it => (it.id === img.itemId ? { ...it, attachments: [...it.attachments, meta] } : it)) };
  }
  return { kind: "v1", vault: v, files, exportedAt: null, parsed, missing: 0 };
}

export function buildBackupFile(envelope: EnvelopeV2, blobs: Map<string, { iv: Uint8Array; ct: Uint8Array }>, app: string): BackupFileV2 {
  const out: BackupFileV2["blobs"] = {};
  for (const [id, b] of blobs) out[id] = { iv: toB64(b.iv), ct: toB64(b.ct) };
  return { format: "pwvault-backup", v: 2, exportedAt: Date.now(), app, envelope, blobs: out };
}

export function backupFileName(now = new Date()): string {
  const d = now.toISOString().slice(0, 10);
  return `vault-backup-${d}.vault`;
}
