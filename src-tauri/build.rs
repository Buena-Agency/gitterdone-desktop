fn main() {
    // Declaring every app command opts it into Tauri's capability ACL instead
    // of the default unrestricted app-command dispatch.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "gd_focus_started",
        "gd_app_ready",
        "gd_log",
        "gd_open_task",
        "gd_resize_pill",
        "gd_move_pill",
        "gd_set_anim",
        "gd_quit_and_install",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build desktop permission manifest");
}
