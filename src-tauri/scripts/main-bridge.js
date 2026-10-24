// Injected into the main window BEFORE the live web app loads (Tauri
// `initialization_script`). This is the Tauri equivalent of Electron's
// contextBridge preload: it defines the window.gd* globals the web app looks
// for, routing each to a Rust command via the globally-exposed Tauri API.
//
// `window.__TAURI__` is present because tauri.conf.json sets
// `app.withGlobalTauri: true`, and the capability's `remote.urls` block lists
// app.gitterdone.org so this remote page is allowed to call our commands.
(function () {
  var T = window.__TAURI__;
  // If the Tauri API isn't present we're in a plain browser tab — every call
  // below must be a safe no-op, exactly like the Electron preload in a browser.
  var invoke = T && T.core && T.core.invoke ? T.core.invoke : function () {};
  var listen = T && T.event && T.event.listen ? T.event.listen : function () {};

  var GD_VERSION = typeof window.__GD_SHELL_VERSION__ === "string" ? window.__GD_SHELL_VERSION__ : "";

  try {
    // Marks that we're inside the desktop shell.
    window.gdDesktop = true;
    // The user started a timer → surface the Focus pill.
    window.gdFocusStarted = function (taskId) {
      invoke("gd_focus_started", { taskId: typeof taskId === "string" ? taskId : "" });
    };
    // The app painted its first real screen → drop the branded splash.
    window.gdAppReady = function () { invoke("gd_app_ready"); };
    // Forward a diagnostic line to the shell's stdout / gd-session.log.
    window.gdLog = function (m) { invoke("gd_log", { msg: String(m) }); };
    // The shell's own version, so the web app's build badge can show it.
    window.gdVersion = GD_VERSION;
  } catch (_e) { /* ignore */ }

  // Detect when the app has rendered its first REAL screen (logged-in app or
  // login page — not the bare "Loading…" splash) and tell the shell to drop the
  // branded splash exactly then. Mirrors the Electron preload's MutationObserver
  // so it works even when the page JS is served stale from the service worker.
  (function watchAppReady() {
    var done = false;
    function ready(why) {
      if (done) return;
      done = true;
      try { observer.disconnect(); } catch (_e) {}
      invoke("gd_app_ready");
      invoke("gd_log", { msg: "[gd-ready] " + why });
    }
    function check() {
      if (done || !document.body) return;
      var hasChrome = !!document.querySelector(
        'nav, header, main, form, button, a[href], [role="navigation"], [data-app-shell]'
      );
      if (hasChrome) ready("app chrome detected");
    }
    var observer = new MutationObserver(check);
    function begin() {
      try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (_e) {}
      check();
    }
    if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", begin);
    else begin();
    // Deliberately no blind timeout — if chrome never appears the page is genuinely
    // stuck and the main process self-heals instead of revealing a frozen "Loading…".
  })();

  // ---- "Update ready" toast -------------------------------------------------
  // When the shell finishes downloading an update it emits `gd-update-ready`.
  // Build a small bottom-left toast with a "Quit & Relaunch" button (the page is
  // a remote site we don't own, so the toast is injected here).
  var UPDATE_TOAST_ID = "__gd_update_toast";
  function showUpdateToast() {
    if (!document.body || document.getElementById(UPDATE_TOAST_ID)) return;
    var toast = document.createElement("div");
    toast.id = UPDATE_TOAST_ID;
    toast.style.cssText = [
      "position:fixed", "bottom:20px", "left:20px", "z-index:2147483647",
      "display:flex", "align-items:center", "gap:12px", "max-width:320px",
      "padding:11px 12px 11px 14px", "background:#262624", "color:#f5f5f4",
      "border:1px solid rgba(255,255,255,0.10)", "border-radius:11px",
      "box-shadow:0 8px 28px rgba(0,0,0,0.45)",
      "font:13px/1.35 -apple-system,system-ui,'Segoe UI',sans-serif",
      "opacity:0", "transform:translateY(8px)",
      "transition:opacity .2s ease, transform .2s ease",
    ].join(";");
    var msg = document.createElement("span");
    msg.textContent = "A new version is ready. Quit and relaunch to update.";
    msg.style.cssText = "flex:1";
    var btn = document.createElement("button");
    btn.textContent = "Quit & Relaunch";
    btn.style.cssText = [
      "flex:none", "cursor:pointer", "border:none", "border-radius:7px",
      "padding:7px 11px", "background:#FBBF24", "color:#1B1B1A",
      "font-weight:600", "font-size:12px", "white-space:nowrap",
    ].join(";");
    btn.addEventListener("click", function () {
      btn.textContent = "Restarting…";
      btn.disabled = true;
      toast.remove();
      invoke("gd_quit_and_install");
    });
    var dismiss = document.createElement("button");
    dismiss.textContent = "✕";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.style.cssText = [
      "flex:none", "cursor:pointer", "border:none", "background:transparent",
      "color:rgba(245,245,244,0.55)", "font-size:13px", "padding:2px 4px", "line-height:1",
    ].join(";");
    dismiss.addEventListener("click", function () { toast.remove(); });
    toast.append(msg, btn, dismiss);
    document.body.appendChild(toast);
    requestAnimationFrame(function () {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });
  }
  try {
    listen("gd-update-ready", function () {
      if (document.body) showUpdateToast();
      else window.addEventListener("DOMContentLoaded", showUpdateToast);
    });
  } catch (_e) { /* ignore */ }

  // ---- macOS drag strip -----------------------------------------------------
  // The main window uses the Overlay title-bar style (traffic lights float over
  // dark content), which removes the OS drag handle. Re-add an invisible strip
  // across the top that drags the window via Tauri's startDragging(), starting
  // past the traffic-light buttons so Close/Minimize/Zoom stay clickable.
  if (navigator.platform.indexOf("Mac") === 0 || /Mac/.test(navigator.userAgent)) {
    var DRAG_BAR_ID = "__gd_dragbar";
    function addDragBar() {
      if (!document.body || document.getElementById(DRAG_BAR_ID)) return;
      var bar = document.createElement("div");
      bar.id = DRAG_BAR_ID;
      bar.style.cssText = [
        "position:fixed", "top:0", "left:78px", "right:0", "height:30px",
        "background:transparent", "z-index:2147483647",
      ].join(";");
      bar.setAttribute("data-tauri-drag-region", "");
      bar.addEventListener("mousedown", function (e) {
        // Left button only; let the OS handle the window drag.
        if (e.button !== 0) return;
        try {
          var w = window.__TAURI__.window.getCurrentWindow();
          if (e.detail === 2) w.toggleMaximize(); else w.startDragging();
        } catch (_e) {}
      });
      document.body.appendChild(bar);
    }
    window.addEventListener("DOMContentLoaded", addDragBar);
    window.addEventListener("focus", addDragBar);
  }
})();
