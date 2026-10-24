//! Pure trust-boundary checks. A valid web origin is necessary but is not an
//! authentication grant: task data and mutations remain authorized by the app.
use tauri::Url;

pub const APP_ORIGIN: &str = "https://app.gitterdone.org";

/// The packaged capabilities cover this origin only. An environment variable
/// must not silently grant native bridge access to an arbitrary deployment.
pub fn trusted_app_url(value: &str) -> Result<Url, &'static str> {
    if value != APP_ORIGIN && value != "https://app.gitterdone.org/" {
        return Err("unsupported desktop application origin");
    }
    Url::parse(APP_ORIGIN).map_err(|_| "invalid application origin")
}

pub fn allow_navigation(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("app.gitterdone.org")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

/// Opener's Rust API is privileged; never pass it an arbitrary webview scheme.
pub fn allow_external(url: &Url) -> bool {
    if url.as_str().len() > 4096
        || url.as_str().chars().any(char::is_control)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.scheme() {
        "http" | "https" => url.host_str().is_some(),
        "mailto" => !url.path().is_empty(),
        _ => false,
    }
}

/// The label and URL must come from Tauri's injected WebviewWindow, never from
/// JSON arguments supplied by the invoking page.
pub fn command_allowed(label: &str, url: &Url, command: &str) -> bool {
    if !allow_navigation(url) {
        return false;
    }
    match label {
        "main" => matches!(
            command,
            "gd_focus_started" | "gd_app_ready" | "gd_log" | "gd_quit_and_install"
        ),
        "pill" if matches!(url.path(), "/pill" | "/pill/") => matches!(
            command,
            "gd_open_task" | "gd_resize_pill" | "gd_move_pill" | "gd_set_anim" | "gd_log"
        ),
        _ => false,
    }
}

pub fn task_url(task_id: &str) -> Result<Url, &'static str> {
    // public.tasks.id is a UUID. Keep the navigation argument narrow even
    // though query_pairs_mut also escapes query delimiters.
    if task_id.len() != 36
        || !task_id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err("invalid task identifier");
    }
    let mut url = trusted_app_url(APP_ORIGIN)?;
    url.query_pairs_mut().append_pair("task", task_id);
    Ok(url)
}

pub fn bounded_log_message(message: &str) -> String {
    message
        .chars()
        .take(2048)
        .map(|character| if character.is_control() { ' ' } else { character })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn app_config_is_canonical_root_only() {
        assert!(trusted_app_url(APP_ORIGIN).is_ok());
        assert!(trusted_app_url("https://app.gitterdone.org/").is_ok());
        for value in [
            "https://app.gitterdone.org.evil.test",
            "https://app.gitterdone.org@evil.test",
            "https://user@app.gitterdone.org",
            "https://app.gitterdone.org/pill",
            "https://app.gitterdone.org/?next=evil",
            "https://app.gitterdone.org/#fragment",
            "http://app.gitterdone.org",
            "https://app.gitterdone.org:444",
            "https://staging.gitterdone.org",
            " https://app.gitterdone.org",
        ] {
            assert!(trusted_app_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn navigation_uses_parsed_origin_not_string_prefix_or_scheme_shortcuts() {
        assert!(allow_navigation(&url("https://app.gitterdone.org/?task=abc#view")));
        assert!(allow_navigation(&url("https://app.gitterdone.org:443/pill")));
        for value in [
            "https://app.gitterdone.org.evil.test/",
            "https://app.gitterdone.org@evil.test/",
            "https://user:pass@app.gitterdone.org/",
            "http://app.gitterdone.org/",
            "https://app.gitterdone.org:444/",
            "about:blank",
            "data:text/html,hello",
            "blob:https://app.gitterdone.org/id",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(!allow_navigation(&url(value)), "{value}");
        }
    }

    #[test]
    fn external_opening_has_an_explicit_scheme_and_size_allowlist() {
        for value in ["https://example.org/path", "http://example.org/", "mailto:help@example.org"] {
            assert!(allow_external(&url(value)), "{value}");
        }
        for value in ["file:///tmp/test", "javascript:alert(1)", "data:text/html,hi", "ms-settings:privacy", "mailto:", "https://user:pass@example.org/"] {
            assert!(!allow_external(&url(value)), "{value}");
        }
        assert!(!allow_external(&url(&format!("https://example.org/{}", "a".repeat(4096)))));
    }

    #[test]
    fn commands_are_bound_to_the_native_caller_and_pill_path() {
        let main = url("https://app.gitterdone.org/");
        let pill = url("https://app.gitterdone.org/pill?compact=true");
        let main_commands = ["gd_focus_started", "gd_app_ready", "gd_log", "gd_quit_and_install"];
        let pill_commands = ["gd_open_task", "gd_resize_pill", "gd_move_pill", "gd_set_anim", "gd_log"];
        for command in main_commands.iter().chain(pill_commands.iter()) {
            assert_eq!(command_allowed("main", &main, command), main_commands.contains(command));
            assert_eq!(command_allowed("pill", &pill, command), pill_commands.contains(command));
            assert!(!command_allowed("splash", &main, command));
            assert!(!command_allowed("unknown", &main, command));
            assert!(!command_allowed("pill", &main, command));
            assert!(!command_allowed("main", &url("https://example.org/"), command));
        }
        assert!(!command_allowed("main", &main, "unknown"));
        assert!(!command_allowed("pill", &url("https://app.gitterdone.org/pill/extra"), "gd_open_task"));
        assert!(command_allowed("pill", &url("https://app.gitterdone.org/pill/"), "gd_open_task"));
    }

    #[test]
    fn task_link_cannot_inject_query_path_or_origin() {
        let id = "12345678-1234-1234-abcd-123456789abc";
        assert_eq!(task_url(id).unwrap().as_str(), format!("{APP_ORIGIN}/?task={id}"));
        for value in ["", "abc", "../../task", "id&admin=true", "12345678-1234-1234-abcd-123456789abg", "https://evil.test/"] {
            assert!(task_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn logs_are_single_line_and_utf8_safe_bounded() {
        assert_eq!(bounded_log_message("ok\nforged\r\t\0line"), "ok forged   line");
        let message = bounded_log_message(&"🦀".repeat(3000));
        assert_eq!(message.chars().count(), 2048);
        assert!(message.len() <= 8192);
    }
}
