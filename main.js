const { app, BrowserWindow, WebContentsView, shell, ipcMain, powerMonitor, session, screen, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// The live web app. Changing this one line re-points the whole desktop shell.
// Temporarily pointed at the gitterdone-doug preview so changes show in the shell.
const APP_URL = process.env.GITTERDONE_URL || 'https://gitterdone-doug.vercel.app';

let mainWindow = null;
let pillWindow = null;
let isQuitting = false;
let updateDownloaded = false;

// ---- Focus Companion pill: a small always-on-top window docked bottom-center that
// shows the current focus task + timer. Loads the app's /pill route and shares the
// default session (so it's authenticated alongside the main window). ----
const PILL_W = 400, PILL_H = 56;

function pillBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    width: PILL_W,
    height: PILL_H,
    x: Math.round(wa.x + (wa.width - PILL_W) / 2),
    y: wa.y + wa.height - PILL_H - 24,
  };
}

// pillAnimTimer drives the slide+fade show/hide tween. pillAnim holds the user-tuned timing
// (pushed from the pill page via gdSetAnim): duration in ms and easing kind ('out' | 'io').
let pillAnimTimer = null;
let pillAnim = { ms: 200, ease: 'out' };
// Slide-up + fade-in (direction 'in') or slide-down + fade-out (direction 'out'), using the
// user-tuned duration + easing. On 'out' the window is hidden when the tween finishes.
function animatePill(direction) {
  if (!pillWindow || pillWindow.isDestroyed()) return;
  if (pillAnimTimer) { clearInterval(pillAnimTimer); pillAnimTimer = null; }
  const SLIDE = 18;
  const DUR = Math.min(2000, Math.max(50, Number(pillAnim.ms) || 200));
  const expoOut = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
  const expoInOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2);
  const easeFn = pillAnim.ease === 'io' ? expoInOut : expoOut;
  const b = pillWindow.getBounds();
  const restY = b.y;
  if (direction === 'in') {
    pillWindow.setOpacity(0);
    pillWindow.setBounds({ x: b.x, y: restY + SLIDE, width: b.width, height: b.height });
    if (!pillWindow.isVisible()) pillWindow.showInactive();
  }
  const t0 = Date.now();
  pillAnimTimer = setInterval(() => {
    if (!pillWindow || pillWindow.isDestroyed()) { clearInterval(pillAnimTimer); pillAnimTimer = null; return; }
    const p = Math.min(1, (Date.now() - t0) / DUR);
    const e = easeFn(p);
    const cur = pillWindow.getBounds();
    if (direction === 'in') {
      pillWindow.setOpacity(e);
      pillWindow.setBounds({ x: cur.x, y: Math.round(restY + SLIDE * (1 - e)), width: cur.width, height: cur.height });
    } else {
      pillWindow.setOpacity(1 - e);
      pillWindow.setBounds({ x: cur.x, y: Math.round(restY + SLIDE * e), width: cur.width, height: cur.height });
    }
    if (p >= 1) {
      clearInterval(pillAnimTimer); pillAnimTimer = null;
      if (direction === 'out') {
        pillWindow.hide();
        pillWindow.setOpacity(1);
        const f = pillWindow.getBounds();
        pillWindow.setBounds({ x: f.x, y: restY, width: f.width, height: f.height }); // reset for next show
      }
    }
  }, 16);
}

function createPill(showAfter) {
  pillWindow = new BrowserWindow({
    ...pillBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'pill-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true, // idle the pill's timers when it's hidden
    },
  });
  pillWindow.setAlwaysOnTop(true, 'floating');
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pillWindow.loadURL(`${APP_URL}/pill`);
  // Stay HIDDEN after load — the pill is PRELOADED in the background so it's already laid out
  // (no loader / resize jolt) by the time it's surfaced. Only animate in when explicitly asked.
  pillWindow.once('ready-to-show', () => { if (showAfter && pillWindow && !pillWindow.isDestroyed()) animatePill('in'); });
  pillWindow.on('closed', () => { pillWindow = null; });
}

// Bring the pill up (creating it on first use). Used when the user starts a timer in the
// app — the pill then resolves the running task and shows it.
function showPill() {
  if (!pillWindow || pillWindow.isDestroyed()) { createPill(true); return; }
  if (!pillWindow.isVisible()) animatePill('in'); // keep its current (possibly dragged) position
}

function togglePill() {
  // Hide/show (not destroy) so the pill reappears INSTANTLY — the renderer stays loaded with
  // the focus task already on screen. Animate the surface in/out (slide + fade, 200ms expo).
  if (pillWindow && !pillWindow.isDestroyed()) {
    if (pillAnimTimer) return; // ignore re-presses mid-animation
    if (pillWindow.isVisible()) animatePill('out');
    else animatePill('in');
    return;
  }
  createPill(true);
}

// Reload the live URL — used to auto-recover from any blank/broken state so the
// user never has to manually reload or restart the app.
function reloadApp() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(APP_URL);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 640,
    // Match the web app's dark theme so there's no white bar/flash up top.
    backgroundColor: '#1B1B1A',
    title: 'Gitterdone',
    // Don't show a blank window while the page loads — reveal it (focused, to the
    // front) only once the first frame is painted. Avoids the "window opened hidden
    // in the background" issue and the flash of a loading screen.
    show: false,
    // macOS: hide the title bar and let the (dark) content run to the top edge.
    // Traffic-light buttons stay (they float over the content). Windows keeps its
    // normal frame.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Hand the shell version to the preload as a launch arg (read from process.argv) instead
      // of a synchronous IPC round-trip at startup — same result, nothing blocks the renderer.
      additionalArguments: ['--gd-version=' + app.getVersion()],
      // Let Chromium throttle this renderer when the window is hidden (keep-warm) — it
      // stays in memory but its timers/rAF idle, so a hidden window stops burning CPU
      // and battery. Reopening re-renders instantly enough for a task app.
      backgroundThrottling: true,
    },
  });

  // ---- In-window branded loader -------------------------------------------------
  // Show the cool splash INSIDE this full-size window (not a separate small window):
  // overlay a WebContentsView playing splash.html on top of the web content while the app
  // loads underneath. The full window opens immediately (the splash is a local file, so it
  // paints near-instantly) so the user never sees a blank window or the web "loading…" text.
  // The overlay is removed only once the app has loaded AND it's shown for at least
  // MIN_SPLASH_MS, so it always reads as intentional rather than a glitch that flashed by.
  const MIN_SPLASH_MS = 2000;
  const t0 = Date.now();
  const lg = (msg) => console.log(`[loader] +${Date.now() - t0}ms ${msg}`);
  let loaderView = new WebContentsView({ webPreferences: { contextIsolation: true } });
  loaderView.setBackgroundColor('#1B1B1A');
  loaderView.webContents.loadFile(path.join(__dirname, 'splash.html'));
  mainWindow.contentView.addChildView(loaderView);
  lg('created loader overlay + addChildView');
  loaderView.webContents.on('did-fail-load', (_e, code, desc) => lg(`splash did-fail-load ${code} ${desc}`));
  const fitLoader = () => {
    if (!mainWindow || mainWindow.isDestroyed() || !loaderView) return;
    const { width, height } = mainWindow.getContentBounds();
    loaderView.setBounds({ x: 0, y: 0, width, height });
    lg(`fitLoader ${width}x${height}`);
  };
  fitLoader();
  mainWindow.on('resize', fitLoader);

  let shownAt = 0;
  const showWindow = (why) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
      lg(`showWindow (${why})`);
    }
    if (!shownAt) shownAt = Date.now();
  };
  // Open the window as soon as the splash itself has painted (near-instant, local file).
  loaderView.webContents.once('did-finish-load', () => { lg('splash did-finish-load'); showWindow('splash-painted'); });
  // Safety net: show within 1.2s even if that event never fires.
  setTimeout(() => showWindow('1.2s-safety'), 1200);

  let loaderRemoved = false;
  const removeLoader = (why) => {
    if (loaderRemoved) return;
    loaderRemoved = true;
    lg(`removeLoader (${why})`);
    ipcMain.removeListener('gd-app-ready', onAppReady);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.off('resize', fitLoader);
    if (mainWindow && !mainWindow.isDestroyed() && loaderView) {
      try { mainWindow.contentView.removeChildView(loaderView); } catch (_e) { /* already gone */ }
    }
    if (loaderView) { try { loaderView.webContents.close(); } catch (_e) {} loaderView = null; }
  };
  // Dismiss the loader the moment the web app reports it has painted its first real screen
  // (so the web's own "Loading…" text is NEVER visible) — but never before the 2s floor.
  const requestRemoveLoader = (why) => {
    const elapsed = shownAt ? Date.now() - shownAt : 0;
    const wait = Math.max(0, MIN_SPLASH_MS - elapsed);
    lg(`requestRemoveLoader (${why}) -> remove in ${wait}ms`);
    setTimeout(() => removeLoader(why), wait);
  };
  // The page (preload DOM-watch, or the web app's own gdAppReady call) signals when it has
  // painted a real screen — that's the only thing that removes the loader in the happy path.
  let gotReady = false;
  const onAppReady = () => { gotReady = true; requestRemoveLoader('gd-app-ready'); };
  ipcMain.on('gd-app-ready', onAppReady);

  // Self-heal: if no real screen appears within 10s, the page is stuck — almost always a
  // broken bundle served by a corrupted service-worker cache. Clear the SW + cache and
  // reload ONCE, keeping the splash up across the reload so the user never sees the frozen
  // "Loading…". The reloaded page then signals ready normally.
  let healed = false;
  setTimeout(async () => {
    if (gotReady || healed || loaderRemoved || !mainWindow || mainWindow.isDestroyed()) return;
    healed = true;
    lg('app not ready in 10s — clearing service worker + cache and reloading');
    try {
      await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
      await session.defaultSession.clearCache();
    } catch (_e) {}
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  }, 10000);
  // Absolute cap so the splash can never get permanently stuck even if a reload also fails.
  setTimeout(() => removeLoader('hard cap'), 25000);

  mainWindow.loadURL(APP_URL);

  // Open target=_blank / external links in the user's real browser, not a new app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep off-origin top-level navigations (e.g. external auth links) in the browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // If the app fails to load (offline, deploy in progress), retry shortly.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode) => {
    // -3 is an aborted load (normal during redirects); ignore it.
    if (errorCode === -3) return;
    setTimeout(reloadApp, 2000);
  });

  // The renderer crashed (out-of-memory, GPU, etc.) — this is the classic
  // "window went blank" case. Reload instead of leaving a dead window.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') setTimeout(reloadApp, 500);
  });

  // Page stopped responding — reload it.
  mainWindow.webContents.on('unresponsive', reloadApp);

  // Keep-warm on macOS: closing the window hides it (the app + already-loaded page
  // stay in memory) so reopening from the Dock is instant, with no reload. A real
  // quit (Cmd+Q) sets isQuitting and lets it close normally.
  mainWindow.on('close', (e) => {
    // Force localStorage/IndexedDB to disk so a fresh login token (and things like the
    // celebration "last shown" timestamp) survive — otherwise recent writes can be lost
    // on a quick quit, which logged the user out + re-showed throttled popups every launch.
    try { session.defaultSession.flushStorageData(); } catch (_e) {}
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Notification-ready: identify the app to the OS (so notifications show as
  // "Gitterdone" with our icon) and auto-grant web permissions. The shell only ever
  // loads our own first-party site, so granting (notifications, etc.) is safe — this
  // lets the web app fire native notifications (e.g. "you were assigned a task").
  app.setAppUserModelId('pro.gitterdone.desktop');
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  createWindow();

  // Preload the Focus pill window HIDDEN a moment after launch, so its web page is loaded and
  // laid out before it's ever surfaced — Cmd+Shift+F then just slides it in instantly, with no
  // loader box or resize jolt. (Delayed slightly so it doesn't compete with the main window's
  // first paint.)
  setTimeout(() => { if (!pillWindow || pillWindow.isDestroyed()) createPill(false); }, 2500);

  // Periodically flush DOM storage to disk so recent writes (auth token, prefs) survive
  // even a hard quit / crash, not just a graceful one.
  setInterval(() => { try { session.defaultSession.flushStorageData(); } catch (_e) {} }, 15000);

  // Diagnostic relay: the preload forwards readiness/log lines here so they show in the
  // app's stdout (renderer console.log doesn't).
  ipcMain.on('gd-log', (_e, msg) => {
    const line = `${new Date().toISOString()} ${String(msg)}`;
    console.log(line);
    // Also append to a file so the session/login lifecycle is capturable without a terminal.
    try {
      const fs = require('fs');
      fs.appendFileSync(path.join(app.getPath('userData'), 'gd-session.log'), line + '\n');
    } catch (_e) { /* ignore */ }
  });

  // The pill is summoned on demand — when the user starts a timer in the app, or via the
  // toggle shortcut — so it appears only when you're actually focusing on something.
  ipcMain.on('gd-focus-started', (_e, taskId) => {
    console.log('[pill] gd-focus-started received:', taskId);
    showPill();
  });

  // The pill page drives its own window size (settings panel height, default width). Keep
  // it docked bottom-center: the bottom edge stays put, so it grows upward.
  ipcMain.on('gd-pill-resize', (_e, { width, height } = {}) => {
    if (!pillWindow || pillWindow.isDestroyed()) return;
    const w = Math.max(160, Math.min(900, Math.round(width || PILL_W)));
    const h = Math.max(40, Math.min(600, Math.round(height || PILL_H)));
    // Keep the window's CURRENT bottom-center fixed, so it grows upward in place — and a
    // pill the user dragged elsewhere doesn't snap back to screen-center on every resize.
    const b = pillWindow.getBounds();
    const centerX = b.x + b.width / 2;
    const bottomY = b.y + b.height;
    pillWindow.setBounds({ width: w, height: h, x: Math.round(centerX - w / 2), y: Math.round(bottomY - h) });
  });

  // Custom drag — the pill page sends pointer deltas while the user drags an empty area of
  // the pill (we don't use -webkit-app-region: drag, which would suppress the hover that
  // reveals the controls). Move the window by the delta.
  ipcMain.on('gd-pill-move', (_e, { dx, dy } = {}) => {
    if (!pillWindow || pillWindow.isDestroyed()) return;
    const b = pillWindow.getBounds();
    pillWindow.setBounds({ width: b.width, height: b.height, x: Math.round(b.x + (Number(dx) || 0)), y: Math.round(b.y + (Number(dy) || 0)) });
  });

  // The pill page pushes its user-tuned appear/dismiss timing here.
  ipcMain.on('gd-pill-anim', (_e, { ms, ease } = {}) => {
    if (Number.isFinite(ms) && ms > 0) pillAnim.ms = ms;
    if (ease === 'io' || ease === 'out') pillAnim.ease = ease;
  });

  // Cmd/Ctrl+Shift+F toggles the focus pill.
  globalShortcut.register('CommandOrControl+Shift+F', togglePill);

  // The pill asks the main window to come forward and open the focus task.
  ipcMain.on('gd-open-task', (_e, taskId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      if (taskId) mainWindow.loadURL(`${APP_URL}/?task=${encodeURIComponent(taskId)}`);
    } else {
      createWindow();
    }
  });

  // Auto-update: on launch (and every 6h while open) check GitHub Releases for a
  // newer shell. electron-updater downloads it in the background; when it's ready we
  // tell the page to show an in-app "update ready" toast (see preload.js) instead of
  // a system notification. Only runs in the packaged app; a no-op in `npm start` dev.
  if (app.isPackaged) {
    autoUpdater.on('update-downloaded', () => {
      updateDownloaded = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gd-update-ready');
      }
    });
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, 6 * 60 * 60 * 1000);
  }

  // The toast's "Quit & Relaunch" button.
  // CRITICAL: set isQuitting=true FIRST. quitAndInstall() closes all windows
  // *before* it calls app.quit(), so the keep-warm 'close' handler would otherwise
  // just hide the window (isQuitting still false) and the update would never apply.
  ipcMain.on('gd-quit-and-install', () => {
    isQuitting = true;
    if (updateDownloaded) {
      autoUpdater.quitAndInstall(true, true);
    } else {
      // Stale toast / nothing staged — just restart the app cleanly.
      app.relaunch();
      app.exit(0);
    }
  });

  // After the machine wakes from sleep the page is often blank (the connection
  // died while asleep) — reload so the user never has to do it by hand.
  powerMonitor.on('resume', reloadApp);

  app.on('activate', () => {
    // Reopen: show the warm (hidden) window instantly if it's still around;
    // otherwise build a fresh one.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

// Let the keep-warm window actually close when the user really quits.
app.on('before-quit', () => {
  isQuitting = true;
  try { session.defaultSession.flushStorageData(); } catch (_e) {}
  globalShortcut.unregisterAll();
  if (pillWindow && !pillWindow.isDestroyed()) pillWindow.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
