// Gitterdone desktop shell — Tauri port of the former Electron main process.
//
// It opens one window onto the live web app (https://app.gitterdone.org), shows
// a branded splash until the app paints, runs an always-on-top Focus pill, keeps
// the window warm on macOS, and self-updates from GitHub Releases. The web app
// talks to it through the window.gd* bridge defined in scripts/*-bridge.js
// (injected as Tauri initialization scripts — the contextBridge replacement).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, Url,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

// The pill's resting footprint and how far it slides during the show/hide tween.
const PILL_W: f64 = 400.0;
const PILL_H: f64 = 56.0;
const PILL_SLIDE: f64 = 18.0;
const MIN_SPLASH_MS: u64 = 2000;

/// The live web app. `GITTERDONE_URL` overrides it (for staging); otherwise the
/// canonical production domain — a preview/branch alias would freeze the shell
/// on whatever that branch last deployed.
fn app_url() -> String {
    std::env::var("GITTERDONE_URL").unwrap_or_else(|_| "https://app.gitterdone.org".to_string())
}

/// Shared mutable shell state (the Tauri equivalent of the Electron main's
/// module-level `let` variables).
struct AppState {
    /// User-tuned pill appear/dismiss timing: (duration ms, easing "out" | "io").
    pill_anim: Mutex<(f64, String)>,
    /// A downloaded-pending shell update, installed when the user clicks the toast.
    pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    /// True once a real quit is underway, so keep-warm doesn't swallow the close.
    quitting: AtomicBool,
    /// True once the splash has been dismissed (CAS-guarded; happens exactly once).
    splash_removed: AtomicBool,
    /// When the splash became visible — used to enforce the MIN_SPLASH_MS floor.
    splash_shown_at: Mutex<Instant>,
    /// True once the main web app has finished a page load at least once.
    main_loaded: AtomicBool,
    /// Heartbeat for the sleep/wake detector.
    last_tick: Mutex<Instant>,
}

impl AppState {
    fn new() -> Self {
        Self {
            pill_anim: Mutex::new((200.0, "out".to_string())),
            pending_update: Mutex::new(None),
            quitting: AtomicBool::new(false),
            splash_removed: AtomicBool::new(false),
            splash_shown_at: Mutex::new(Instant::now()),
            main_loaded: AtomicBool::new(false),
            last_tick: Mutex::new(Instant::now()),
        }
    }
}

// ---- Easing (matches the Electron pill's expo curves) ------------------------
fn expo_out(t: f64) -> f64 {
    if t >= 1.0 {
        1.0
    } else {
        1.0 - 2f64.powf(-10.0 * t)
    }
}
fn expo_in_out(t: f64) -> f64 {
    if t <= 0.0 {
        0.0
    } else if t >= 1.0 {
        1.0
    } else if t < 0.5 {
        2f64.powf(20.0 * t - 10.0) / 2.0
    } else {
        (2.0 - 2f64.powf(-20.0 * t + 10.0)) / 2.0
    }
}

/// Primary monitor geometry in logical pixels: (width, height, origin_x, origin_y).
fn primary_logical(app: &AppHandle) -> (f64, f64, f64, f64) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let s = m.scale_factor();
        let sz = m.size();
        let pos = m.position();
        (
            sz.width as f64 / s,
            sz.height as f64 / s,
            pos.x as f64 / s,
            pos.y as f64 / s,
        )
    } else {
        (1440.0, 900.0, 0.0, 0.0)
    }
}

/// Reload the live URL — recovers from any blank/broken state so the user never
/// has to reload or restart by hand.
fn reload_main(app: &AppHandle) {
    if let Some(m) = app.get_webview_window("main") {
        if let Ok(u) = app_url().parse::<Url>() {
            let _ = m.navigate(u);
        }
    }
}

/// Forward a diagnostic line to stdout and append it to gd-session.log, so the
/// session/login lifecycle is capturable without a terminal.
fn log_line(app: &AppHandle, msg: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let line = format!("{ts} {msg}");
    println!("{line}");
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("gd-session.log"))
        {
            use std::io::Write;
            let _ = writeln!(f, "{line}");
        }
    }
}

// ---- Splash ------------------------------------------------------------------
/// Dismiss the splash and reveal the main window — exactly once.
fn finish_splash(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.splash_removed.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(s) = app.get_webview_window("splash") {
        let _ = s.close();
    }
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.show();
        let _ = m.set_focus();
    }
}

/// The app reported it painted a real screen. Drop the splash — but never before
/// the MIN_SPLASH_MS floor, so it always reads as intentional.
fn request_finish_splash(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.splash_removed.load(Ordering::SeqCst) {
        return;
    }
    let elapsed = state.splash_shown_at.lock().unwrap().elapsed().as_millis() as u64;
    let wait = MIN_SPLASH_MS.saturating_sub(elapsed);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(wait));
        finish_splash(&app);
    });
}

// ---- Focus pill --------------------------------------------------------------
/// Slide the pill up (show) or down (hide), using the user-tuned duration/easing.
/// NOTE: Tauri has no cross-platform window-opacity, so this is slide-only — the
/// Electron version also cross-faded. See MIGRATION.md.
fn animate_pill(app: &AppHandle, dir_in: bool) {
    let (ms, ease) = {
        let g = app.state::<AppState>().pill_anim.lock().unwrap();
        (g.0, g.1.clone())
    };
    let pill = match app.get_webview_window("pill") {
        Some(p) => p,
        None => return,
    };
    let scale = pill.scale_factor().unwrap_or(1.0);
    let slide = PILL_SLIDE * scale;
    let dur = ms.clamp(50.0, 2000.0);
    let rest = match pill.outer_position() {
        Ok(p) => p,
        Err(_) => return,
    };
    let rest_x = rest.x;
    let rest_y = rest.y as f64;

    if dir_in {
        let _ = pill.set_position(PhysicalPosition::new(rest_x, (rest_y + slide) as i32));
        let _ = pill.show();
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let t0 = Instant::now();
        loop {
            let p = (t0.elapsed().as_millis() as f64 / dur).min(1.0);
            let e = if ease == "io" { expo_in_out(p) } else { expo_out(p) };
            let pill = match app.get_webview_window("pill") {
                Some(x) => x,
                None => return,
            };
            let y = if dir_in {
                rest_y + slide * (1.0 - e)
            } else {
                rest_y + slide * e
            };
            let _ = pill.set_position(PhysicalPosition::new(rest_x, y as i32));
            if p >= 1.0 {
                if !dir_in {
                    let _ = pill.hide();
                    let _ = pill.set_position(PhysicalPosition::new(rest_x, rest_y as i32));
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    });
}

/// Build the pill window (hidden). If `show_after`, slide it in once its page has
/// had a moment to lay out.
fn create_pill(app: &AppHandle, show_after: bool) {
    let (w, h, x, y) = primary_logical(app);
    let px = x + (w - PILL_W) / 2.0;
    let py = y + h - PILL_H - 24.0;
    let pill_url: Url = match format!("{}/pill", app_url()).parse() {
        Ok(u) => u,
        Err(_) => return,
    };
    let script = include_str!("../scripts/pill-bridge.js");
    let built = WebviewWindowBuilder::new(app, "pill", WebviewUrl::External(pill_url))
        .initialization_script(script)
        .inner_size(PILL_W, PILL_H)
        .position(px, py)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build();
    if built.is_ok() && show_after {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            animate_pill(&app, true);
        });
    }
}

/// Bring the pill up (creating it on first use).
fn show_pill(app: &AppHandle) {
    match app.get_webview_window("pill") {
        Some(p) => {
            if !p.is_visible().unwrap_or(false) {
                animate_pill(app, true);
            }
        }
        None => create_pill(app, true),
    }
}

/// Cmd/Ctrl+Shift+F — hide/show (not destroy) so the pill reappears instantly.
fn toggle_pill(app: &AppHandle) {
    match app.get_webview_window("pill") {
        Some(p) => {
            if p.is_visible().unwrap_or(false) {
                animate_pill(app, false);
            } else {
                animate_pill(app, true);
            }
        }
        None => create_pill(app, true),
    }
}

// ---- Auto-update -------------------------------------------------------------
fn check_for_update(app: &AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(_) => return,
    };
    if let Ok(Some(update)) = tauri::async_runtime::block_on(updater.check()) {
        *app.state::<AppState>().pending_update.lock().unwrap() = Some(update);
        // Tell the page to show its in-app "update ready" toast.
        let _ = app.emit("gd-update-ready", ());
    }
}

// ---- Commands (called from the injected bridge via window.__TAURI__) ---------
#[tauri::command]
fn gd_focus_started(app: AppHandle, task_id: String) {
    log_line(&app, &format!("[pill] gd-focus-started received: {task_id}"));
    show_pill(&app);
}

#[tauri::command]
fn gd_app_ready(app: AppHandle) {
    request_finish_splash(&app);
}

#[tauri::command]
fn gd_log(app: AppHandle, msg: String) {
    log_line(&app, &msg);
}

#[tauri::command]
fn gd_open_task(app: AppHandle, task_id: String) {
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.show();
        let _ = m.set_focus();
        if !task_id.is_empty() {
            if let Ok(u) = format!("{}/?task={}", app_url(), task_id).parse::<Url>() {
                let _ = m.navigate(u);
            }
        }
    }
}

/// Resize the pill, keeping its current bottom-center fixed so it grows upward.
#[tauri::command]
fn gd_resize_pill(app: AppHandle, width: f64, height: f64) {
    let pill = match app.get_webview_window("pill") {
        Some(p) => p,
        None => return,
    };
    let scale = pill.scale_factor().unwrap_or(1.0);
    let w = width.clamp(160.0, 900.0) * scale;
    let h = height.clamp(40.0, 600.0) * scale;
    let (pos, size) = match (pill.outer_position(), pill.outer_size()) {
        (Ok(p), Ok(s)) => (p, s),
        _ => return,
    };
    let center_x = pos.x as f64 + size.width as f64 / 2.0;
    let bottom_y = pos.y as f64 + size.height as f64;
    let _ = pill.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = pill.set_position(PhysicalPosition::new(
        (center_x - w / 2.0) as i32,
        (bottom_y - h) as i32,
    ));
}

/// Move the pill by a pointer delta (CSS px → physical).
#[tauri::command]
fn gd_move_pill(app: AppHandle, dx: f64, dy: f64) {
    let pill = match app.get_webview_window("pill") {
        Some(p) => p,
        None => return,
    };
    let scale = pill.scale_factor().unwrap_or(1.0);
    if let Ok(pos) = pill.outer_position() {
        let _ = pill.set_position(PhysicalPosition::new(
            pos.x + (dx * scale) as i32,
            pos.y + (dy * scale) as i32,
        ));
    }
}

#[tauri::command]
fn gd_set_anim(state: State<AppState>, ms: f64, ease: String) {
    let mut g = state.pill_anim.lock().unwrap();
    if ms.is_finite() && ms > 0.0 {
        g.0 = ms;
    }
    if ease == "io" || ease == "out" {
        g.1 = ease;
    }
}

#[tauri::command]
fn gd_quit_and_install(app: AppHandle) {
    app.state::<AppState>()
        .quitting
        .store(true, Ordering::SeqCst);
    let update = app.state::<AppState>().pending_update.lock().unwrap().take();
    match update {
        Some(update) => {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = tauri::async_runtime::block_on(
                    update.download_and_install(|_, _| {}, || {}),
                );
                app.restart();
            });
        }
        // Stale toast / nothing staged — just restart cleanly.
        None => {
            app.restart();
        }
    }
}

// ---- Setup -------------------------------------------------------------------
fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Auto-grant web permissions (notifications, etc.) — the shell only ever loads
    // our own first-party site. NOTE: unlike Electron's setPermissionRequestHandler,
    // this does not cover every web-permission prompt on every platform; see
    // MIGRATION.md for the ones still to verify.
    let (sw, sh, sx, sy) = primary_logical(app);

    // Branded splash — a frameless, transparent, dark card the same size/position
    // as the main window, shown immediately (local file, paints instantly) so the
    // user never sees a blank or white window while the web app loads.
    *app.state::<AppState>().splash_shown_at.lock().unwrap() = Instant::now();
    let _ = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
        .inner_size(1280.0, 860.0)
        .position(sx + (sw - 1280.0) / 2.0, sy + (sh - 860.0) / 2.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(true)
        .build()?;

    // Main window — loads the live app, hidden until the splash is dismissed.
    let main_script = format!(
        "window.__GD_SHELL_VERSION__={:?};\n{}",
        app.package_info().version.to_string(),
        include_str!("../scripts/main-bridge.js")
    );
    let main_url: Url = app_url().parse()?;
    let nav_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(main_url))
        .title("Gitterdone")
        .inner_size(1280.0, 860.0)
        .min_inner_size(480.0, 640.0)
        .visible(false)
        .initialization_script(&main_script)
        .on_navigation(move |url| {
            let s = url.as_str();
            let base = app_url();
            if s.starts_with(&base)
                || s.starts_with("about:")
                || s.starts_with("blob:")
                || s.starts_with("data:")
            {
                true
            } else {
                // Off-origin link (external auth, loom, etc.) → the real browser.
                let _ = nav_app.opener().open_url(s.to_string(), None::<&str>);
                false
            }
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                webview
                    .app_handle()
                    .state::<AppState>()
                    .main_loaded
                    .store(true, Ordering::SeqCst);
            }
        });
    #[cfg(target_os = "macos")]
    {
        // Hide the title bar; let the dark content run to the top edge with the
        // traffic-light buttons floating over it (Electron's 'hiddenInset').
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    let main = builder.build()?;

    // Keep-warm on macOS: closing the window hides it (app + loaded page stay in
    // memory) so reopening from the Dock is instant. A real quit sets `quitting`.
    let evt_app = app.clone();
    main.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            #[cfg(target_os = "macos")]
            if !evt_app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                if let Some(m) = evt_app.get_webview_window("main") {
                    let _ = m.hide();
                }
            }
            let _ = api;
        }
    });

    // Preload the pill HIDDEN shortly after launch so it's laid out before it's
    // ever surfaced — the toggle shortcut then just slides it in instantly.
    spawn_delayed(app, 2500, |app| {
        if app.get_webview_window("pill").is_none() {
            create_pill(app, false);
        }
    });

    // Self-heal: if the app never finishes loading within 10s (e.g. a broken
    // cached bundle), reload once. (The Electron shell also cleared the service
    // worker + cache here; see MIGRATION.md for that gap.)
    spawn_delayed(app, 10_000, |app| {
        let st = app.state::<AppState>();
        if !st.main_loaded.load(Ordering::SeqCst) && !st.splash_removed.load(Ordering::SeqCst) {
            reload_main(app);
        }
    });

    // Absolute cap so the splash can never get permanently stuck.
    spawn_delayed(app, 25_000, |app| finish_splash(app));

    // Auto-update: check on launch and every 6h (packaged builds only).
    if !cfg!(debug_assertions) {
        let app = app.clone();
        std::thread::spawn(move || loop {
            check_for_update(&app);
            std::thread::sleep(Duration::from_secs(6 * 60 * 60));
        });
    }

    // Sleep/wake watchdog: after the machine wakes, the page is often blank (the
    // connection died while asleep). A large wall-clock gap between ticks means we
    // slept — reload so the user never has to. (Replaces powerMonitor 'resume'.)
    let wd_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        let gap = {
            let mut last = wd_app.state::<AppState>().last_tick.lock().unwrap();
            let gap = last.elapsed();
            *last = Instant::now();
            gap
        };
        if gap > Duration::from_secs(60) {
            reload_main(&wd_app);
        }
    });

    Ok(())
}

/// Run `f` on a cloned AppHandle after `ms` milliseconds.
fn spawn_delayed(app: &AppHandle, ms: u64, f: fn(&AppHandle)) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        f(&app);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let global_shortcut = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts(["CommandOrControl+Shift+F"])
        .expect("valid focus-pill shortcut")
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_pill(app);
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(global_shortcut)
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            gd_focus_started,
            gd_app_ready,
            gd_log,
            gd_open_task,
            gd_resize_pill,
            gd_move_pill,
            gd_set_anim,
            gd_quit_and_install,
        ])
        .setup(|app| {
            setup(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Gitterdone shell")
        .run(|app, event| {
            // Dock reopen (macOS): show the warm window instantly.
            if let RunEvent::Reopen { .. } = event {
                if let Some(m) = app.get_webview_window("main") {
                    let _ = m.show();
                    let _ = m.set_focus();
                }
            }
        });
}
