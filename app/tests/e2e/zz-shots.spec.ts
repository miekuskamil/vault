// Screenshot tour of every screen for visual review. Runs only with SHOTS=1.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

import { createVault, open, PW } from "./helpers";

test.skip(!process.env.SHOTS, "visual tour only on request");
test.setTimeout(240_000);
test.use({ actionTimeout: 10_000 });

const DIR = path.resolve("shots/tour");
let n = 0;
async function shot(page: Page, name: string, full = false) {
  await page.waitForTimeout(250);
  fs.mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: path.join(DIR, `${String(++n).padStart(2, "0")}-${name}.png`), fullPage: full });
}

/** Screens of an open page, scrolled a viewport at a time (pages scroll inside .page). */
async function shotPage(page: Page, name: string, max = 4) {
  const scroller = page.locator(".page").last();
  await scroller.evaluate(el => el.scrollTo(0, 0));
  for (let i = 0; i < max; i++) {
    await shot(page, i ? `${name}-${i + 1}` : name);
    const more = await scroller.evaluate(el => { const before = el.scrollTop; el.scrollBy(0, el.clientHeight - 220); return el.scrollTop > before; });
    if (!more) break;
  }
}

const CSV = [
  "name,url,username,password,notes,category,PIN",
  "Netflix,https://netflix.com,kamil@example.com,Tr0ub4dor&3xyz!,,Subskrypcje,",
  "Spotify,https://spotify.com,kamil@example.com,Tr0ub4dor&3xyz!,Family plan,Subskrypcje,",
  "Medium,medium.com,kamil@example.com,123456,,Subskrypcje,",
  "HSBC,https://www.hsbc.co.uk,kamil01,S3cret!pass-2024,\"Sort code 40-11-22\nAccount 12345678\",Konta bankowe,4821",
  "Revolut,revolut.com,+44 7700 900123,Rev-olut#991,,Konta bankowe,1234",
  "NHS login,https://www.nhs.uk,kamil@example.com,nhs-Long-passphrase-here,,Zdrowie,",
  "Dentist,,,,Dr Smith 020 7946 0000,Zdrowie,",
  "Gmail,https://mail.google.com,kamil@gmail.com,Gm@il-very-long-pass-2023,Recovery phone ends 123,Email Accounts,",
  "Outlook,outlook.com,kamil@outlook.com,password1,,Email Accounts,",
  "British Gas,britishgas.co.uk,kamil@example.com,Gas!Bill2022,,Dom,",
  "Octopus Energy,octopus.energy,kamil@example.com,Oct0pus-Energy-99,,Dom,",
  "HMRC,https://www.gov.uk/log-in-register-hmrc-online-services,UTR 1234567890,HMRC-gateway-pass-77,Inland Revenue UTR,Inland Revenue UTR,",
].join("\n");

test("visual tour", async ({ page, context }) => {
  await open(page);
  await shot(page, "setup-empty");
  await page.getByLabel("Master password", { exact: true }).fill(PW);
  await page.getByLabel("Confirm master password").fill(PW);
  await shot(page, "setup-filled");
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.locator(".nav")).toBeVisible({ timeout: 20_000 });
  await shot(page, "vault-empty");

  // import the seed
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Import a spreadsheet/ }).click();
  await shot(page, "import-pick");
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles({ name: "hasla.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await expect(page.getByRole("button", { name: /^Import \d+ items$/ })).toBeVisible();
  await shotPage(page, "import-map");
  await page.getByRole("button", { name: /^Import \d+ items$/ }).click();
  await expect(page.getByText("added")).toBeVisible();
  await shot(page, "import-done");
  await page.getByRole("button", { name: "Done" }).click();

  // protected spreadsheet with pictures
  await page.getByRole("button", { name: /Import a spreadsheet/ }).click();
  chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles(path.resolve("tests/fixtures/protected-agile.xlsx"));
  await expect(page.getByLabel("Spreadsheet password")).toBeVisible();
  await shot(page, "import-password");
  await page.getByLabel("Spreadsheet password").fill("Żółw-Tajny 2024!");
  await page.getByRole("button", { name: "Open spreadsheet" }).click();
  await expect(page.getByText(/2 sheets/)).toBeVisible({ timeout: 30_000 });
  await shotPage(page, "import-map-pictures");
  await page.getByRole("button", { name: /^Import \d+ items$/ }).click();
  await expect(page.getByText("added")).toBeVisible();
  await shot(page, "import-done-pictures");
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "vault-list");
  for (let i = 1; i <= 3; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await shot(page, `vault-list-${i + 1}`); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(".chip", { hasText: "Konta bankowe" }).click();
  await shot(page, "vault-chip");
  await page.locator(".chip").first().click();
  await page.getByLabel("Search", { exact: true }).fill("gmail");
  await shot(page, "vault-search");
  await page.getByLabel("Search", { exact: true }).fill("");
  await page.getByRole("button", { name: "Sort" }).click();
  await shot(page, "vault-sort");
  await page.keyboard.press("Escape");

  // select mode
  await page.getByRole("button", { name: "Select", exact: true }).click();
  for (const t of ["Netflix", "Spotify", "Medium"]) await page.locator(".item-row", { hasText: t }).first().click();
  await shot(page, "vault-select");
  await page.getByRole("button", { name: "Cancel selection" }).click();

  // add a login with 2FA, custom field, attachment
  await page.getByRole("button", { name: "Add item" }).click();
  await shot(page, "edit-new");
  await page.getByLabel("Name", { exact: true }).fill("GitHub");
  await page.getByLabel("Category name").fill("Work");
  await page.getByLabel("Username or email").fill("kamil-dev");
  await page.getByRole("button", { name: "Generate password" }).click();
  await shot(page, "edit-generator");
  await page.getByRole("radio", { name: "Words" }).click().catch(() => undefined);
  await shot(page, "edit-generator-words");
  await page.getByRole("button", { name: "Generate password" }).click();
  await page.getByLabel("Website").fill("github.com");
  await page.getByLabel("2FA secret (optional)").fill("JBSWY3DPEHPK3PXP");
  await page.getByLabel("Notes").fill("Recovery codes in the safe.\nhttps://github.com/settings/security");
  chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach a photo or PDF" }).click();
  await (await chooser).setFiles(path.resolve("tests/fixtures/small.jpg"));
  await page.waitForTimeout(600);
  await shotPage(page, "edit-filled");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".hero h1")).toHaveText("GitHub");
  await shotPage(page, "item-login");
  await page.getByRole("button", { name: "More" }).click();
  await shot(page, "item-more");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back", exact: true }).click();

  // bank item detail
  await page.locator(".item-row .main", { hasText: "HSBC" }).click();
  await shotPage(page, "item-hsbc");
  await page.getByRole("button", { name: "Edit" }).click();
  await shotPage(page, "edit-hsbc");
  await page.getByRole("button", { name: "Back", exact: true }).last().click();
  await page.getByRole("button", { name: "Back", exact: true }).last().click();

  // card item
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("radio", { name: /Card/ }).click();
  await shotPage(page, "edit-card-new");
  await page.getByRole("button", { name: "Back", exact: true }).last().click();
  if (await page.getByRole("button", { name: "Discard" }).isVisible().catch(() => false)) await page.getByRole("button", { name: "Discard" }).click();

  await page.getByRole("button", { name: "Favorites" }).click();
  await shot(page, "favorites");
  await page.getByRole("button", { name: "Health" }).click();
  await shot(page, "health");
  await page.evaluate(() => window.scrollBy(0, 700)); await shot(page, "health-2"); await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Settings" }).click();
  await shot(page, "settings");
  for (let i = 1; i <= 3; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await shot(page, `settings-${i + 1}`); }
  await page.evaluate(() => window.scrollTo(0, 0));

  for (const [row, name] of [["Back up now", "backup"], ["Restore or merge a backup", "restore"], ["Version history", "history"], ["Replaced vaults", "retired"], ["Categories", "categories"], ["Change master password", "password"], ["About and security", "about"]] as const) {
    await page.getByRole("button", { name: new RegExp(`^${row}`) }).first().click();
    await expect(page.locator(".page")).toBeVisible();
    await shotPage(page, "page-" + name, 2);
    await page.getByRole("button", { name: "Back", exact: true }).last().click();
  }

  // trash with something in it
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await page.locator(".item-row .main", { hasText: "Outlook" }).click();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: /Delete|Move to trash/ }).first().click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: /Delete|Move to trash/ });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Trash/ }).click();
  await shot(page, "page-trash");
  await page.getByRole("button", { name: "Back", exact: true }).last().click();

  await page.getByRole("button", { name: /^Reset vault/ }).click();
  await shot(page, "dialog-reset");
  await page.keyboard.press("Escape");

  // light theme
  await page.getByLabel("Theme").selectOption("light");
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await shot(page, "light-list");
  await page.locator(".item-row .main", { hasText: "GitHub" }).click();
  await shotPage(page, "light-item", 2);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await shot(page, "light-settings");
  await page.getByRole("button", { name: "Lock now" }).first().click();
  await shot(page, "light-lock");
  await page.getByLabel("Master password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator(".nav")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Theme").selectOption("dark");

  await page.getByRole("button", { name: "Lock now" }).first().click();
  await shot(page, "lock");
  await page.getByRole("button", { name: /Trouble unlocking/ }).click();
  await shot(page, "lock-trouble");
  await context.close();
});
