import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { addLogin, createVault, lockNow, open, PW, SINGLE, titles, unlock, watch } from "./helpers";
import { parseTotp, totpAt, formatCode } from "../../src/core/totp";

async function fresh(page: Page) { await open(page); await createVault(page); }
const topPage = (page: Page) => page.locator(".page").last();
const back = (page: Page) => topPage(page).getByRole("button", { name: "Back", exact: true }).click();

test("all item types: presets, hidden fields, card masking, notes", async ({ page }) => {
  await fresh(page);
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("radio", { name: "Card" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Visa debit");
  await page.getByLabel("Category name").fill("Cards");
  await page.getByLabel("Card number value").fill("4111 1111 1111 1234");
  await page.getByLabel("CVV value").fill("987");
  await page.getByLabel("Expiry value").fill("09/29");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".hero h1")).toHaveText("Visa debit");
  await expect(page.getByText("987")).toHaveCount(0); // hidden by default
  await page.getByRole("button", { name: "Show CVV" }).click();
  await expect(page.getByText("987")).toBeVisible();
  await back(page);
  await expect(page.locator(".item-row .s").first()).toHaveText("•••• 1234");

  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("radio", { name: "Bank" }).click();
  await page.getByLabel("Name", { exact: true }).fill("HSBC");
  await page.getByLabel("Sort code value").fill("40-11-22");
  await page.getByLabel("Username or email").fill("kamil01");
  await page.locator("#f-password").fill("Bank-Pass-99!");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("40-11-22")).toBeVisible();
  await back(page);

  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("radio", { name: "Note" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Wi-Fi");
  await page.getByLabel("Notes").fill("Network: Home\nKey: purple-otter-44");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await back(page);
  expect(await titles(page)).toEqual(["Visa debit", "HSBC", "Wi-Fi"]);
  await page.screenshot({ path: "shots/flow-types.png" });
});

test("2FA codes match RFC 6238 for the current time", async ({ page }) => {
  const t = Date.UTC(2026, 8, 25, 10, 0, 7);
  await page.clock.install({ time: t });
  await fresh(page);
  await addLogin(page, { title: "GitHub", username: "kamil", password: "Gh-Pass-2026!", totp: "otpauth://totp/GitHub:kamil?secret=JBSWY3DPEHPK3PXP&issuer=GitHub" });
  await page.locator(".item-row .main").first().click();
  const now = await page.evaluate(() => Date.now());
  const expected = formatCode((await totpAt(parseTotp("JBSWY3DPEHPK3PXP")!, now)).code);
  await expect(page.locator(".totp")).toHaveText(expected);
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.locator(".toast")).toContainText("Code copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected.replace(" ", ""));
});

test("favorites, search, category chips and sorting", async ({ page }) => {
  await fresh(page);
  await addLogin(page, { title: "Netflix", category: "Subs", username: "a@example.com", password: "p1" });
  await addLogin(page, { title: "Allegro", category: "Shops", username: "b@example.com", password: "p2" });
  await addLogin(page, { title: "Medium", category: "Subs", username: "c@example.com", password: "p3" });
  await page.locator(".item-row .main", { hasText: "Allegro" }).click();
  await page.getByRole("button", { name: "Add to favorites" }).click();
  await back(page);
  await page.getByRole("button", { name: "Favorites" }).click();
  expect(await titles(page)).toEqual(["Allegro"]);
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await page.getByLabel("Search", { exact: true }).fill("c@exa");
  expect(await titles(page)).toEqual(["Medium"]);
  await page.getByLabel("Search", { exact: true }).fill("");
  await page.locator(".chip", { hasText: "Shops" }).click();
  expect(await titles(page)).toEqual(["Allegro"]);
  await page.locator(".chip", { hasText: "All" }).click();
  await page.getByRole("button", { name: "Sort" }).click();
  await page.getByRole("button", { name: "Name A–Z" }).click();
  expect(await titles(page)).toEqual(["Allegro", "Medium", "Netflix"]);
});

test("long-press to select, bulk move, bulk delete with undo, trash and version history", async ({ page }) => {
  await fresh(page);
  for (const t of ["A1", "A2", "A3", "B1"]) await addLogin(page, { title: t, category: "Old", password: "pw-" + t });
  const row = page.locator(".item-row .main", { hasText: "A1" });
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.locator(".item-row .main", { hasText: "A2" }).click();
  await page.locator(".item-row .main", { hasText: "A3" }).click();
  await expect(page.getByText("3 selected")).toBeVisible();
  await page.getByRole("button", { name: "Move" }).click();
  await page.getByLabel("Or a new category").fill("Group A");
  await page.getByRole("button", { name: "Move", exact: true }).last().click();
  await expect(page.locator(".chip", { hasText: "Group A" })).toContainText("3");

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.getByText("4 selected")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Your vault is empty")).toBeVisible();
  await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".item-row")).toHaveCount(4);

  // delete one, restore from trash
  await page.locator(".item-row .main", { hasText: "B1" }).click();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".item-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Trash/ }).click();
  await topPage(page).getByRole("button", { name: "Restore" }).click();
  await back(page);
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await expect(page.locator(".item-row")).toHaveCount(4);

  // version history brings back the pre-delete state
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Your vault is empty")).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Version history/ }).click();
  await topPage(page).getByRole("button", { name: /Before deleting 4 items/ }).first().click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await expect(page.locator(".item-row")).toHaveCount(4);
});

test("generator: characters and words", async ({ page }) => {
  await fresh(page);
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Test");
  await page.getByRole("button", { name: "Generate password" }).click();
  const pw = await page.locator("#f-password").inputValue();
  expect(pw.length).toBeGreaterThanOrEqual(8);
  await page.getByRole("radio", { name: "Words" }).click();
  const pp = await page.locator("#f-password").inputValue();
  expect(pp.split("-").length).toBeGreaterThanOrEqual(3);
  await expect(page.getByText(/Strong/)).toBeVisible();
});

test("unsaved changes prompt, and the phone back button closes pages", async ({ page }) => {
  await fresh(page);
  await addLogin(page, { title: "Kept", password: "x" });
  await page.locator(".item-row .main").first().click();
  await expect(page.locator(".page")).toHaveCount(1);
  await page.goBack();
  await expect(page.locator(".page")).toHaveCount(0);
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Draft");
  await page.goBack();
  await expect(page.getByText("Discard changes?")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Draft");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator(".page")).toHaveCount(0);
  expect(await titles(page)).toEqual(["Kept"]);
});

test("change master password", async ({ page }) => {
  await fresh(page);
  await addLogin(page, { title: "Kept", password: "x" });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Change master password" }).click();
  await page.getByLabel("Current master password").fill(PW);
  await page.getByLabel("New master password", { exact: true }).fill("Copper-Meadow-Silent-Harbor-42");
  await page.getByLabel("Confirm new master password").fill("Copper-Meadow-Silent-Harbor-42");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.locator(".toast")).toContainText("Master password changed");
  await page.getByRole("button", { name: "Lock now" }).click();
  await page.getByLabel("Master password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();
  await unlock(page, "Copper-Meadow-Silent-Harbor-42");
  expect(await titles(page)).toEqual(["Kept"]);
});

test("backup to a file, then merge it into another vault", async ({ browser }) => {
  const a = await (await browser.newContext({ viewport: { width: 412, height: 915 }, acceptDownloads: true })).newPage();
  await fresh(a);
  await addLogin(a, { title: "From phone A", password: "a-pass" });
  await a.getByRole("button", { name: "Settings" }).click();
  await a.getByRole("button", { name: /Back up now/ }).click();
  const dl = a.waitForEvent("download");
  await topPage(a).getByRole("button", { name: "Back up now" }).click();
  const file = path.resolve("test-results/flow-backup.vault");
  await (await dl).saveAs(file);
  expect(fs.readFileSync(file, "utf-8")).not.toContain("From phone A");
  await expect(a.getByText(/Last backup/).first()).toBeVisible();

  const b = await (await browser.newContext({ viewport: { width: 412, height: 915 } })).newPage();
  await open(b);
  await createVault(b, "Other-Device-Password-Long-77");
  await addLogin(b, { title: "Only on B", password: "b-pass" });
  await b.getByRole("button", { name: "Settings" }).click();
  await b.getByRole("button", { name: /Restore or merge/ }).click();
  const chooser = b.waitForEvent("filechooser");
  await b.getByRole("button", { name: "Choose backup file" }).click();
  await (await chooser).setFiles(file);
  await b.getByLabel("Backup's master password").fill(PW);
  await b.getByRole("button", { name: "Open backup" }).click();
  await b.getByRole("button", { name: "Add its items to your vault" }).click();
  await expect(b.locator(".toast")).toContainText("Added 1 item");
  await b.getByRole("button", { name: "Vault", exact: true }).click();
  expect((await titles(b)).sort()).toEqual(["From phone A", "Only on B"]);
});

test("CSV export needs a typed confirmation", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, acceptDownloads: true })).newPage();
  await fresh(page);
  await addLogin(page, { title: "Netflix", password: "pw1" });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Export as spreadsheet/ }).click();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await page.getByLabel(/Type EXPORT/).fill("export");
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const text = fs.readFileSync((await (await dl).path())!, "utf-8");
  expect(text).toContain("type,category,title,username,password");
  expect(text).toContain("Netflix");
});

test("another tab saving locks this one instead of overwriting", async ({ context }) => {
  const a = await context.newPage();
  await fresh(a);
  const b = await context.newPage();
  await open(b);
  await unlock(b);
  await addLogin(b, { title: "From tab B", password: "x" });
  await expect(a.locator(".lock-card")).toBeVisible();
  await expect(a.getByText("changed in another tab")).toBeVisible();
  await unlock(a);
  expect(await titles(a)).toEqual(["From tab B"]);
});

test("untrusted text never becomes markup or a script link", async ({ page }) => {
  const w = watch(page);
  let dialogs = 0;
  page.on("dialog", d => { dialogs++; void d.dismiss(); });
  await fresh(page);
  await addLogin(page, { title: "<img src=x onerror=alert(1)>", password: "x", url: "javascript:alert(2)", notes: "see javascript:alert(3) and <b>bold</b>" });
  await expect(page.locator(".item-row .t")).toHaveText("<img src=x onerror=alert(1)>");
  await page.locator(".item-row .main").first().click();
  await expect(page.locator(".card a[href^='javascript']")).toHaveCount(0);
  await expect(page.locator(".val.pre b")).toHaveCount(0);
  expect(dialogs).toBe(0);
  expect(w.network).toEqual([]);
});

test("auto-lock timing follows the setting; theme switch", async ({ page }) => {
  await page.clock.install();
  await fresh(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Auto-lock").selectOption("1");
  await page.getByLabel("Theme").selectOption("light");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.screenshot({ path: "shots/flow-settings-light.png", fullPage: true });
  await page.getByLabel("Theme").selectOption("dark");
  await page.clock.runFor(65_000);
  await expect(page.locator(".lock-card")).toBeVisible();
});

test("reset from the lock screen keeps a recovery copy that can be brought back", async ({ page }) => {
  await fresh(page);
  await addLogin(page, { title: "Before reset", password: "x" });
  await lockNow(page);
  await page.getByRole("button", { name: "Trouble unlocking?" }).click();
  await page.getByRole("button", { name: "Reset this vault" }).click();
  await page.getByLabel(/Type RESET/).fill("RESET");
  await page.getByRole("button", { name: "Reset vault" }).click();
  await expect(page.getByRole("button", { name: "Create vault" })).toBeVisible();
  await page.getByRole("button", { name: "Recover a previous vault" }).click();
  await page.locator(".srow").first().click();
  await page.locator(".dialog").getByLabel("Master password").fill(PW);
  await page.getByRole("button", { name: "Recover" }).click();
  await expect(page.locator(".nav")).toBeVisible({ timeout: 20_000 });
  expect(await titles(page)).toEqual(["Before reset"]);
});

void SINGLE;
