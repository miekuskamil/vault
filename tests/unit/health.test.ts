import { analyzeHealth } from "../../src/core/health";
import { addItem, emptyVault, updateItem } from "../../src/core/model";

describe("health", () => {
  it("finds weak, reused and old passwords; ignores notes and trash", () => {
    let v = emptyVault();
    const now = Date.UTC(2026, 8, 25);
    for (const t of ["Amazon Prime", "Medium", "Netflix"]) v = addItem(v, { title: t, password: "123" }, now).vault;
    v = addItem(v, { title: "Bank", password: "vM3#kP9$wQ2!zR7&", type: "bank" }, now - 400 * 86_400_000).vault;
    v = addItem(v, { title: "Strong", password: "Tq8#nV4!xK2@pL6$" }, now).vault;
    v = addItem(v, { title: "A note", type: "note", password: "" }, now).vault;
    const r = analyzeHealth(v, now);
    expect(r.checked).toBe(5);
    expect(r.weak.map(i => i.title).sort()).toEqual(["Amazon Prime", "Medium", "Netflix"]);
    expect(r.reused).toHaveLength(1);
    expect(r.reused[0]).toHaveLength(3);
    expect(r.old.map(i => i.title)).toEqual(["Bank"]);
    expect(r.score).toBe(20);
    const fixed = updateItem(v, v.items[3].id, { password: "Zx9!vB3@nM6#qW1$" }, now);
    expect(analyzeHealth(fixed, now).old).toHaveLength(0);
  });
});
