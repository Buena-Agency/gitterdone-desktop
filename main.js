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

function createPill() {
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
  // showInactive so surfacing the pill never steals focus from the app you're working in.
  pillWindow.once('ready-to-show', () => pillWindow && !pillWindow.isDestroyed() && pillWindow.showInactive());
  pillWindow.on('closed', () => { pillWindow = null; });
}

// Bring the pill up (creating it on first use). Used when the user starts a timer in the
// app — the pill then resolves the running task and shows it.
function showPill() {
  console.log('[pill] showPill()', { exists: !!pillWindow, url: `${APP_URL}/pill` });
  if (!pillWindow || pillWindow.isDestroyed()) { createPill(); return; }
  pillWindow.setBounds(pillBounds());
  if (!pillWindow.isVisible()) pillWindow.showInactive();
}

function togglePill() {
  // Destroy (not just hide) when dismissing, so a hidden pill holds no renderer process /
  // memory. It's lightweight to recreate on demand (toggle or when a timer starts).
  if (pillWindow && !pillWindow.isDestroyed()) { pillWindow.destroy(); pillWindow = null; return; }
  createPill();
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
  let loaderView = new WebContentsView({ webPreferences: { contextIsolation: true } });
  loaderView.setBackgroundColor('#1B1B1A');
  loaderView.webContents.loadFile(path.join(__dirname, 'splash.html'));
  mainWindow.contentView.addChildView(loaderView);
  const fitLoader = () => {
    if (!mainWindow || mainWindow.isDestroyed() || !loaderView) return;
    const { width, height } = mainWindow.getContentBounds();
    loaderView.setBounds({ x: 0, y: 0, width, height });
  };
  fitLoader();
  mainWindow.on('resize', fitLoader);

  let shownAt = 0;
  const showWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
    if (!shownAt) shownAt = Date.now();
  };
  // Open the window as soon as the splash itself has painted (near-instant, local file).
  loaderView.webContents.once('did-finish-load', showWindow);
  // Safety net: show within 1.2s even if that event never fires.
  setTimeout(showWindow, 1200);

  let loaderRemoved = false;
  const removeLoader = () => {
    if (loaderRemoved) return;
    loaderRemoved = true;
    ipcMain.removeListener('gd-app-ready', requestRemoveLoader);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.off('resize', fitLoader);
    if (mainWindow && !mainWindow.isDestroyed() && loaderView) {
      try { mainWindow.contentView.removeChildView(loaderView); } catch (_e) { /* already gone */ }
    }
    if (loaderView) { try { loaderView.webContents.close(); } catch (_e) {} loaderView = null; }
  };
  // Dismiss the loader the moment the web app reports it has painted its first real screen
  // (so the web's own "Loading…" text is NEVER visible) — but never before the 2s floor.
  const requestRemoveLoader = () => {
    const elapsed = shownAt ? Date.now() - shownAt : 0;
    setTimeout(removeLoader, Math.max(0, MIN_SPLASH_MS - elapsed));
  };
  ipcMain.once('gd-app-ready', requestRemoveLoader);
  // Fallbacks if the page never signals (older web build, or a load error): hold a few
  // seconds past the HTML load, then a hard safety cap so it can never get stuck.
  mainWindow.webContents.once('did-finish-load', () => setTimeout(requestRemoveLoader, 3000));
  setTimeout(removeLoader, 15000);

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
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Notification-ready: identify the app to the OS (so notifications show as
  // "Gitterdone" with our icon) and auto-grant web permissions. The shell only ever
  // loads our own first-party site, so granting (notifications, etc.) is safe — this
  // lets the web app fire native notifications (e.g. "you were assigned a task").
  app.setAppUserModelId('pro.gitterdone.desktop');
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  createWindow();

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
    const w = Math.max(220, Math.min(900, Math.round(width || PILL_W)));
    const h = Math.max(40, Math.min(600, Math.round(height || PILL_H)));
    const wa = screen.getPrimaryDisplay().workArea;
    pillWindow.setBounds({ width: w, height: h, x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y + wa.height - h - 24 });
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
  globalShortcut.unregisterAll();
  if (pillWindow && !pillWindow.isDestroyed()) pillWindow.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
