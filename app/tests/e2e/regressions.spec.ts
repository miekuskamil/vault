// The nine problems found in the v1 audit, each turned into a check the new build must pass.
import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { addLogin, createVault, lockNow, open, PW, SINGLE, titles, unlock, watch } from "./helpers";

test("1. auto-lock keeps working after every unlock", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await createVault(page);
  for (let round = 0; round < 3; round++) {
    await page.clock.runFor(4 * 60_000);
    await expect(page.locator(".nav")).toBeVisible();
    await page.clock.runFor(70_000);
    await expect(page.locator(".lock-card")).toBeVisible();
    await expect(page.getByText("Locked after inactivity")).toBeVisible();
    await unlock(page);
  }
});

test("2. locking removes every secret from the screen and the DOM", async ({ page }) => {
  await open(page);
  await createVault(page);
  await addLogin(page, { title: "Example Bank", username: "me@example.com", password: "S3cret-Example-Pass" });
  await page.locator(".item-row .main").first().click();
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(page.getByText("S3cret-Example-Pass")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#f-password")).toHaveValue("S3cret-Example-Pass");
  await page.locator(".page").last().getByRole("button", { name: "Back", exact: true }).click();
  await page.locator(".page").last().getByRole("button", { name: "Back", exact: true }).click();
  await lockNow(page);
  const html = await page.content();
  const values = await page.evaluate(() => [...document.querySelectorAll("input, textarea")].map(e => (e as HTMLInputElement).value).join("|"));
  expect(html).not.toContain("S3cret-Example-Pass");
  expect(html).not.toContain("me@example.com");
  expect(values).not.toContain("S3cret-Example-Pass");
  await expect(page.locator(".page")).toHaveCount(0);
});

test("2b. auto-lock while the editor and a revealed password are open clears them", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await createVault(page);
  await addLogin(page, { title: "Example Bank", password: "S3cret-Example-Pass" });
  await page.locator(".item-row .main").first().click();
  await page.getByRole("button", { name: "Show password" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.clock.runFor(6 * 60_000);
  await expect(page.locator(".lock-card")).toBeVisible();
  expect(await page.content()).not.toContain("S3cret-Example-Pass");
  await page.screenshot({ path: "shots/reg-after-autolock.png" });
});

test("3. large photos save, survive a reload, and are shrunk before encryption", async ({ page }) => {
  await open(page);
  await createVault(page);
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Pension");
  const photo = path.resolve("tests/fixtures/photo.jpg");
  const original = fs.statSync(photo).size;
  for (let i = 0; i < 3; i++) {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach a photo or PDF" }).click();
    await (await chooser).setFiles(photo);
    await expect(page.locator(".form .thumb:not(.add)")).toHaveCount(i + 1, { timeout: 30_000 });
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".hero h1")).toHaveText("Pension");
  await expect(page.locator(".thumb img")).toHaveCount(3);
  const size = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("pwvault"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all: { ct: Uint8Array }[] = await new Promise(res => { const r = db.transaction("blobs").objectStore("blobs").getAll(); r.onsuccess = () => res(r.result); });
    return all.map(b => b.ct.byteLength);
  });
  expect(size).toHaveLength(3);
  for (const s of size) expect(s).toBeLessThan(original / 2);
  await page.reload();
  await unlock(page);
  await page.locator(".item-row .main").first().click();
  await expect(page.locator(".thumb img")).toHaveCount(3);
  await page.locator(".thumb button").first().click();
  await expect(page.locator(".viewer img")).toBeVisible();
});

test("4. opening a backup with the wrong password never replaces the vault", async ({ page }) => {
  await open(page);
  await createVault(page);
  await addLogin(page, { title: "Important", password: "keep-me" });
  await lockNow(page);
  await page.getByRole("button", { name: "Trouble unlocking?" }).click();
  await page.getByRole("button", { name: "Restore from a backup file" }).click();
  const fake = JSON.stringify({ v: 1, salt: "AAAAAAAAAAAAAAAAAAAAAA==", iv: "AAAAAAAAAAAAAAAA", ct: "AAAAAAAAAAAAAAAAAAAAAA==" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose backup file" }).click();
  await (await chooser).setFiles({ name: "old.vault", mimeType: "application/json", buffer: Buffer.from(fake) });
  await page.getByLabel("Backup's master password").fill("anything at all");
  await page.getByRole("button", { name: "Open backup" }).click();
  await expect(page.getByText("That password doesn't open this backup.")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await unlock(page);
  expect(await titles(page)).toEqual(["Important"]);
});

test("5. old-format vaults with a non-default key setting still open", async ({ page, context }) => {
  // made by the real v1 app, then its iteration count changed the way a future version might write it
  await page.goto(SINGLE);
  await page.evaluate(async () => {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const km = await crypto.subtle.importKey("raw", enc.encode("legacy pass 2023"), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify({ categories: [{ name: "Old", entries: [{ id: "1", site: "Kept", password: "x" }] }] }))));
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    localStorage.setItem("pwvault_blob_v1", JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct), kdf: "PBKDF2-SHA256", iterations: 250000 }));
  });
  void context;
  await page.reload();
  await unlock(page, "legacy pass 2023");
  expect(await titles(page)).toEqual(["Kept"]);
});

test("6. switching away locks per the setting and blanks the screen", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await createVault(page);
  await addLogin(page, { title: "Bank", password: "secret-1" });
  const hide = (hidden: boolean) => page.evaluate(h => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await hide(true);
  expect(await page.evaluate(() => document.documentElement.classList.contains("privacy-cover"))).toBe(true);
  await page.clock.runFor(10_000);
  await hide(false);
  await expect(page.locator(".nav")).toBeVisible(); // back within 30 s: still open
  await hide(true);
  await page.clock.runFor(31_000);
  await hide(false);
  await expect(page.locator(".lock-card")).toBeVisible();
  await expect(page.getByText("Locked when you left the app")).toBeVisible();
});

test("7. no spreadsheet library runs at startup; the app opens fast", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    await page.goto(SINGLE);
    await page.waitForSelector(".lock-card");
    times.push(await page.evaluate(() => performance.getEntriesByType("navigation")[0].toJSON().domContentLoadedEventEnd as number));
  }
  times.sort((a, b) => a - b);
  console.log("DOMContentLoaded @4x CPU (ms):", times.map(Math.round));
  expect(await page.evaluate(() => typeof (window as unknown as { XLSX?: unknown }).XLSX)).toBe("undefined");
  const html = fs.readFileSync(path.resolve("dist-single/index.html"), "utf-8");
  expect(html).not.toContain("SheetJS");
  expect(times[1]).toBeLessThan(479); // v1 measured 479 ms under the same throttle
});

test("8. master password meter rejects dictionary passwords", async ({ page }) => {
  await open(page);
  for (const weak of ["Password1234!", "zaq12wsx!", "Kochanie2024"]) {
    await page.getByLabel("Master password", { exact: true }).fill(weak);
    await page.getByLabel("Confirm master password").fill(weak);
    await page.getByRole("button", { name: "Create vault" }).click();
    await expect(page.getByText("Pick a stronger master password", { exact: false })).toBeVisible();
    await expect(page.locator(".nav")).toHaveCount(0);
  }
  await page.getByLabel("Master password", { exact: true }).fill("Password1234!");
  await expect(page.getByText(/Very weak|Weak/)).toBeVisible();
});

test("9. editing keeps order; notes keep line breaks and links; semicolon CSV imports", async ({ page }) => {
  const w = watch(page);
  await open(page);
  await createVault(page);
  for (const t of ["Alpha", "Bravo", "Charlie"]) await addLogin(page, { title: t, category: "Test", password: "pw-" + t });
  await page.locator(".item-row .main").first().click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Notes").fill("line one\nline two\nhttps://example.com/form");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".val.pre a")).toHaveAttribute("href", "https://example.com/form");
  const lines = await page.locator(".val.pre").evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  expect(await titles(page)).toEqual(["Alpha", "Bravo", "Charlie"]);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Import a spreadsheet/ }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles({ name: "hasla.csv", mimeType: "text/csv", buffer: Buffer.from("﻿vendor;URL;username;hasło;uwagi\r\nNetflix;https://netflix.com;a@example.com;pw;x\r\nSpotify;https://spotify.com;b@example.com;pw2;\r\n") });
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("3");
  await expect(page.getByRole("button", { name: "Import 2 items" })).toBeVisible();
  await page.getByRole("button", { name: "Import 2 items" }).click();
  await expect(page.getByText("added")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await expect(page.locator(".chip", { hasText: "hasla" })).toBeVisible();
  expect(w.errors).toEqual([]);
  expect(w.network).toEqual([]);
});

test("toasts sit above the bottom tabs, never on top of them", async ({ page }) => {
  await open(page);
  await createVault(page);
  await addLogin(page, { title: "Netflix", password: "pw" });
  await page.getByRole("button", { name: /Copy password for Netflix/ }).click();
  const toast = await page.locator(".toast").boundingBox();
  const nav = await page.locator(".nav").boundingBox();
  expect(toast && nav && toast.y + toast.height <= nav.y).toBeTruthy();
});

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await page.screenshot({ path: `shots/fail-${info.title.slice(0, 30).replace(/\W+/g, "-")}.png` }).catch(() => undefined);
});

void PW;
