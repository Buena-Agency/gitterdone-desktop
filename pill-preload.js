// Preload for the Focus Companion pill window. Exposes a single bridge the pill page
// calls to bring the main window forward and open the focus task.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gdOpenTask', (taskId) => {
  ipcRenderer.send('gd-open-task', typeof taskId === 'string' ? taskId : '');
});

// The pill page asks to resize its own window (e.g. to grow taller for the settings panel,
// or to apply a new default width). Main keeps it docked bottom-center.
contextBridge.exposeInMainWorld('gdResizePill', (width, height) => {
  ipcRenderer.send('gd-pill-resize', { width: Number(width), height: Number(height) });
});

// The pill page sends pointer deltas to drag its own window to a new location.
contextBridge.exposeInMainWorld('gdMovePill', (dx, dy) => {
  ipcRenderer.send('gd-pill-move', { dx: Number(dx), dy: Number(dy) });
});

// The pill page pushes its user-tuned appear/dismiss timing (ms + easing kind: "io" | "out")
// down to main, which owns the show/hide window animation.
contextBridge.exposeInMainWorld('gdSetAnim', (ms, ease) => {
  ipcRenderer.send('gd-pill-anim', { ms: Number(ms), ease: String(ease) });
});

// Diagnostic logging from the pill page → gd-session.log (same channel the main window uses).
contextBridge.exposeInMainWorld('gdLog', (m) => ipcRenderer.send('gd-log', String(m)));
