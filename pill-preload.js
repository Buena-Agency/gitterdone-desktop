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
