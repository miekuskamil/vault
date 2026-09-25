/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

// Content-Security-Policy per build. The single file has to allow inline script (everything is inline);
// both builds forbid all network access for app code.
const CSP = {
  single: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  pwa: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'",
};

function htmlPerMode(mode: "single" | "pwa"): Plugin {
  return {
    name: "vault-html",
    transformIndexHtml(html) {
      const head = [
        `<meta http-equiv="Content-Security-Policy" content="${CSP[mode]}">`,
        mode === "pwa" ? `<link rel="manifest" href="manifest.webmanifest">\n    <link rel="apple-touch-icon" href="icons/icon-192.png">` : "",
      ].filter(Boolean).join("\n    ");
      return html.replace("<!--HEAD-->", head);
    },
  };
}

// Emits sw.js with a cache list of the exact built files (static shell only — never user data).
function serviceWorker(): Plugin {
  return {
    name: "vault-sw",
    apply: "build",
    generateBundle(_opts, bundle) {
      const files = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", ...Object.keys(bundle).filter(f => !f.endsWith(".map"))];
      const version = createHash("sha256").update(files.join("|") + pkg.version).digest("hex").slice(0, 12);
      const src = readFileSync(new URL("./src/sw.template.js", import.meta.url), "utf-8")
        .replace("__VERSION__", version)
        .replace("__FILES__", JSON.stringify([...new Set(files)]));
      this.emitFile({ type: "asset", fileName: "sw.js", source: src });
    },
  };
}

export default defineConfig(({ mode }) => {
  const single = mode !== "pwa";
  return {
    base: "./",
    plugins: [react(), htmlPerMode(single ? "single" : "pwa"), ...(single ? [viteSingleFile({ removeViteModuleLoader: true })] : [serviceWorker()])],
    define: {
      __BUILD__: JSON.stringify(single ? "single" : "pwa"),
      __VERSION__: JSON.stringify(pkg.version),
    },
    publicDir: single ? false : "public",
    build: {
      outDir: single ? "dist-single" : "dist-pwa",
      emptyOutDir: true,
      target: "es2022",
      modulePreload: { polyfill: false },
      sourcemap: false,
      assetsInlineLimit: single ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 2000,
    },
    test: {
      environment: "jsdom",
      include: ["tests/unit/**/*.test.ts"],
      globals: true,
      setupFiles: ["tests/unit/setup.ts"],
      testTimeout: 60_000,
    },
  };
});
