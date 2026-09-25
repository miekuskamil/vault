// Your real use case: a password-protected, multi-tab .xlsx with pictures, opened on a phone.
import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

import { createVault, open, titles, watch } from "./helpers";

const FILE_PW = "Żółw-Tajny 2024!";

for (const file of ["protected-agile.xlsx", "protected-libreoffice.xlsx"]) {
  test(`password-protected spreadsheet with pictures (${file}) on a slow phone`, async ({ page }) => {
    const w = watch(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await open(page);
    await createVault(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: /Import a spreadsheet/ }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose file" }).click();
    await (await chooser).setFiles(path.resolve("tests/fixtures", file));

    // asks for the spreadsheet's own password; a wrong one is caught
    const pw = page.getByLabel("Spreadsheet password");
    await expect(pw).toBeVisible();
    await pw.fill("wrong");
    await page.getByRole("button", { name: "Open spreadsheet" }).click();
    await expect(page.getByText("Wrong password for this spreadsheet.")).toBeVisible({ timeout: 30_000 });
    await pw.fill(FILE_PW);
    const t0 = Date.now();
    await page.getByRole("button", { name: "Open spreadsheet" }).click();
    await expect(page.getByText(/2 sheets/)).toBeVisible({ timeout: 30_000 });
    const openMs = Date.now() - t0;
    console.log(`${file}: opened in ${openMs} ms at 4x CPU slowdown`);
    expect(openMs).toBeLessThan(15_000);

    const pictures = file === "protected-agile.xlsx" ? 3 : 2; // LibreOffice drops Excel 365 in-cell pictures when saving
    await expect(page.getByText(new RegExp(`${pictures} pictures`)).first()).toBeVisible();
    await expect(page.locator(".sheet-card").first().locator(".pic-count").first()).toBeVisible();
    await page.getByRole("button", { name: /^Import \d+ items$/ }).click();
    await expect(page.getByText("added")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".stats")).toContainText(`${pictures}pictures`);
    await expect(page.getByText(/still on your phone, protected by its own password/)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await expect(page.locator(".chip", { hasText: "Dom" })).toBeVisible();
    expect(await titles(page)).toEqual(expect.arrayContaining(["Alarm", "Router", "Brama", "Skrytka", "NHS", "Dentist"]));

    // the picture is on the right item and opens
    await page.locator(".item-row .main", { hasText: "Alarm" }).click();
    await expect(page.locator(".thumb img")).toHaveCount(1);
    await page.locator(".thumb").first().click();
    await expect(page.locator(".viewer img")).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).last().click();
    await page.getByRole("button", { name: "Back", exact: true }).last().click();
    await page.locator(".item-row .main", { hasText: "Router" }).click();
    await expect(page.locator(".thumb")).toHaveCount(0);
    expect(w.errors).toEqual([]);
    expect(w.network).toEqual([]);
  });
}

test("an old .xls file gets a clear message", async ({ page }) => {
  await open(page);
  await createVault(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Import a spreadsheet/ }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles(path.resolve("tests/fixtures/encrypted.xlsx"));
  await expect(page.getByText("This is an old Excel .xls file.")).toBeVisible();
});

async function openImport(page: import("@playwright/test").Page, file: string) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Import a spreadsheet/ }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles(file);
}

test("a zip bomb that lies about its size is stopped while unpacking", async ({ page }) => {
  const w = watch(page);
  await open(page);
  await createVault(page);
  await openImport(page, path.resolve("tests/fixtures/hostile/bomb-lying.xlsx"));
  await expect(page.getByText(/too large to open here/)).toBeVisible({ timeout: 20_000 });
  expect(w.errors).toEqual([]);
});

test("opening a protected spreadsheet can be cancelled", async ({ page }) => {
  // same file, but asking for ten times the usual password work
  const src = fs.readFileSync(path.resolve("tests/fixtures/protected-agile.xlsx"));
  const at = src.indexOf(Buffer.from('spinCount="100000"'));
  expect(at).toBeGreaterThan(0);
  Buffer.from('spinCount="999999"').copy(src, at);
  const file = path.resolve("test-results/slow-protected.xlsx");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, src);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await open(page);
  await createVault(page);
  await openImport(page, file);
  await page.getByLabel("Spreadsheet password").fill(FILE_PW);
  await page.getByRole("button", { name: "Open spreadsheet" }).click();
  await expect(page.getByRole("progressbar", { name: "Opening spreadsheet" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
  await page.waitForTimeout(4000);
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
  await expect(page.getByText(/2 sheets/)).toHaveCount(0);
});
