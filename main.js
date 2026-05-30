const { app, BrowserWindow, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// The live web app. Changing this one line re-points the whole desktop shell.
const APP_URL = process.env.GITTERDONE_URL || 'https://app.gitterdone.org';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 640,
    // Match the web app's dark theme so there's no white bar/flash up top.
    backgroundColor: '#1B1B1A',
    title: 'Gitterdone',
    // macOS: hide the title bar and let the (dark) content run to the top edge.
    // Traffic-light buttons stay (they float over the content). Windows keeps its
    // normal frame.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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
    setTimeout(() => mainWindow && mainWindow.loadURL(APP_URL), 2000);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // Auto-update: on launch (and every 6h while open) check GitHub Releases for a
  // newer shell. electron-updater downloads it in the background and installs it
  // the next time the app quits — so shell changes reach everyone with no reinstall.
  // Only runs in the packaged app; a no-op in `npm start` dev.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
