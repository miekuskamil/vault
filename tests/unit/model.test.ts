import { addItem, addItems, categoriesOf, emptyVault, expiredTrash, mergeVaults, migrateV1, moveItems, normalizeVault, purgeItems, queryItems, renameCategory, restoreItems, setFavorite, sortItems, touchUsed, trashItems, updateItem, HISTORY_LIMIT, type Vault } from "../../src/core/model";

function seed(): Vault {
  let v = emptyVault();
  for (const t of ["Alpha", "Bravo", "Charlie"]) v = addItem(v, { title: t, category: "Test", password: "pw-" + t }, 1000).vault;
  return v;
}

describe("model", () => {
  it("edit keeps the item's position (v1 moved it to the bottom)", () => {
    let v = seed();
    const id = v.items[0].id;
    v = updateItem(v, id, { notes: "edited" }, 2000);
    expect(v.items.map(i => i.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(v.items[0].notes).toBe("edited");
    expect(v.items[0].updatedAt).toBe(2000);
    expect(v.items[0].createdAt).toBe(1000);
  });
  it("edit preserves fields the editor doesn't know about", () => {
    let v = seed();
    const id = v.items[0].id;
    v = { ...v, items: v.items.map(i => (i.id === id ? { ...i, futureFeature: { x: 1 }, favorite: true } : i)) };
    v = updateItem(v, id, { title: "Alpha 2" }, 3000);
    expect(v.items[0].futureFeature).toEqual({ x: 1 });
    expect(v.items[0].favorite).toBe(true);
  });
  it("password change goes into history, capped, newest first", () => {
    let v = seed();
    const id = v.items[0].id;
    for (let i = 1; i <= 7; i++) v = updateItem(v, id, { password: "new-" + i }, 1000 + i);
    const it = v.items[0];
    expect(it.password).toBe("new-7");
    expect(it.history.length).toBe(HISTORY_LIMIT);
    expect(it.history[0].password).toBe("new-6");
    expect(it.passwordChangedAt).toBe(1007);
  });
  it("non-password edits don't touch history or passwordChangedAt", () => {
    let v = seed();
    const id = v.items[1].id;
    const before = v.items[1].passwordChangedAt;
    v = updateItem(v, id, { password: "pw-Bravo", notes: "x" }, 5000);
    expect(v.items[1].history).toEqual([]);
    expect(v.items[1].passwordChangedAt).toBe(before);
  });
  it("trash, restore, purge and expiry", () => {
    let v = seed();
    const [a, b] = v.items.map(i => i.id);
    v = trashItems(v, [a, b], 10_000);
    expect(queryItems(v, {}).map(i => i.title)).toEqual(["Charlie"]);
    v = restoreItems(v, [b]);
    expect(queryItems(v, {}).length).toBe(2);
    expect(expiredTrash(v, 10_000 + 29 * 86_400_000)).toEqual([]);
    expect(expiredTrash(v, 10_000 + 30 * 86_400_000)).toEqual([a]);
    const withAtt = { ...v, items: v.items.map(i => (i.id === a ? { ...i, attachments: [{ id: "att1", name: "x", mime: "image/jpeg", size: 1, addedAt: 0 }] } : i)) };
    const r = purgeItems(withAtt, [a]);
    expect(r.orphanedAttachments).toEqual(["att1"]);
    expect(r.vault.items.find(i => i.id === a)).toBeUndefined();
  });
  it("search covers title, username, url, notes, category and visible custom fields but not hidden values", () => {
    let v = emptyVault();
    v = addItem(v, { title: "HSBC", category: "Konta bankowe", username: "kamil01", url: "hsbc.co.uk", notes: "online banking", fields: [{ id: "1", label: "Sort code", value: "40-11-22", hidden: false }, { id: "2", label: "PIN", value: "9876", hidden: true }] }).vault;
    for (const q of ["hsbc", "kamil", "co.uk", "banking", "konta", "40-11", "sort code", "pin"]) expect(queryItems(v, { text: q }).length).toBe(1);
    expect(queryItems(v, { text: "9876" }).length).toBe(0);
    expect(queryItems(v, { text: "hsbc banking" }).length).toBe(1);
  });
  it("favorites, categories, move and rename", () => {
    let v = seed();
    v = addItem(v, { title: "Delta", category: "Other" }).vault;
    v = setFavorite(v, v.items[3].id, true);
    expect(queryItems(v, { favoritesOnly: true }).map(i => i.title)).toEqual(["Delta"]);
    expect(categoriesOf(v)).toEqual([{ name: "Test", count: 3 }, { name: "Other", count: 1 }]);
    v = moveItems(v, [v.items[0].id], "Other");
    expect(categoriesOf(v)).toEqual([{ name: "Test", count: 2 }, { name: "Other", count: 2 }]);
    v = renameCategory(v, "Test", "Other");
    expect(categoriesOf(v)).toEqual([{ name: "Other", count: 4 }]);
  });
  it("sorts A-Z (locale, numeric), recent and by category order", () => {
    let v = emptyVault();
    for (const t of ["zeta", "Alpha", "item 10", "item 2"]) v = addItem(v, { title: t, category: t === "zeta" ? "B" : "A" }).vault;
    expect(sortItems(queryItems(v, {}), "az").map(i => i.title)).toEqual(["Alpha", "item 2", "item 10", "zeta"]);
    v = touchUsed(v, v.items[3].id, 99);
    expect(sortItems(queryItems(v, {}), "recent")[0].title).toBe("item 2");
    expect(sortItems(queryItems(v, {}), "category", ["A", "B"]).map(i => i.category)).toEqual(["A", "A", "A", "B"]);
  });
  it("merge skips items already present by id or content", () => {
    const base = seed();
    let other = normalizeVault(JSON.parse(JSON.stringify(base)));
    other = addItem(other, { title: "Echo", category: "New" }).vault;
    other = addItems(other, [{ title: "Alpha", category: "Elsewhere", password: "pw-Alpha" }]);
    const r = mergeVaults(base, other);
    expect(r.added.map(i => i.title)).toEqual(["Echo"]);
    expect(r.skipped).toBe(4);
  });
  it("migrates the v1 shape, keeping images aside and unknown keys", () => {
    const v1 = { categories: [
      { name: "Subskrypcje", entries: [{ id: "1-2-3", site: "Netflix", username: "u", password: "p", url: "https://netflix.com", notes: "n", image: "data:image/jpeg;base64,AAAA", weird: 5 }] },
      { name: "", entries: [{ site: "", password: "x" }] },
    ] };
    const { vault, images } = migrateV1(v1, 42);
    expect(vault.items.length).toBe(2);
    const n = vault.items[0];
    expect([n.type, n.title, n.category, n.username, n.password, n.url, n.notes]).toEqual(["login", "Netflix", "Subskrypcje", "u", "p", "https://netflix.com", "n"]);
    expect(n.weird).toBe(5);
    expect(n.passwordChangedAt).toBeNull();
    expect(images).toEqual([{ itemId: n.id, dataUrl: "data:image/jpeg;base64,AAAA" }]);
    expect(vault.items[1].title).toBe("(untitled)");
    expect(vault.items[1].category).toBe("Uncategorized");
  });
  it("normalizeVault tolerates junk", () => {
    const v = normalizeVault({ items: [{ title: 5, fields: [{ label: 1 }], type: "spaceship" }], settings: { idleLockMin: 15 } });
    expect(v.items[0].title).toBe("5");
    expect(v.items[0].type).toBe("login");
    expect(v.items[0].fields[0].label).toBe("1");
    expect(v.settings.idleLockMin).toBe(15);
    expect(v.settings.leaveLockSec).toBe(30);
  });
});
