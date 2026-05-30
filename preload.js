const { ipcRenderer } = require('electron');

// When the main process finishes downloading an update, it sends 'gd-update-ready'.
// Show a small toast in the bottom-left with a "Quit & Relaunch" button that applies
// the update. The toast is built here (the page content is a remote site we don't own).
const UPDATE_TOAST_ID = '__gd_update_toast';

const showUpdateToast = () => {
  if (!document.body || document.getElementById(UPDATE_TOAST_ID)) return;

  const toast = document.createElement('div');
  toast.id = UPDATE_TOAST_ID;
  toast.style.cssText = [
    'position:fixed',
    'bottom:20px',
    'left:20px',
    'z-index:2147483647',
    '-webkit-app-region:no-drag',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'max-width:320px',
    'padding:11px 12px 11px 14px',
    'background:#262624',
    'color:#f5f5f4',
    'border:1px solid rgba(255,255,255,0.10)',
    'border-radius:11px',
    'box-shadow:0 8px 28px rgba(0,0,0,0.45)',
    "font:13px/1.35 -apple-system,system-ui,'Segoe UI',sans-serif",
    'opacity:0',
    'transform:translateY(8px)',
    'transition:opacity .2s ease, transform .2s ease',
  ].join(';');

  const msg = document.createElement('span');
  msg.textContent = 'A new version is ready. Quit and relaunch to update.';
  msg.style.cssText = 'flex:1';

  const btn = document.createElement('button');
  btn.textContent = 'Quit & Relaunch';
  btn.style.cssText = [
    'flex:none',
    'cursor:pointer',
    'border:none',
    'border-radius:7px',
    'padding:7px 11px',
    'background:#FBBF24',
    'color:#1B1B1A',
    'font-weight:600',
    'font-size:12px',
    'white-space:nowrap',
  ].join(';');
  btn.addEventListener('click', () => ipcRenderer.send('gd-quit-and-install'));

  const dismiss = document.createElement('button');
  dismiss.textContent = '✕';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.style.cssText = [
    'flex:none',
    'cursor:pointer',
    'border:none',
    'background:transparent',
    'color:rgba(245,245,244,0.55)',
    'font-size:13px',
    'padding:2px 4px',
    'line-height:1',
  ].join(';');
  dismiss.addEventListener('click', () => toast.remove());

  toast.append(msg, btn, dismiss);
  document.body.appendChild(toast);
  // Animate in.
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
};

ipcRenderer.on('gd-update-ready', () => {
  if (document.body) showUpdateToast();
  else window.addEventListener('DOMContentLoaded', showUpdateToast);
});

// On macOS we hide the native title bar (titleBarStyle: 'hiddenInset' in main.js)
// so the dark content runs to the top edge. That also removes the OS drag handle,
// so re-add one: an invisible, transparent strip across the top of the page that
// acts like a title bar. The web content shows straight through it; it just lets
// you drag the window. It starts past the traffic-light buttons so Close/Minimize/
// Zoom stay clickable. (Windows keeps its normal frame, so nothing is injected.)
if (process.platform === 'darwin') {
  const DRAG_BAR_ID = '__gd_dragbar';

  const addDragBar = () => {
    if (!document.body || document.getElementById(DRAG_BAR_ID)) return;
    const bar = document.createElement('div');
    bar.id = DRAG_BAR_ID;
    bar.style.cssText = [
      'position:fixed',
      'top:0',
      'left:78px', // clear of the traffic-light buttons
      'right:0',
      'height:30px',
      'background:transparent',
      'z-index:2147483647',
      '-webkit-app-region:drag', // makes the strip a window-drag handle
    ].join(';');
    document.body.appendChild(bar);
  };

  window.addEventListener('DOMContentLoaded', addDragBar);
  // Re-add if the app's framework ever wipes it during a client-side render.
  window.addEventListener('focus', addDragBar);
}
