// The vault session: holds the data key while unlocked, serializes saves, takes snapshots,
// handles auto-lock, app-switch lock, clipboard clearing, multi-tab safety, backups.
// UI subscribes via subscribe()/getState(); nothing here touches React.

import { dataUrlToBytes, fromB64, newId } from "./bytes";
import {
  createEnvelope, openBytes, openJSON, openV1, rewrapPassword, sealBytes, sealJSON, unlockEnvelope, unwrapWithBiometric, wrapForBiometric,
  WrongPasswordError, type EnvelopeV1, type EnvelopeV2,
} from "./crypto";
import {
  addItem, addItems, emptyVault, expiredTrash, migrateV1, normalizeVault, purgeItems, referencedAttachments, touchUsed,
  type AttachmentMeta, type Item, type ItemDraft, type Vault, type VaultSettings, mergeVaults, liveItems,
} from "./model";
import {
  isPersisted, openStore, readLegacyV1, requestPersistence, retireLegacyV1, SaveVerifyError,
  type Retired, type Snapshot, type Store,
} from "./storage";
import { biometricSupport, enrollBiometric, getBiometricPrf, type BiometricSupport } from "./biometric";
import { buildBackupFile, openBackup, parseBackup, type OpenedBackup, type ParsedBackup } from "./backup";
import { prepareBytes, prepareFile } from "./image";
import { toasts } from "./toasts";
import type { SheetPicture } from "./importers/xlsx";

export const LOCKED_MANUALLY = "Locked";

export type Status = "loading" | "setup" | "locked" | "unlocked";
export type SaveState = "idle" | "saving" | "saved" | "error";

export interface SessionState {
  status: Status;
  storeKind: Store["kind"] | null;
  persisted: boolean;
  legacy: boolean;          // an old-format vault is waiting to be upgraded (locked screen)
  legacyExtra: boolean;     // an old-format vault exists alongside the new one
  biometric: { support: BiometricSupport; enrolled: boolean };
  vault: Vault | null;
  save: { state: SaveState; at: number | null; error: string | null };
  lockReason: string | null;
  fatal: string | null;
}

export class ConflictError extends Error { constructor() { super("The vault was changed in another tab"); this.name = "ConflictError"; } }

const SNAPSHOT_KEEP = 15;
const AUTO_SNAPSHOT_MS = 24 * 3600_000;
const RETIRED_DAYS = 30;
const DAY = 86_400_000;

export class Session {
  private state: SessionState = {
    status: "loading", storeKind: null, persisted: false, legacy: false, legacyExtra: false,
    biometric: { support: "unsupported", enrolled: false }, vault: null,
    save: { state: "idle", at: null, error: null }, lockReason: null, fatal: null,
  };
  private listeners = new Set<() => void>();
  private store!: Store;
  private env: EnvelopeV2 | null = null;
  private legacyEnv: EnvelopeV1 | null = null;
  private dek: CryptoKey | null = null;
  private queue: Promise<void> = Promise.resolve();
  private lastSnapshotAt = 0;
  private freshBlobs = new Set<string>();
  private urls = new Map<string, string>();
  private lastActivity = Date.now();
  private hiddenAt: number | null = null;
  private suppressUntil = 0;
  private clipboardPending: number | null = null;
  private clipboardTimer: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannel | null = null;
  private readonly tabId = newId();
  private started = false;
  now: () => number = () => Date.now();

  // ---------- store plumbing ----------

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getState = () => this.state;
  private set(patch: Partial<SessionState>) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }
  get vault(): Vault | null { return this.state.vault; }

  async init(store?: Store): Promise<void> {
    try {
      this.store = store ?? (await openStore());
      this.env = await this.store.getEnvelope();
      this.legacyEnv = readLegacyV1();
      const support = await biometricSupport().catch(() => "unsupported" as BiometricSupport);
      this.set({
        status: this.env || this.legacyEnv ? "locked" : "setup",
        storeKind: this.store.kind,
        persisted: await isPersisted(),
        legacy: !this.env && !!this.legacyEnv,
        legacyExtra: !!this.env && !!this.legacyEnv,
        biometric: { support, enrolled: !!this.env?.keys.biometric },
      });
      await this.pruneRetired();
    } catch (e) {
      this.set({ status: "setup", fatal: (e as Error).message });
    }
    this.start();
  }

  // ---------- create / unlock / lock ----------

  async create(password: string): Promise<void> {
    const { env, dek } = await createEnvelope(password, emptyVault());
    await this.store.putEnvelope(env);
    this.env = env;
    this.onUnlocked(dek, emptyVault());
    this.afterUnlock();
  }

  /** Throws WrongPasswordError. Upgrades an old-format vault on first unlock. */
  async unlock(password: string): Promise<void> {
    this.env = (await this.store.getEnvelope()) ?? this.env; // another tab may have saved since
    if (this.env) {
      const dek = await unlockEnvelope(this.env, password);
      const vault = normalizeVault(await openJSON(this.env.data, dek));
      this.onUnlocked(dek, vault);
    } else if (this.legacyEnv) {
      await this.migrateLegacy(this.legacyEnv, password);
    } else throw new Error("No vault on this device");
    this.afterUnlock();
  }

  async unlockWithBiometric(): Promise<void> {
    this.env = (await this.store.getEnvelope()) ?? this.env;
    const key = this.env?.keys.biometric;
    if (!this.env || !key) throw new Error("Fingerprint unlock isn't set up");
    const prf = await getBiometricPrf(key.credId, key.prfSalt);
    let dek: CryptoKey;
    try { dek = await unwrapWithBiometric(key, prf); }
    catch { throw new Error("Fingerprint unlock stopped working. Unlock with your master password and set it up again."); }
    const vault = normalizeVault(await openJSON(this.env.data, dek));
    this.onUnlocked(dek, vault);
    this.afterUnlock();
  }

  private onUnlocked(dek: CryptoKey, vault: Vault) {
    this.dek = dek;
    this.lastActivity = this.now();
    this.hiddenAt = null;
    this.set({ status: "unlocked", vault, lockReason: null, legacy: false, biometric: { ...this.state.biometric, enrolled: !!this.env?.keys.biometric }, save: { state: "idle", at: this.env?.updatedAt ?? null, error: null } });
  }

  private afterUnlock() {
    void requestPersistence().then(p => this.set({ persisted: p }));
    void this.store.listSnapshots().then(s => { this.lastSnapshotAt = s[0]?.at ?? 0; }).catch(() => undefined);
    const expired = this.vault ? expiredTrash(this.vault, this.now()) : [];
    if (expired.length) void this.commit(v => purgeItems(v, expired).vault).then(() => this.collectGarbage());
    else void this.collectGarbage();
  }

  /** Lock right now at the user's request (no automatic fingerprint prompt afterwards). */
  lockNow(): void { this.lock(LOCKED_MANUALLY); }

  lock(reason: string | null = null): void {
    if (this.state.status !== "unlocked") return;
    this.dek = null;
    this.freshBlobs.clear(); // any unsaved edit is gone with the lock; its blobs are now orphans
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.hiddenAt = null;
    this.set({ status: "locked", vault: null, lockReason: reason, legacy: false });
    if (typeof document === "undefined" || document.visibilityState === "visible") setCover(false);
  }

  private async migrateLegacy(v1: EnvelopeV1, password: string) {
    const raw = await openV1(v1, password); // WrongPasswordError on mismatch
    const { vault, images } = migrateV1(raw, this.now());
    const { env, dek } = await createEnvelope(password, vault);
    let v = vault;
    for (const img of images) {
      const decoded = dataUrlToBytes(img.dataUrl);
      if (!decoded) continue;
      const prep = await prepareBytes(decoded.bytes, decoded.mime, "Photo");
      const meta = await this.storeBlob(prep.bytes, prep.mime, prep.name, dek, prep.width, prep.height);
      v = { ...v, items: v.items.map(it => (it.id === img.itemId ? { ...it, attachments: [...it.attachments, meta] } : it)) };
    }
    const sealed = { ...env, data: await sealJSON(v, dek), updatedAt: this.now() };
    await this.store.putEnvelope(sealed);
    this.env = sealed;
    retireLegacyV1();
    this.legacyEnv = null;
    this.onUnlocked(dek, v);
    this.freshBlobs.clear();
    toasts.show(`Vault upgraded. ${liveItems(v).length} items moved to the new format.`, { ms: 5000 });
  }

  // ---------- saving ----------

  /** Apply a change and save it. Resolves when the save is verified; rejects if it failed. */
  commit(mutate: (v: Vault) => Vault, opts: { snapshot?: string } = {}): Promise<void> {
    if (this.state.status !== "unlocked" || !this.state.vault || !this.dek) return Promise.reject(new Error("Vault is locked"));
    const before = this.state.vault;
    const next = mutate(before);
    this.set({ vault: next });
    const dek = this.dek;
    const run = async () => {
      if (!this.env) throw new Error("No vault");
      this.set({ save: { ...this.state.save, state: "saving", error: null } });
      const stored = await this.store.getEnvelope();
      if (stored && stored.rev !== this.env.rev) throw new ConflictError();
      const now = this.now();
      if (opts.snapshot || now - this.lastSnapshotAt > AUTO_SNAPSHOT_MS) await this.snapshot(opts.snapshot ?? "Daily copy", before);
      const env: EnvelopeV2 = { ...this.env, data: await sealJSON(next, dek), rev: this.env.rev + 1, updatedAt: now };
      await this.store.putEnvelope(env);
      this.env = env;
      for (const id of referencedAttachments(next)) this.freshBlobs.delete(id);
      this.channel?.postMessage({ type: "saved", rev: env.rev, from: this.tabId });
      this.set({ save: { state: "saved", at: now, error: null } });
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => undefined);
    return p.catch(err => {
      if (err instanceof ConflictError) {
        this.lock("The vault was changed in another tab. Unlock to load the latest version.");
        throw err;
      }
      const msg = err instanceof SaveVerifyError ? err.message : "The browser refused to save (" + ((err as Error)?.message ?? "unknown error") + ")";
      this.set({ save: { state: "error", at: this.state.save.at, error: msg } });
      throw err;
    });
  }

  flush(): Promise<void> { return this.queue; }

  retrySave(): Promise<void> { return this.commit(v => v); }

  private async snapshot(reason: string, before: Vault) {
    if (!this.env || before.items.length === 0) return; // nothing worth going back to
    const snap: Snapshot = { at: this.now(), reason, count: liveItems(before).length, data: this.env.data, attachmentIds: referencedAttachments(before) };
    await this.store.putSnapshot(snap);
    this.lastSnapshotAt = snap.at;
    const all = await this.store.listSnapshots();
    if (all.length > SNAPSHOT_KEEP) await this.store.deleteSnapshots(all.slice(SNAPSHOT_KEEP).map(s => s.at));
  }

  listSnapshots(): Promise<Snapshot[]> { return this.store.listSnapshots(); }

  async restoreSnapshot(s: Snapshot): Promise<void> {
    if (!this.dek) throw new Error("Vault is locked");
    const v = normalizeVault(await openJSON(s.data, this.dek));
    await this.commit(cur => ({ ...v, settings: cur.settings }), { snapshot: "Before restoring an earlier version" });
  }

  /** Delete attachment blobs nothing refers to (current vault, snapshots, replaced vaults, unsaved edits). */
  async collectGarbage(): Promise<void> {
    if (!this.vault) return;
    try {
      // List first, decide last: a blob added while we await (a new photo) is either not in
      // `ids` yet or already in freshBlobs by the time we filter — never deleted by mistake.
      const ids = await this.store.listBlobIds();
      const snaps = await this.store.listSnapshots();
      const retired = await this.store.listRetired();
      if (!this.vault) return;
      const keep = new Set<string>([...referencedAttachments(this.vault), ...this.freshBlobs]);
      for (const s of snaps) for (const id of s.attachmentIds) keep.add(id);
      for (const r of retired) for (const id of r.attachmentIds) keep.add(id);
      const dead = ids.filter(id => !keep.has(id));
      if (dead.length) await this.store.deleteBlobs(dead);
    } catch { /* never block the user on cleanup */ }
  }

  // ---------- items ----------

  async addItem(draft: ItemDraft): Promise<Item> {
    let created: Item | null = null;
    await this.commit(v => { const r = addItem(v, draft, this.now()); created = r.item; return r.vault; });
    return created!;
  }

  /** Add imported items; pictures[i] become encrypted attachments of drafts[i]. */
  async importItems(drafts: ItemDraft[], pictures: SheetPicture[][] = [], onProgress?: (done: number, total: number) => void): Promise<{ pictures: number; skipped: number }> {
    if (!this.dek) throw new Error("Vault is locked");
    const dek = this.dek;
    const total = pictures.reduce((n, p) => n + (p?.length ?? 0), 0);
    let done = 0, skipped = 0;
    const ready: ItemDraft[] = [];
    for (let i = 0; i < drafts.length; i++) {
      const metas: AttachmentMeta[] = [];
      for (const pic of pictures[i] ?? []) {
        if (this.dek !== dek) throw new Error("The vault locked during the import. Nothing was added."); // locked or reset meanwhile
        this.lastActivity = this.now(); // a long picture import counts as use, so auto-lock waits
        try {
          const p = await prepareBytes(pic.bytes, pic.mime, pic.name);
          metas.push(await this.storeBlob(p.bytes, p.mime, p.name, dek, p.width, p.height));
        } catch { skipped++; }
        onProgress?.(++done, total);
      }
      const had = Array.isArray(drafts[i].attachments) ? (drafts[i].attachments as AttachmentMeta[]) : [];
      ready.push(metas.length ? { ...drafts[i], attachments: [...had, ...metas] } : drafts[i]);
    }
    await this.commit(v => addItems(v, ready, this.now()), { snapshot: "Before import" });
    return { pictures: done - skipped, skipped };
  }

  markUsed(id: string): void {
    void this.commit(v => touchUsed(v, id, this.now())).catch(() => undefined);
  }

  // ---------- attachments ----------

  private async storeBlob(bytes: Uint8Array<ArrayBuffer>, mime: string, name: string, dek: CryptoKey, width?: number, height?: number): Promise<AttachmentMeta> {
    const id = newId();
    await this.store.putBlob(id, await sealBytes(bytes, dek));
    this.freshBlobs.add(id);
    return { id, name, mime, size: bytes.length, width, height, addedAt: this.now() };
  }

  async addAttachment(file: File): Promise<AttachmentMeta> {
    if (!this.dek) throw new Error("Vault is locked");
    const p = await prepareFile(file);
    return this.storeBlob(p.bytes, p.mime, p.name, this.dek, p.width, p.height);
  }

  async attachmentBytes(meta: AttachmentMeta): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.dek) throw new Error("Vault is locked");
    const b = await this.store.getBlob(meta.id);
    if (!b) throw new Error("This attachment is missing from this device.");
    return openBytes(b, this.dek);
  }

  async attachmentUrl(meta: AttachmentMeta): Promise<string> {
    const cached = this.urls.get(meta.id);
    if (cached) return cached;
    const bytes = await this.attachmentBytes(meta);
    const url = URL.createObjectURL(new Blob([bytes], { type: meta.mime }));
    if (this.state.status !== "unlocked") { URL.revokeObjectURL(url); throw new Error("Vault is locked"); }
    this.urls.set(meta.id, url);
    return url;
  }

  // ---------- settings / password / biometric ----------

  updateSettings(patch: Partial<VaultSettings>): Promise<void> {
    return this.commit(v => ({ ...v, settings: { ...v.settings, ...patch } }));
  }

  async verifyPassword(password: string): Promise<boolean> {
    if (!this.env) return false;
    try { await unlockEnvelope(this.env, password); return true; } catch { return false; }
  }

  async changePassword(current: string, next: string): Promise<void> {
    await this.flush();
    if (!this.env) throw new Error("No vault");
    const env2 = await rewrapPassword(this.env, current, next); // WrongPasswordError
    const env = { ...env2, rev: this.env.rev + 1, updatedAt: this.now() };
    await this.store.putEnvelope(env);
    this.env = env;
    this.channel?.postMessage({ type: "saved", rev: env.rev, from: this.tabId });
  }

  async enableBiometric(masterPassword: string): Promise<void> {
    await this.flush();
    if (!this.env) throw new Error("No vault");
    const raw = await unlockEnvelope(this.env, masterPassword, true);
    const { credId, prfSalt, prfOutput } = await enrollBiometric();
    const key = await wrapForBiometric(raw, prfOutput, credId, prfSalt);
    const env = { ...this.env, keys: { ...this.env.keys, biometric: key }, rev: this.env.rev + 1, updatedAt: this.now() };
    await this.store.putEnvelope(env);
    this.env = env;
    this.set({ biometric: { ...this.state.biometric, enrolled: true } });
  }

  async disableBiometric(): Promise<void> {
    await this.flush();
    if (!this.env) return;
    const keys = { ...this.env.keys };
    delete keys.biometric;
    const env = { ...this.env, keys, rev: this.env.rev + 1, updatedAt: this.now() };
    await this.store.putEnvelope(env);
    this.env = env;
    this.set({ biometric: { ...this.state.biometric, enrolled: false } });
  }

  kdfInfo() { return this.env ? { alg: this.env.kdf.alg, iterations: this.env.kdf.iterations } : null; }

  // ---------- backups ----------

  async exportBackup(appVersion: string): Promise<Blob> {
    await this.flush();
    if (!this.env || !this.vault) throw new Error("Vault is locked");
    const blobs = new Map<string, { iv: Uint8Array; ct: Uint8Array }>();
    for (const id of referencedAttachments(this.vault)) { const b = await this.store.getBlob(id); if (b) blobs.set(id, b); }
    const file = buildBackupFile(this.env, blobs, appVersion);
    return new Blob([JSON.stringify(file)], { type: "application/json" });
  }

  parseBackup(text: string): ParsedBackup { return parseBackup(text); }

  openBackup(parsed: ParsedBackup, password: string): Promise<OpenedBackup> {
    return openBackup(parsed, password, (b, m) => prepareBytes(b, m, "Photo"));
  }

  /** Bring a backup's attachments into this vault's storage (re-encrypted with this vault's key). */
  private async importFiles(opened: OpenedBackup, vault: Vault): Promise<void> {
    if (!this.dek) throw new Error("Vault is locked");
    const have = new Set(await this.store.listBlobIds());
    for (const id of referencedAttachments(vault)) {
      const f = opened.files.get(id);
      if (!f || have.has(id)) continue;
      await this.store.putBlob(id, await sealBytes(f.bytes, this.dek));
      this.freshBlobs.add(id);
    }
  }

  async mergeBackup(opened: OpenedBackup): Promise<{ added: number; skipped: number }> {
    if (!this.vault) throw new Error("Vault is locked");
    const r = mergeVaults(this.vault, opened.vault);
    await this.importFiles(opened, { ...opened.vault, items: r.added });
    await this.commit(() => r.vault, { snapshot: "Before merging a backup" });
    return { added: r.added.length, skipped: r.skipped };
  }

  async replaceWithBackup(opened: OpenedBackup): Promise<void> {
    await this.importFiles(opened, opened.vault);
    await this.commit(cur => ({ ...opened.vault, settings: cur.settings }), { snapshot: "Before replacing with a backup" });
  }

  /** From the lock/setup screen: the backup becomes this device's vault, with the backup's password. */
  async adoptBackup(opened: OpenedBackup, password: string): Promise<void> {
    await this.retireCurrent("Replaced by a backup");
    if (opened.parsed.kind === "v2") {
      const file = opened.parsed.file;
      for (const [id, b] of Object.entries(file.blobs)) await this.store.putBlob(id, { iv: fromB64(b.iv), ct: fromB64(b.ct) });
      const env: EnvelopeV2 = { ...file.envelope, rev: (this.env?.rev ?? 0) + 1, updatedAt: this.now() };
      await this.store.putEnvelope(env);
      this.env = env;
      const dek = await unlockEnvelope(env, password);
      this.onUnlocked(dek, normalizeVault(await openJSON(env.data, dek)));
    } else {
      const { env, dek } = await createEnvelope(password, emptyVault());
      this.env = { ...env, rev: (this.env?.rev ?? 0) + 1 };
      this.dek = dek;
      let v = opened.vault;
      for (const [id, f] of opened.files) { await this.store.putBlob(id, await sealBytes(f.bytes, dek)); this.freshBlobs.add(id); }
      v = normalizeVault(v);
      const sealed = { ...this.env, data: await sealJSON(v, dek), updatedAt: this.now() };
      await this.store.putEnvelope(sealed);
      this.env = sealed;
      this.onUnlocked(dek, v);
    }
    this.set({ biometric: { ...this.state.biometric, enrolled: !!this.env?.keys.biometric } });
    this.afterUnlock();
  }

  /** Legacy (old-format) vault found next to a v2 vault: open it for merging. */
  async openLegacy(password: string): Promise<OpenedBackup | null> {
    const v1 = readLegacyV1();
    if (!v1) return null;
    return this.openBackup({ kind: "v1", env: v1 }, password);
  }

  dismissLegacy(): void { retireLegacyV1(); this.legacyEnv = null; this.set({ legacyExtra: false }); }

  // ---------- replaced vaults and reset ----------

  private async retireCurrent(reason: string) {
    if (!this.env) return;
    const ids = await this.store.listBlobIds();
    await this.store.putRetired({ at: this.now(), reason, env: this.env, attachmentIds: ids });
  }

  listRetired(): Promise<Retired[]> { return this.store.listRetired(); }

  async recoverRetired(r: Retired, password: string): Promise<void> {
    const dek = await unlockEnvelope(r.env, password); // WrongPasswordError
    await this.retireCurrent("Swapped for a recovered vault");
    const env = { ...r.env, rev: (this.env?.rev ?? 0) + 1, updatedAt: this.now() };
    await this.store.putEnvelope(env);
    await this.store.deleteRetired([r.at]);
    this.env = env;
    this.onUnlocked(dek, normalizeVault(await openJSON(env.data, dek)));
    this.afterUnlock();
  }

  private async pruneRetired() {
    try {
      const old = (await this.store.listRetired()).filter(r => this.now() - r.at > RETIRED_DAYS * DAY);
      await this.store.deleteRetired(old.map(r => r.at));
    } catch { /* ignore */ }
  }

  async reset(keepRecoveryCopy: boolean): Promise<void> {
    this.lock(null);
    if (keepRecoveryCopy) await this.retireCurrent("Reset");
    else {
      const retiredIds = new Set((await this.store.listRetired()).flatMap(r => r.attachmentIds));
      await this.store.deleteBlobs((await this.store.listBlobIds()).filter(id => !retiredIds.has(id)));
    }
    await this.store.deleteSnapshots((await this.store.listSnapshots()).map(s => s.at));
    await this.store.deleteEnvelope();
    retireLegacyV1();
    this.legacyEnv = null;
    this.env = null;
    this.set({ status: "setup", legacy: false, legacyExtra: false, biometric: { ...this.state.biometric, enrolled: false }, lockReason: null });
  }

  // ---------- auto-lock, app switching, clipboard, tabs ----------

  /** Call before opening a file picker, camera or share sheet so leaving the app doesn't lock it. */
  suppressLock(ms = 120_000) { this.suppressUntil = this.now() + ms; }
  endSuppress() { this.suppressUntil = 0; }

  private activity = () => { this.lastActivity = this.now(); };

  tick = () => {
    if (this.state.status !== "unlocked" || !this.vault) return;
    const idleMs = Math.max(1, this.vault.settings.idleLockMin) * 60_000;
    if (this.now() - this.lastActivity >= idleMs && this.now() >= this.suppressUntil) this.lock("Locked after inactivity");
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") {
      if (this.state.status !== "unlocked" || !this.vault) return;
      if (this.now() < this.suppressUntil) return;
      this.hiddenAt = this.now();
      setCover(true);
      if (this.vault.settings.leaveLockSec <= 0) this.lock("Locked when you left the app");
    } else {
      if (this.hiddenAt != null && this.state.status === "unlocked" && this.vault) {
        if (this.now() - this.hiddenAt >= this.vault.settings.leaveLockSec * 1000) this.lock("Locked when you left the app");
      }
      this.hiddenAt = null;
      setCover(false);
      this.lastActivity = this.now();
      this.tryPendingClipboardClear();
    }
  };

  private start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(ev, this.activity, { capture: true, passive: true });
    document.addEventListener("scroll", this.activity, { capture: true, passive: true });
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", () => this.lock("Locked when you left the app"));
    window.addEventListener("focus", () => this.tryPendingClipboardClear());
    window.addEventListener("beforeunload", e => { if (this.state.save.state === "saving" || this.state.save.state === "error") { e.preventDefault(); e.returnValue = ""; } });
    setInterval(this.tick, 1000);
    try {
      this.channel = new BroadcastChannel("pwvault");
      this.channel.onmessage = ev => {
        const m = ev.data as { type: string; rev: number; from: string };
        if (m?.type !== "saved" || m.from === this.tabId) return;
        if (this.state.status === "unlocked" && this.env && m.rev !== this.env.rev) this.lock("The vault was changed in another tab. Unlock to load the latest version.");
        void this.store.getEnvelope().then(e => { if (e && this.state.status !== "unlocked") { this.env = e; this.set({ biometric: { ...this.state.biometric, enrolled: !!e.keys.biometric } }); } });
      };
    } catch { /* BroadcastChannel unavailable */ }
  }

  async copy(text: string, label: string, itemId?: string): Promise<void> {
    const ok = await writeClipboard(text);
    if (!ok) { toasts.error("Couldn't copy. Long-press the value to copy it."); return; }
    if (itemId) this.markUsed(itemId);
    const sec = this.vault?.settings.clipboardSec ?? 30;
    toasts.show(sec > 0 ? `${label} copied. Clears in ${sec} s.` : `${label} copied`);
    if (this.clipboardTimer) clearTimeout(this.clipboardTimer);
    if (sec > 0) {
      const at = this.now();
      this.clipboardPending = at;
      this.clipboardTimer = setTimeout(() => this.tryPendingClipboardClear(), sec * 1000);
    }
  }

  /** Clearing needs the page focused; if you're in another app, it happens when you come back (within 10 min). */
  private tryPendingClipboardClear() {
    if (this.clipboardPending == null) return;
    const sec = this.vault?.settings.clipboardSec ?? 30;
    if (this.now() - this.clipboardPending < sec * 1000) return;
    if (this.now() - this.clipboardPending > 10 * 60_000) { this.clipboardPending = null; return; }
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    void writeClipboard("").then(ok => { if (ok) this.clipboardPending = null; });
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text || " ";
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Blank the screen while the app is in the background (recent-apps thumbnail). */
function setCover(on: boolean) {
  if (typeof document !== "undefined") document.documentElement.classList.toggle("privacy-cover", on);
}

export { WrongPasswordError };
export const session = new Session();
