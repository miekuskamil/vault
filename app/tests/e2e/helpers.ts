import { expect, type Page, type BrowserContext } from "@playwright/test";
import path from "node:path";

export const SINGLE = "file://" + path.resolve("dist-single/index.html");
export const V1_APP = "file://" + path.resolve("tests/fixtures/v1-app.html");
export const PWA = "http://localhost:4173/";
export const PW = "Velvet-Harbor-Quiet-Lantern-Orbit7";

/** Collects page errors and any request that leaves the device. */
export function watch(page: Page) {
  const errors: string[] = [];
  const network: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", r => { const u = r.url(); if (!/^(file|data|blob|chrome-extension):/.test(u) && !u.startsWith("http://localhost:4173/")) network.push(u); });
  return { errors, network };
}

export async function open(page: Page, url = SINGLE) {
  await page.goto(url);
  await page.waitForSelector(".lock-card, .nav", { timeout: 20_000 });
}

export async function createVault(page: Page, pw = PW) {
  await page.getByLabel("Master password", { exact: true }).fill(pw);
  await page.getByLabel("Confirm master password").fill(pw);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.locator(".nav")).toBeVisible({ timeout: 20_000 });
}

export async function unlock(page: Page, pw = PW) {
  await page.getByLabel("Master password", { exact: true }).fill(pw);
  await page.getByRole("button", { name: /^(Unlock|Upgrading)$/ }).click();
  await expect(page.locator(".nav")).toBeVisible({ timeout: 25_000 });
}

export async function addLogin(page: Page, o: { title: string; category?: string; username?: string; password?: string; url?: string; notes?: string; totp?: string }) {
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill(o.title);
  if (o.category) await page.getByLabel("Category name").fill(o.category);
  if (o.username) await page.getByLabel("Username or email").fill(o.username);
  if (o.password != null) await page.locator("#f-password").fill(o.password);
  if (o.url) await page.getByLabel("Website").fill(o.url);
  if (o.totp) await page.getByLabel("2FA secret (optional)").fill(o.totp);
  if (o.notes) await page.getByLabel("Notes").fill(o.notes);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".hero h1")).toHaveText(o.title);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".page")).toHaveCount(0);
}

export async function lockNow(page: Page) {
  await page.getByRole("button", { name: "Lock now" }).first().click();
  await expect(page.locator(".lock-card")).toBeVisible();
}

export async function newCtx(ctx: BrowserContext) { return ctx.newPage(); }

export async function titles(page: Page) {
  return page.locator(".item-row .t").allTextContents();
}
