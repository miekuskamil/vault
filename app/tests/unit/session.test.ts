import { IDBFactory } from "fake-indexeddb";
import { Session, ConflictError } from "../../src/core/session";
import { openStore, LEGACY_V1_KEY, LEGACY_V1_MIGRATED_KEY } from "../../src/core/storage";
import { WrongPasswordError } from "../../src/core/crypto";
import { makeV1 } from "./crypto.test";
import { updateItem, trashItems, liveItems } from "../../src/core/model";

const PW = "correct horse battery staple 9";

async function fresh(): Promise<Session> {
  const s = new Session();
  await s.init(await openStore());
  return s;
}

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("session", () => {
  it("setup → save → lock → unlock, and a wrong password is rejected", async () => {
    const s = await fresh();
    expect(s.getState().status).toBe("setup");
    expect(s.getState().storeKind).toBe("indexeddb");
    await s.create(PW);
    const item = await s.addItem({ title: "Netflix", password: "p1", category: "Subs" });
    expect(s.getState().save.state).toBe("saved");
    s.lock("test");
    expect(s.getState().status).toBe("locked");
    expect(s.getState().vault).toBeNull();
    await expect(s.unlock("wrong password")).rejects.toBeInstanceOf(WrongPasswordError);
    const s2 = await fresh(); // a reload
    expect(s2.getState().status).toBe("locked");
    await s2.unlock(PW);
    expect(s2.vault!.items.map(i => i.title)).toEqual(["Netflix"]);
    expect(s2.vault!.items[0].id).toBe(item.id);
  });

  it("auto-locks after inactivity every time, not just the first time (v1 bug)", async () => {
    const s = await fresh();
    let t = 1_000_000;
    s.now = () => t;
    await s.create(PW);
    for (let round = 0; round < 3; round++) {
      t += 4 * 60_000; s.tick();
      expect(s.getState().status).toBe("unlocked");
      t += 61_000; s.tick();
      expect(s.getState().status).toBe("locked");
      await s.unlock(PW);
    }
  });

  it("locking drops the vault from memory", async () => {
    const s = await fresh();
    await s.create(PW);
    await s.addItem({ title: "Bank", password: "S3cret-Example-Pass" });
    s.lock(null);
    expect(JSON.stringify(s.getState())).not.toContain("S3cret-Example-Pass");
  });

  it("snapshots before destructive changes and restores them", async () => {
    const s = await fresh();
    await s.create(PW);
    await s.addItem({ title: "A" });
    await s.addItem({ title: "B" });
    const ids = s.vault!.items.map(i => i.id);
    await s.commit(v => trashItems(v, ids), { snapshot: "Before deleting" });
    expect(liveItems(s.vault!).length).toBe(0);
    const snaps = await s.listSnapshots();
    const snap = snaps.find(x => x.reason === "Before deleting")!;
    expect(snap.count).toBe(2);
    await s.restoreSnapshot(snap);
    expect(liveItems(s.vault!).map(i => i.title)).toEqual(["A", "B"]);
  });

  it("refuses to overwrite a newer save from another tab", async () => {
    const a = await fresh();
    await a.create(PW);
    const store = await openStore();
    const b = new Session();
    await b.init(store);
    await b.unlock(PW);
    await b.addItem({ title: "from B" });
    await expect(a.addItem({ title: "from A" })).rejects.toBeInstanceOf(ConflictError);
    expect(a.getState().status).toBe("locked");
    await a.unlock(PW);
    expect(a.vault!.items.map(i => i.title)).toEqual(["from B"]);
  });

  it("migrates the v1 localStorage vault on first unlock, keeping a copy", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+XJ/PAAAAAElFTkSuQmCC";
    const v1 = await makeV1("old master pw", { categories: [{ name: "Zdrowie", entries: [{ id: "1", site: "Pension", username: "me", password: "pw", url: "", notes: "line1\nline2", image: png }] }] });
    localStorage.setItem(LEGACY_V1_KEY, JSON.stringify(v1));
    const s = await fresh();
    expect(s.getState().status).toBe("locked");
    expect(s.getState().legacy).toBe(true);
    await expect(s.unlock("nope nope nope")).rejects.toBeInstanceOf(WrongPasswordError);
    await s.unlock("old master pw");
    const it = s.vault!.items[0];
    expect([it.title, it.category, it.notes]).toEqual(["Pension", "Zdrowie", "line1\nline2"]);
    expect(it.attachments).toHaveLength(1);
    const bytes = await s.attachmentBytes(it.attachments[0]);
    expect(bytes.length).toBeGreaterThan(20);
    expect(localStorage.getItem(LEGACY_V1_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_V1_MIGRATED_KEY)).toContain(v1.ct);
    const s2 = await fresh();
    await s2.unlock("old master pw");
    expect(s2.vault!.items[0].attachments).toHaveLength(1);
  });

  it("stores attachments separately so many large files still save (v1 lost everything past ~2.8 MB)", async () => {
    const s = await fresh();
    await s.create(PW);
    const metas = [];
    for (let i = 0; i < 5; i++) {
      const f = new File([new Uint8Array(3 * 1024 * 1024).fill(i + 1)], `scan${i}.pdf`, { type: "application/pdf" });
      metas.push(await s.addAttachment(f));
    }
    await s.addItem({ title: "Pension", attachments: metas });
    expect(s.getState().save.state).toBe("saved");
    const s2 = await fresh();
    await s2.unlock(PW);
    const back = await s2.attachmentBytes(s2.vault!.items[0].attachments[4]);
    expect(back.length).toBe(3 * 1024 * 1024);
    expect(back[0]).toBe(5);
  });

  it("garbage-collects attachments nothing refers to, but keeps ones in snapshots", async () => {
    const s = await fresh();
    await s.create(PW);
    const keep = await s.addAttachment(new File([new Uint8Array(10)], "a.pdf", { type: "application/pdf" }));
    const orphan = await s.addAttachment(new File([new Uint8Array(10)], "b.pdf", { type: "application/pdf" }));
    const item = await s.addItem({ title: "X", attachments: [keep] });
    void orphan;
    await s.commit(v => updateItem(v, item.id, { attachments: [] }), { snapshot: "Before edit" });
    s.lock(null);
    await s.unlock(PW); // unlock runs cleanup
    await new Promise(r => setTimeout(r, 50));
    const store = await openStore();
    const ids = await store.listBlobIds();
    expect(ids).toContain(keep.id);          // still referenced by the snapshot
    expect(ids).not.toContain(orphan.id);    // never saved anywhere
  });

  it("change master password", async () => {
    const s = await fresh();
    await s.create(PW);
    await s.addItem({ title: "A" });
    await expect(s.changePassword("wrong one", "new master password 42")).rejects.toBeInstanceOf(WrongPasswordError);
    await s.changePassword(PW, "new master password 42");
    const s2 = await fresh();
    await expect(s2.unlock(PW)).rejects.toBeInstanceOf(WrongPasswordError);
    await s2.unlock("new master password 42");
    expect(s2.vault!.items).toHaveLength(1);
    const snaps = await s2.listSnapshots();
    if (snaps[0]) await s2.restoreSnapshot(snaps[0]); // snapshots survive a password change
  });

  it("backup → open with its password → merge / replace / adopt", async () => {
    const a = await fresh();
    await a.create(PW);
    const att = await a.addAttachment(new File([new Uint8Array([9, 9, 9])], "x.pdf", { type: "application/pdf" }));
    await a.addItem({ title: "From backup", password: "b", attachments: [att] });
    const text = await (await a.exportBackup("test")).text();
    expect(text).not.toContain("From backup");

    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    const b = await fresh();
    await b.create("other device password 1");
    await b.addItem({ title: "Local only" });
    const parsed = b.parseBackup(text);
    await expect(b.openBackup(parsed, "wrong")).rejects.toBeInstanceOf(WrongPasswordError);
    const opened = await b.openBackup(parsed, PW);
    const r = await b.mergeBackup(opened);
    expect(r).toEqual({ added: 1, skipped: 0 });
    expect(liveItems(b.vault!).map(i => i.title).sort()).toEqual(["From backup", "Local only"]);
    const merged = b.vault!.items.find(i => i.title === "From backup")!;
    expect(Array.from(await b.attachmentBytes(merged.attachments[0]))).toEqual([9, 9, 9]);
    expect(await b.mergeBackup(opened)).toEqual({ added: 0, skipped: 1 });

    await b.replaceWithBackup(opened);
    expect(liveItems(b.vault!).map(i => i.title)).toEqual(["From backup"]);

    // lock screen: adopt the backup with ITS password; the replaced vault is kept for recovery
    b.lock(null);
    await b.adoptBackup(opened, PW);
    expect(b.getState().status).toBe("unlocked");
    const c = await fresh();
    await expect(c.unlock("other device password 1")).rejects.toBeInstanceOf(WrongPasswordError);
    await c.unlock(PW);
    const retired = await c.listRetired();
    expect(retired).toHaveLength(1);
    c.lock(null);
    await c.recoverRetired(retired[0], "other device password 1");
    expect(liveItems(c.vault!).map(i => i.title)).toEqual(["From backup"]);
  });

  it("opens a v1 backup file and migrates its images", async () => {
    const v1 = await makeV1("v1 file pw", { categories: [{ name: "X", entries: [{ site: "Old", password: "p", image: "data:application/pdf;base64,JVBERi0=" }] }] });
    const s = await fresh();
    await s.create(PW);
    const opened = await s.openBackup(s.parseBackup(JSON.stringify(v1)), "v1 file pw");
    expect(opened.kind).toBe("v1");
    await s.mergeBackup(opened);
    const it = s.vault!.items[0];
    expect(it.title).toBe("Old");
    expect(it.attachments).toHaveLength(1);
  });

  it("reset returns to setup and keeps a recovery copy only when asked", async () => {
    const s = await fresh();
    await s.create(PW);
    await s.addItem({ title: "A" });
    await s.reset(true);
    expect(s.getState().status).toBe("setup");
    expect(await s.listRetired()).toHaveLength(1);
    await s.create("second vault password 7");
    await s.reset(false);
    expect(await s.listRetired()).toHaveLength(1); // the first recovery copy is untouched
  });

  it("settings persist and the idle limit follows them", async () => {
    const s = await fresh();
    let t = 5_000_000;
    s.now = () => t;
    await s.create(PW);
    await s.updateSettings({ idleLockMin: 1 });
    t += 61_000; s.tick();
    expect(s.getState().status).toBe("locked");
  });
});
