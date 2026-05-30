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
