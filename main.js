const { app, BrowserWindow, shell, ipcMain, powerMonitor, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// The live web app. Changing this one line re-points the whole desktop shell.
// Temporarily pointed at the gitterdone-doug preview so changes show in the shell.
const APP_URL = process.env.GITTERDONE_URL || 'https://gitterdone-doug.vercel.app';

let mainWindow = null;
let splashWindow = null;
let isQuitting = false;
let updateDownloaded = false;

// Branded splash shown immediately on cold start so the user never stares at a
// blank window or the web app's "loading…" text. Closed once the real window paints.
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 360,
    resizable: false,
    movable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    center: true,
    show: false,
    hasShadow: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: { contextIsolation: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow && splashWindow.show());
  splashWindow.on('closed', () => { splashWindow = null; });
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
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
      // Keep the renderer running at full speed even when hidden/backgrounded so
      // it's instantly responsive when reopened.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(APP_URL);

  // Reveal the window once content is painted, bringing it to the front, and dismiss
  // the splash. A timeout safety-net ensures it never stays hidden if the page is
  // slow or offline.
  const reveal = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
    closeSplash();
  };
  mainWindow.once('ready-to-show', reveal);
  setTimeout(reveal, 4000);

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

  createSplash();
  createWindow();

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
app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
