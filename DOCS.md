# Vault: developer notes

Offline, encrypted password vault. One HTML file for the phone, or an installable web app.
Nothing is ever sent over the network (single-file CSP: `connect-src 'none'`).

## Build and test

Source lives in `app/`. Run everything from there.

```sh
cd app
npm install
npm run build        # app/dist-single/index.html (one file) + app/dist-pwa/ (installable app)
npm run release      # build, then copy both to the repo root (index.html, assets/, sw.js…, password-vault.html)
npm test             # unit tests (vitest)
npm run typecheck
npx playwright test  # real-browser tests at 412x915 (phone size)
SHOTS=1 npx playwright test tests/e2e/zz-shots.spec.ts   # screenshot tour -> shots/tour
```

Fixtures: `python3 app/tests/fixtures/make_fixtures.py` and `make_hostile.py`
(need openpyxl, pillow, msoffcrypto-tool, cryptography; `lo_encrypt.py` needs LibreOffice).

## How it fits together

```mermaid
flowchart TD
  subgraph UI["UI (React)"]
    Shell["Shell: tabs, list, search, bulk actions"]
    Screens["Screens: item view/edit, import, backup/restore, health, settings"]
  end
  Session["session.ts: lock state, saves, snapshots, auto-lock"]
  Crypto["crypto.ts: PBKDF2 600k, AES-256-GCM, wrapped data key"]
  Bio["biometric.ts: passkey PRF (installed app only)"]
  Storage["storage.ts: IndexedDB (+ localStorage fallback)"]
  Model["model.ts: items, trash, history, merge"]
  Import["importers: CSV, XLSX, pictures, password-protected Excel (cfb, officecrypto, sha)"]
  Backup["backup.ts / exporters.ts: .vault file, CSV"]
  Shell --> Session
  Screens --> Session
  Screens --> Import
  Session --> Crypto
  Session --> Bio
  Session --> Storage
  Session --> Model
  Session --> Backup
  Import --> Model
```

## Hosting the installable version

The repo root is the built app (after `npm run release`). Drag the root files onto Netlify Drop (or any static https host). `_headers` sets a
strict CSP. Open the address in Chrome on the phone, then "Install app". Fingerprint unlock works
only there, because passkeys need an https address. The hosted app keeps its own storage: move
your vault across with Settings > Back up now, then Restore in the installed app.
