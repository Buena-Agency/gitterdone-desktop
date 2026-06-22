const { ipcRenderer, contextBridge } = require('electron');

// Expose a tiny bridge to the web app (context-isolated, so window.* set here isn't
// visible to the page — it must go through contextBridge). Lets the app surface the
// Focus pill when the user starts a timer, and detect it's inside the desktop shell.
try {
  contextBridge.exposeInMainWorld('gdDesktop', true);
  contextBridge.exposeInMainWorld('gdFocusStarted', (taskId) =>
    ipcRenderer.send('gd-focus-started', typeof taskId === 'string' ? taskId : ''),
  );
  // The web app calls this once it has painted its first real screen (past its own
  // "Loading…" state) so the shell can drop the branded splash only then — the web's
  // loading text is never visible.
  contextBridge.exposeInMainWorld('gdAppReady', () => ipcRenderer.send('gd-app-ready'));
  // Lets the web app forward diagnostic lines to the desktop's stdout (renderer
  // console.log doesn't show there). Used to debug the session/login lifecycle.
  contextBridge.exposeInMainWorld('gdLog', (m) => ipcRenderer.send('gd-log', String(m)));
  // The desktop app's own version (e.g. "1.0.19"), so the web app's corner build badge can
  // show which SHELL you're running rather than just the web deploy SHA. Read from the launch
  // arg main injects (no blocking sync IPC at startup).
  const verArg = process.argv.find((a) => a.startsWith('--gd-version=')) || '';
  contextBridge.exposeInMainWorld('gdVersion', verArg.slice('--gd-version='.length));
} catch (_e) { /* ignore */ }

// Detect when the web app has rendered its first REAL screen (the logged-in app or the
// login page — not the bare centered "Loading…" screen, which has no chrome) and tell the
// shell to drop the branded splash exactly then. This lives in the preload (not the web
// bundle) so it works even when the page's JS is served stale from the service-worker cache.
(function watchAppReady() {
  let done = false;
  const ready = (why) => {
    if (done) return;
    done = true;
    try { observer.disconnect(); } catch (_e) {}
    ipcRenderer.send('gd-app-ready');
    ipcRenderer.send('gd-log', `[gd-ready] ${why}`); // surfaced in the main process log
  };
  const check = () => {
    if (done || !document.body) return;
    // The loading screen is a single centered <p>Loading…</p> with no app chrome. Any of
    // these means the real UI (or the login form) has mounted.
    const hasChrome = !!document.querySelector('nav, header, main, form, button, a[href], [role="navigation"], [data-app-shell]');
    if (hasChrome) ready('app chrome detected');
  };
  const observer = new MutationObserver(check);
  const begin = () => {
    try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (_e) {}
    check();
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', begin);
  else begin();
  // NB: deliberately no blind timeout here. If chrome never appears the page is genuinely
  // stuck (e.g. a broken cached bundle), and we want the main process to self-heal rather
  // than receive a false "ready" that reveals the frozen "Loading…" screen.
})();

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
  btn.addEventListener('click', () => {
    btn.textContent = 'Restarting…';
    btn.disabled = true;
    toast.remove();
    ipcRenderer.send('gd-quit-and-install');
  });

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
