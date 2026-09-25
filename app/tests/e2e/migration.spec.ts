// Your current vault, created by the real v1 app you use today, opened by the new build.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

import { open, SINGLE, titles, unlock, V1_APP, watch } from "./helpers";

const OLD_PW = "my old master pw 2024";

async function v1Add(page: Page, site: string, cat: string, user: string, pass: string, notes = "", photo?: string) {
  await page.evaluate(() => document.getElementById("bn-add")!.click());
  await page.fill("#f-site", site);
  await page.fill("#f-category", cat);
  await page.fill("#f-username", user);
  await page.fill("#f-password", pass);
  if (notes) await page.fill("#f-notes", notes);
  if (photo) { await page.setInputFiles("#f-image", photo); await page.waitForTimeout(500); }
  await page.evaluate(() => document.getElementById("btn-save-entry")!.click());
  await page.waitForFunction(() => !document.getElementById("entry-modal")!.classList.contains("active"));
}

async function makeV1Vault(page: Page) {
  await page.goto(V1_APP);
  await page.fill("#setup-pass", OLD_PW);
  await page.fill("#setup-pass2", OLD_PW);
  await page.evaluate(() => document.getElementById("btn-setup")!.click());
  await page.waitForFunction(() => document.getElementById("app")!.classList.contains("active"), null, { timeout: 20_000 });
  const small = path.resolve("tests/fixtures/small.jpg");
  await v1Add(page, "Netflix", "Subskrypcje", "a@example.com", "123");
  await v1Add(page, "Medium", "Subskrypcje", "b@example.com", "123");
  await v1Add(page, "HSBC", "Konta bankowe", "kamil01", "S3cret!pass", "Sort code 40-11-22\nhttps://www.hsbc.co.uk");
  await v1Add(page, "Pension", "Zdrowie", "me@example.com", "Pension#2024", "", small);
}


test("a vault made by the current app upgrades on first unlock, with its photo", async ({ page }) => {
  const w = watch(page);
  await makeV1Vault(page);
  await page.goto(SINGLE);
  await expect(page.getByText("upgraded to the new format")).toBeVisible();
  await page.getByLabel("Master password", { exact: true }).fill("not the password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();
  await unlock(page, OLD_PW);
  await expect(page.getByText(/Vault upgraded\. 4 items/)).toBeVisible();
  expect(await titles(page)).toEqual(["Netflix", "Medium", "HSBC", "Pension"]);
  await expect(page.locator(".chip")).toHaveText([/All\s*4/, /Subskrypcje\s*2/, /Konta bankowe\s*1/, /Zdrowie\s*1/]);
  await page.locator(".item-row .main", { hasText: "Pension" }).click();
  await expect(page.locator(".thumb img")).toHaveCount(1);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator(".item-row .main", { hasText: "HSBC" }).click();
  await expect(page.locator(".val.pre")).toContainText("Sort code 40-11-22");
  await expect(page.locator(".val.pre a")).toHaveAttribute("href", "https://www.hsbc.co.uk/");

  // the old copy is kept under another key; the new vault opens after a reload
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain("pwvault_blob_v1_migrated");
  expect(keys).not.toContain("pwvault_blob_v1");
  await page.reload();
  await expect(page.getByText("upgraded to the new format")).toHaveCount(0);
  await unlock(page, OLD_PW);
  expect(await titles(page)).toEqual(["Netflix", "Medium", "HSBC", "Pension"]);
  // health picks up the shared trivial password straight away
  await page.getByRole("button", { name: "Health" }).click();
  await expect(page.locator(".hcard", { hasText: "Reused passwords" }).locator(".n")).toHaveText("2");
  expect(w.errors).toEqual([]);
  expect(w.network).toEqual([]);
});

test("a .vault file exported by the current app restores on a new phone", async ({ browser }) => {
  const ctxA = await browser.newContext({ viewport: { width: 412, height: 915 }, acceptDownloads: true });
  const a = await ctxA.newPage();
  await makeV1Vault(a);
  const dl = a.waitForEvent("download");
  await a.evaluate(() => document.getElementById("btn-export")!.click());
  const file = path.resolve("test-results/v1-export.vault");
  await (await dl).saveAs(file);
  await ctxA.close();

  const ctxB = await browser.newContext({ viewport: { width: 412, height: 915 }, colorScheme: "dark" });
  const b = await ctxB.newPage();
  await open(b, SINGLE);
  await b.getByRole("button", { name: "Restore from a backup" }).click();
  const chooser = b.waitForEvent("filechooser");
  await b.getByRole("button", { name: "Choose backup file" }).click();
  await (await chooser).setFiles(file!);
  await b.getByLabel("Backup's master password").fill(OLD_PW);
  await b.getByRole("button", { name: "Open backup" }).click();
  await expect(b.locator(".stats b").first()).toHaveText("4");
  await b.getByRole("button", { name: "Use this backup" }).click();
  await expect(b.locator(".nav")).toBeVisible({ timeout: 20_000 });
  expect(await titles(b)).toEqual(["Netflix", "Medium", "HSBC", "Pension"]);
  await b.locator(".item-row .main", { hasText: "Pension" }).click();
  await expect(b.locator(".thumb img")).toHaveCount(1);
  await ctxB.close();
});
