// The hosted / installed build: service worker, offline start, manifest, CSP, fingerprint unlock.
import { test, expect, type Page } from "@playwright/test";

import { addLogin, createVault, lockNow, open, PW, PWA, titles, watch } from "./helpers";

async function withAuthenticator(page: Page, opts: { hasPrf?: boolean; isUserVerified?: boolean } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
      hasResidentKey: true, hasUserVerification: true, isUserVerified: opts.isUserVerified ?? true,
      automaticPresenceSimulation: true, hasPrf: opts.hasPrf ?? true,
    },
  });
  return { cdp, authenticatorId };
}

test("installable: manifest, icons, strict CSP, no outside requests", async ({ page, request }) => {
  const w = watch(page);
  await open(page, PWA);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /manifest\.webmanifest$/);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain("unsafe-eval");
  const manifest = await (await request.get(PWA + "manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBeTruthy();
  for (const icon of manifest.icons) {
    const r = await request.get(new URL(icon.src, PWA).href);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()["content-type"]).toContain("image/png");
  }
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose?.includes("maskable"))).toBe(true);
  await createVault(page);
  await addLogin(page, { title: "Netflix", username: "a@example.com", password: "p1" });
  expect(w.errors).toEqual([]);
  expect(w.network).toEqual([]);
});

test("opens offline after the first visit, with the vault intact", async ({ page, context }) => {
  await open(page, PWA);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
  await createVault(page);
  await addLogin(page, { title: "Offline item", username: "me", password: "x" });

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".lock-card")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Master password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator(".nav")).toBeVisible({ timeout: 25_000 });
  expect(await titles(page)).toEqual(["Offline item"]);
  await context.setOffline(false);
});

test("fingerprint unlock: turn on, unlock with it, password still works, turn off", async ({ page }) => {
  const w = watch(page);
  await withAuthenticator(page);
  await open(page, PWA);
  await createVault(page);
  await addLogin(page, { title: "Bank", username: "me", password: "x" });

  await page.getByRole("button", { name: "Settings" }).click();
  const sw = page.getByRole("switch", { name: "Unlock with fingerprint" });
  await expect(sw).toBeVisible();
  await sw.click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Master password", { exact: true }).fill("wrong one");
  await dlg.getByRole("button", { name: "Continue" }).click();
  await expect(dlg.getByText("Wrong master password.")).toBeVisible();
  await dlg.getByLabel("Master password", { exact: true }).fill(PW);
  await dlg.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Fingerprint unlock is on")).toBeVisible();
  await expect(sw).toBeChecked();

  // after a reload the lock screen offers the fingerprint and unlocks with it (auto-prompts once)
  await page.reload();
  await expect(page.locator(".nav")).toBeVisible({ timeout: 25_000 });
  expect(await titles(page)).toEqual(["Bank"]);

  // "Lock now" doesn't immediately ask for the fingerprint again; the button does
  await lockNow(page);
  await page.waitForTimeout(1500);
  await expect(page.locator(".lock-card")).toBeVisible();
  await page.getByRole("button", { name: "Unlock with fingerprint" }).click();
  await expect(page.locator(".nav")).toBeVisible({ timeout: 25_000 });

  // the master password keeps working
  await lockNow(page);
  await page.getByLabel("Master password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator(".nav")).toBeVisible({ timeout: 25_000 });

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Unlock with fingerprint" }).click();
  await expect(page.getByText("Fingerprint unlock turned off")).toBeVisible();
  await lockNow(page);
  await expect(page.getByRole("button", { name: "Unlock with fingerprint" })).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.network).toEqual([]);
});

test("a passkey provider without the needed feature gets a clear message", async ({ page }) => {
  await withAuthenticator(page, { hasPrf: false });
  await open(page, PWA);
  await createVault(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Unlock with fingerprint" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Master password", { exact: true }).fill(PW);
  await dlg.getByRole("button", { name: "Continue" }).click();
  await expect(dlg.getByText(/doesn't support the feature fingerprint unlock needs/)).toBeVisible();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("switch", { name: "Unlock with fingerprint" })).not.toBeChecked();
});
