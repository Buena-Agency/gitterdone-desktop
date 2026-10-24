# Electron → Tauri migration

This shell was ported from Electron to **Tauri v2**. It does the same job — one
window onto the live web app at `https://app.gitterdone.org`, a branded splash, a
Focus pill, auto-update, and macOS keep-warm — but ships a tiny native binary
instead of bundling a full Chromium + Node runtime.

## Why

| | Electron | Tauri |
|---|---|---|
| Runtime | Bundles Chromium + Node (~150 MB app, ~85 MB+ download) | Uses the OS webview (WKWebView / WebView2); app is a few MB |
| Memory | Full Chromium per window | OS webview, much lighter |
| Startup | Node + Chromium boot | Native binary boot |

The download and on-disk size drop by well over an order of magnitude, and idle
memory/CPU drop accordingly — the point of the migration.

## What maps to what

| Electron (old) | Tauri (new) |
|---|---|
| `main.js` (main process) | `src-tauri/src/lib.rs` |
| `preload.js` (contextBridge) | `src-tauri/scripts/main-bridge.js` (`initialization_script`) |
| `pill-preload.js` | `src-tauri/scripts/pill-bridge.js` |
| `splash.html` + `WebContentsView` overlay | `ui/splash.html` in a separate frameless splash window |
| `ipcMain.on(...)` handlers | `#[tauri::command]` functions |
| `mainWindow.webContents.send(...)` | `app.emit(...)` + `window.__TAURI__.event.listen` |
| `electron-updater` + `latest-mac.yml`/`latest.yml` | `tauri-plugin-updater` + signed `latest.json` |
| `electron-builder` config in `package.json` | `src-tauri/tauri.conf.json` + `capabilities/` |
| `shell.openExternal` | `tauri-plugin-opener` via `on_navigation` |
| `globalShortcut` | `tauri-plugin-global-shortcut` |

The `window.gd*` bridge the web app depends on is **unchanged** in shape:
`gdDesktop`, `gdFocusStarted`, `gdAppReady`, `gdLog`, `gdVersion`, `gdOpenTask`,
`gdResizePill`, `gdMovePill`, `gdSetAnim`. No web-app change is required.

## Intended behavior

- Remote-URL main window restricted to the packaged production origin. Arbitrary
  `GITTERDONE_URL` overrides are rejected rather than granting native access.
- Branded splash with the 2s minimum-display floor and a 25s hard cap.
- Preloaded, hidden Focus pill; `Cmd/Ctrl+Shift+F` toggle; slide show/hide with the
  user-tuned duration + easing; resize-grows-upward; custom drag; jump-to-task.
- External/off-origin links open in the system browser.
- macOS keep-warm (close hides; real quit exits) and Dock-reopen.
- macOS hidden-inset title bar with an injected drag strip past the traffic lights.
- Update availability checks from GitHub Releases on launch + every 6h. An explicit
  "Update & Relaunch" click starts downloading and installing. Failure keeps the
  current process running, reports a generic error and permits an explicit retry.
- `gd-session.log` diagnostic logging.
- Self-heal reload if the app never finishes loading.
- Sleep/wake reload (replaces Electron's `powerMonitor` 'resume' with a wall-clock
  gap detector).

## Known gaps / things to verify (the "best-effort" caveats)

1. **Not compiled on this machine.** The dev box's Command Line Tools linker
   (`ld` 1267) can't parse the macOS 27 SDK's `arm64e.x1-macos` tbd token, so **no**
   Rust crate links locally — it fails compiling `proc-macro2`'s build script, before
   reaching our code. Fix: install Xcode or reinstall/update Command Line Tools
   (`xcode-select --install`), which needs an admin password. **The Rust has been
   written and reviewed but not compiler-verified here; CI runners will be the first
   real build.** Run `cd src-tauri && cargo check` once the toolchain is fixed.
2. **Pill cross-fade → slide-only.** Electron faded opacity during the slide; Tauri
   has no cross-platform window opacity, so the pill now slides without the fade.
3. **Self-heal doesn't clear the service worker + cache.** Electron cleared SW +
   cache storage before the heal reload; Tauri stable has no direct API for that, so
   the heal is a plain reload. A genuinely corrupted cached bundle may need a manual
   relaunch.
4. **Web-permission auto-grant.** Electron force-granted all web permissions
   (notifications, etc.). Tauri/WKWebView handles these per-platform; native web
   notifications from the page should be verified once signed.
5. **Load-failure events are thinner.** Electron had `did-fail-load` /
   `render-process-gone` / `unresponsive`. Tauri exposes `on_page_load`; the heal
   timer + sleep/wake watchdog cover the common blank-window cases, but transient
   mid-session load failures retry less aggressively.
6. **Navigation/platform testing.** Main and pill navigation use parsed origin
   checks. Popups are denied as native windows and allowed HTTP(S)/mailto links
   open in the system browser. Authentication popups, media permissions, sleep/wake,
   rapid pill toggles and signed updates still need native platform smoke tests.

## Review fixes and validation boundary

The original PR's macOS and Windows Check jobs stopped before compiling the app:
the configured macOS private API flag was missing its Cargo feature. The review
adds that feature, platform-specific bundle targets, macOS-only event guards and
longer-lived state bindings for mutex guards. Native compilation remains pending
until both updated Check jobs pass; local JavaScript tests do not substitute for it.

Custom IPC commands are declared in an app manifest and split into main/pill
capabilities. Every native command also verifies the injected calling window and
its URL. The splash receives no capabilities, and remote pages receive no generic
updater, window-destroy or event-emit permission. Update packages retain Tauri's
signature verification; `latest.json` itself is a manifest, not a signed document.

## One-time user migration (important)

- **Auto-update does not bridge Electron → Tauri.** The two updaters use different
  manifests and signatures. Users on the current Electron build will **not** auto-
  update into the Tauri build; they need to download the new build once from the
  permanent links (the CI keeps `Gitterdone.dmg` / `Gitterdone.exe` names stable).
- **Session.** The bundle identifier (`pro.gitterdone.desktop`) is unchanged so the
  app installs in place, but WKWebView/WebView2 storage lives in a different location
  than Electron's Chromium storage — expect a **one-time logout** after migrating.
- From the first Tauri release onward, auto-update works normally (Tauri → Tauri).

## Required CI secrets

Already present from the Electron build:
`MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (team `87P39MB3U6`).

New secrets to add (Settings → Secrets → Actions):
- `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Buena … (87P39MB3U6)`.
- `TAURI_SIGNING_PRIVATE_KEY` — the minisign private key (generated locally; **never
  commit it**).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password (empty string if none).

The matching **public** key is already in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`). If you regenerate the keypair, update that value too.

## Run / build locally

```bash
npm install
npm start                 # tauri dev — loads the live app
npm run build             # current arch
npm run build:universal   # universal macOS .dmg/.app
npm test                  # synthetic only; does not launch the app
```
