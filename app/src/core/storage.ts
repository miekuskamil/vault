// Persistence. IndexedDB is primary (large quota, binary blobs, can be marked persistent);
// localStorage is the fallback for browsers/contexts without IndexedDB.
// Every envelope write is read back and compared before it counts as saved.

import { fromB64, toB64 } from "./bytes";
import type { EnvelopeV1, EnvelopeV2, Sealed, SealedBytes } from "./crypto";

export const LEGACY_V1_KEY = "pwvault_blob_v1";
export const LEGACY_V1_MIGRATED_KEY = "pwvault_blob_v1_migrated";

export interface Snapshot { at: number; reason: string; count: number; data: Sealed; attachmentIds: string[] }
export interface Retired { at: number; reason: string; env: EnvelopeV2; attachmentIds: string[] }

export class SaveVerifyError extends Error {
  constructor(msg = "The browser didn't keep the change") { super(msg); this.name = "SaveVerifyError"; }
}

export interface Store {
  readonly kind: "indexeddb" | "localstorage";
  getEnvelope(): Promise<EnvelopeV2 | null>;
  putEnvelope(env: EnvelopeV2): Promise<void>;
  deleteEnvelope(): Promise<void>;
  putBlob(id: string, b: SealedBytes): Promise<void>;
  getBlob(id: string): Promise<SealedBytes | null>;
  deleteBlobs(ids: string[]): Promise<void>;
  listBlobIds(): Promise<string[]>;
  putSnapshot(s: Snapshot): Promise<void>;
  listSnapshots(): Promise<Snapshot[]>;
  deleteSnapshots(ats: number[]): Promise<void>;
  putRetired(r: Retired): Promise<void>;
  listRetired(): Promise<Retired[]>;
  deleteRetired(ats: number[]): Promise<void>;
}

// ---------- legacy v1 (localStorage, written by the original single-file app) ----------

export function readLegacyV1(): EnvelopeV1 | null {
  try {
    const raw = localStorage.getItem(LEGACY_V1_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && typeof p.salt === "string" && typeof p.ct === "string" ? p : null;
  } catch { return null; }
}

/** Keep the old encrypted blob under another key (a free extra backup) and stop offering migration. */
export function retireLegacyV1(): void {
  try {
    const raw = localStorage.getItem(LEGACY_V1_KEY);
    if (raw) { localStorage.setItem(LEGACY_V1_MIGRATED_KEY, raw); localStorage.removeItem(LEGACY_V1_KEY); }
  } catch { /* best effort */ }
}

// ---------- IndexedDB ----------

const DB_NAME = "pwvault";
const DB_VERSION = 1;
const S = { kv: "kv", blobs: "blobs", snapshots: "snapshots", retired: "retired" } as const;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error ?? new Error("Transaction aborted")); });
}

function openDb(timeoutMs = 4000): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") return rej(new Error("no indexedDB"));
    const t = setTimeout(() => rej(new Error("indexedDB open timed out")), timeoutMs);
    let r: IDBOpenDBRequest;
    try { r = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { clearTimeout(t); return rej(e); }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(S.kv)) db.createObjectStore(S.kv);
      if (!db.objectStoreNames.contains(S.blobs)) db.createObjectStore(S.blobs);
      if (!db.objectStoreNames.contains(S.snapshots)) db.createObjectStore(S.snapshots, { keyPath: "at" });
      if (!db.objectStoreNames.contains(S.retired)) db.createObjectStore(S.retired, { keyPath: "at" });
    };
    r.onsuccess = () => { clearTimeout(t); res(r.result); };
    r.onerror = () => { clearTimeout(t); rej(r.error); };
    r.onblocked = () => { clearTimeout(t); rej(new Error("indexedDB blocked")); };
  });
}

class IdbStore implements Store {
  readonly kind = "indexeddb" as const;
  constructor(private db: IDBDatabase) {}
  private tx(stores: string[], mode: IDBTransactionMode) { return this.db.transaction(stores, mode); }

  async getEnvelope() {
    const tx = this.tx([S.kv], "readonly");
    return ((await req(tx.objectStore(S.kv).get("envelope"))) as EnvelopeV2 | undefined) ?? null;
  }
  async putEnvelope(env: EnvelopeV2) {
    const tx = this.tx([S.kv], "readwrite");
    tx.objectStore(S.kv).put(env, "envelope");
    await done(tx);
    const back = await this.getEnvelope();
    if (!back || back.rev !== env.rev || back.data.iv !== env.data.iv || back.data.ct.length !== env.data.ct.length) throw new SaveVerifyError();
  }
  async deleteEnvelope() { const tx = this.tx([S.kv], "readwrite"); tx.objectStore(S.kv).delete("envelope"); await done(tx); }

  async putBlob(id: string, b: SealedBytes) {
    const tx = this.tx([S.blobs], "readwrite");
    tx.objectStore(S.blobs).put({ iv: b.iv, ct: b.ct }, id);
    await done(tx);
  }
  async getBlob(id: string) {
    const tx = this.tx([S.blobs], "readonly");
    const v = (await req(tx.objectStore(S.blobs).get(id))) as SealedBytes | undefined;
    return v ? { iv: new Uint8Array(v.iv), ct: new Uint8Array(v.ct) } : null;
  }
  async deleteBlobs(ids: string[]) {
    if (!ids.length) return;
    const tx = this.tx([S.blobs], "readwrite");
    for (const id of ids) tx.objectStore(S.blobs).delete(id);
    await done(tx);
  }
  async listBlobIds() {
    const tx = this.tx([S.blobs], "readonly");
    return ((await req(tx.objectStore(S.blobs).getAllKeys())) as IDBValidKey[]).map(String);
  }
  async putSnapshot(s: Snapshot) { const tx = this.tx([S.snapshots], "readwrite"); tx.objectStore(S.snapshots).put(s); await done(tx); }
  async listSnapshots() {
    const tx = this.tx([S.snapshots], "readonly");
    return ((await req(tx.objectStore(S.snapshots).getAll())) as Snapshot[]).sort((a, b) => b.at - a.at);
  }
  async deleteSnapshots(ats: number[]) {
    if (!ats.length) return;
    const tx = this.tx([S.snapshots], "readwrite");
    for (const a of ats) tx.objectStore(S.snapshots).delete(a);
    await done(tx);
  }
  async putRetired(r: Retired) { const tx = this.tx([S.retired], "readwrite"); tx.objectStore(S.retired).put(r); await done(tx); }
  async listRetired() {
    const tx = this.tx([S.retired], "readonly");
    return ((await req(tx.objectStore(S.retired).getAll())) as Retired[]).sort((a, b) => b.at - a.at);
  }
  async deleteRetired(ats: number[]) {
    if (!ats.length) return;
    const tx = this.tx([S.retired], "readwrite");
    for (const a of ats) tx.objectStore(S.retired).delete(a);
    await done(tx);
  }
}

// ---------- localStorage fallback ----------

const LS = { env: "pwv2:envelope", blob: "pwv2:blob:", snap: "pwv2:snap:", retired: "pwv2:retired:" };

class LocalStore implements Store {
  readonly kind = "localstorage" as const;
  private keys(prefix: string) { const out: string[] = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(prefix)) out.push(k); } return out; }
  private set(k: string, v: unknown) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch { throw new SaveVerifyError("This browser's storage is full"); }
  }
  async getEnvelope() { const r = localStorage.getItem(LS.env); return r ? (JSON.parse(r) as EnvelopeV2) : null; }
  async putEnvelope(env: EnvelopeV2) {
    this.set(LS.env, env);
    const back = await this.getEnvelope();
    if (!back || back.rev !== env.rev || back.data.iv !== env.data.iv) throw new SaveVerifyError();
  }
  async deleteEnvelope() { localStorage.removeItem(LS.env); }
  async putBlob(id: string, b: SealedBytes) { this.set(LS.blob + id, { iv: toB64(b.iv), ct: toB64(b.ct) }); }
  async getBlob(id: string) { const r = localStorage.getItem(LS.blob + id); if (!r) return null; const p = JSON.parse(r); return { iv: fromB64(p.iv), ct: fromB64(p.ct) }; }
  async deleteBlobs(ids: string[]) { for (const id of ids) localStorage.removeItem(LS.blob + id); }
  async listBlobIds() { return this.keys(LS.blob).map(k => k.slice(LS.blob.length)); }
  async putSnapshot(s: Snapshot) { this.set(LS.snap + s.at, s); }
  async listSnapshots() { return this.keys(LS.snap).map(k => JSON.parse(localStorage.getItem(k)!) as Snapshot).sort((a, b) => b.at - a.at); }
  async deleteSnapshots(ats: number[]) { for (const a of ats) localStorage.removeItem(LS.snap + a); }
  async putRetired(r: Retired) { this.set(LS.retired + r.at, r); }
  async listRetired() { return this.keys(LS.retired).map(k => JSON.parse(localStorage.getItem(k)!) as Retired).sort((a, b) => b.at - a.at); }
  async deleteRetired(ats: number[]) { for (const a of ats) localStorage.removeItem(LS.retired + a); }
}

export async function openStore(): Promise<Store> {
  try { return new IdbStore(await openDb()); }
  catch { return new LocalStore(); }
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

export async function isPersisted(): Promise<boolean> {
  try { return !!(await navigator.storage?.persisted?.()); } catch { return false; }
}
