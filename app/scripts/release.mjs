// Copies the builds to the repo root, Marbles-style:
//   index.html + assets/ + sw.js + manifest + icons + _headers  -> hosted app (Netlify / GitHub Pages)
//   password-vault.html                                          -> one file, download and open
import { cpSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
const root = resolve(app, "..");
for (const p of ["index.html", "assets", "sw.js", "manifest.webmanifest", "icons", "_headers"]) rmSync(resolve(root, p), { recursive: true, force: true });
cpSync(resolve(app, "dist-pwa"), root, { recursive: true });
copyFileSync(resolve(app, "dist-single/index.html"), resolve(root, "password-vault.html"));
if (!existsSync(resolve(root, "index.html"))) throw new Error("release failed");
console.log("released to", root);
