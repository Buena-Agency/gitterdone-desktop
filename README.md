# Gitterdone Desktop

A minimal [Tauri](https://tauri.app/) shell around the live Gitterdone web app. It
is a single window that loads **https://app.gitterdone.org**, so it always shows the
latest deployed version — there is nothing to rebuild when the web app updates.

Tauri uses the operating system's own webview instead of bundling Chromium, so the
app is a few MB (vs. Electron's ~150 MB) and far lighter on memory and startup. It
was ported from Electron — see [`MIGRATION.md`](MIGRATION.md) for the mapping,
the known gaps, and the required CI secrets.

This repo is **completely separate** from the web app's repo and Vercel project.
It contains no application code and no copy of the site — only the desktop wrapper.

## Download (always latest)

These permanent links always serve the newest published build — safe to put on a
landing page once and never update:

- **Windows:** https://github.com/Buena-Agency/gitterdone-desktop/releases/latest/download/Gitterdone.exe
- **macOS (universal):** https://github.com/Buena-Agency/gitterdone-desktop/releases/latest/download/Gitterdone.dmg

> The builds are not yet code-signed. On first launch: **Windows** → SmartScreen
> "More info → Run anyway"; **macOS** → right-click the app → Open.

## Run it (development)

```bash
npm install
npm start          # tauri dev
```

Needs the [Rust toolchain](https://rustup.rs) installed.

## Build a double-clickable macOS app

```bash
npm run build            # current architecture
npm run build:universal  # universal (Apple Silicon + Intel) .dmg/.app
```

The packaged `.app` and `.dmg` land in `src-tauri/target/.../release/bundle/`.

## Application origin

The packaged bridge permits only `https://app.gitterdone.org`. A `GITTERDONE_URL`
override pointing elsewhere is rejected before creating windows. Supporting a
development origin requires an explicit, reviewed capability and native policy
change; an environment variable cannot grant another site native permissions.

## Validation

`npm test` runs synthetic bridge and configuration tests without opening a webview
or contacting the live app. The Check workflow additionally runs locked Cargo
check, Clippy and Rust unit tests on macOS and Windows. Both native jobs must pass
before this migration is considered compile-verified. Installer signing, real
update installation and platform interaction still require separate validation.

## How it works

- `src-tauri/src/lib.rs` — creates the windows and loads the live URL. External
  links open in the user's real browser; failed/blank loads self-heal.
- `src-tauri/scripts/*-bridge.js` — injected `initialization_script`s that expose
  the `window.gd*` bridge to the web app (the Tauri equivalent of a preload).
- `ui/splash.html` — the branded loading splash.
- `src-tauri/tauri.conf.json` + `src-tauri/capabilities/` — app + packaging config
  and the permissions that let the remote page call the shell.
