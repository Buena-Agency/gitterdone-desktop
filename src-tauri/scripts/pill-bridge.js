// Injected into the Focus pill window (loads /pill) before the page runs.
// Tauri equivalent of pill-preload.js: exposes the gd* globals the pill page
// calls to drive its own window and jump back to the main window.
(function () {
  var T = window.__TAURI__;
  var invoke = T && T.core && T.core.invoke ? T.core.invoke : function () {};

  try {
    // Bring the main window forward and open the focus task.
    window.gdOpenTask = function (taskId) {
      invoke("gd_open_task", { taskId: typeof taskId === "string" ? taskId : "" });
    };
    // Resize the pill window (grows upward, stays docked bottom-center).
    window.gdResizePill = function (width, height) {
      invoke("gd_resize_pill", { width: Number(width), height: Number(height) });
    };
    // Drag the pill window by a pointer delta.
    window.gdMovePill = function (dx, dy) {
      invoke("gd_move_pill", { dx: Number(dx), dy: Number(dy) });
    };
    // Push the user-tuned appear/dismiss timing (ms + easing "io" | "out").
    window.gdSetAnim = function (ms, ease) {
      invoke("gd_set_anim", { ms: Number(ms), ease: String(ease) });
    };
    // Diagnostic logging → gd-session.log (same channel the main window uses).
    window.gdLog = function (m) { invoke("gd_log", { msg: String(m) }); };
  } catch (_e) { /* ignore */ }
})();
