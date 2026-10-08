// The problem panel (embedded CEF) exists on macOS and MSVC Windows, matching the `cef`
// dependency in Cargo.toml; other platforms get a stub with the same commands that
// reports the panel unavailable.
#[cfg(any(target_os = "macos", all(target_os = "windows", target_env = "msvc")))]
pub mod browser;
#[cfg(not(any(target_os = "macos", all(target_os = "windows", target_env = "msvc"))))]
#[path = "browser_stub.rs"]
pub mod browser;
mod checker;
mod clangd;
mod companion;
mod files;
mod import;
mod interactive;
#[cfg(target_os = "macos")]
mod macos_menu;
mod memory;
mod pch;
mod runner;
mod stress;
mod submissions;
mod terminal;
mod tools;
mod updates;
mod workspace;

use std::time::Duration;
use tauri::{Emitter, Manager};

/// Caps a single TCP handshake. A judge whose hostname resolves to several addresses can
/// have one of them unreachable from a given network, and the OS spends about 21 seconds
/// giving up on it — longer than the request timeouts of the importer and the submission
/// poll. Capping each attempt lets the next address be tried instead of the whole request
/// failing.
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Async so the windows are destroyed from the event loop rather than from inside the
/// webview callback that delivered the command (see `browser::problem_window_open`).
#[tauri::command]
async fn close_app(window: tauri::Window) {
    // The problem window, shown or hidden, would keep the process alive by itself.
    let _ = browser::close_problem_window(window.app_handle());
    let _ = window.destroy();
}

/// Scratch workspace for the development build. Its app data directory is its own
/// (io.mildeditor.desktop.dev), so importing a contest while testing cannot touch the
/// folder the installed app is pointed at.
#[tauri::command]
fn dev_workspace_path(app: tauri::AppHandle) -> Result<String, String> {
    let folder = app.path().app_data_dir().map_err(|error| error.to_string())?.join("workspace");
    std::fs::create_dir_all(&folder).map_err(|error| format!("Could not create {}: {error}", folder.display()))?;
    Ok(folder.to_string_lossy().into_owned())
}

/// An undecorated window gets its resize borders from a child window Tauri lays over the
/// edges (`TAURI_DRAG_RESIZE_BORDERS`). Tauri empties it when the window is maximised, but
/// only on a size change, and a window that starts maximised has none: the strip along the
/// top of the screen stays a resize border, so the close button cannot be hit by throwing
/// the pointer into the corner. Emptying it once after start-up is what Tauri itself does
/// on every later maximise.
#[cfg(windows)]
fn clear_maximized_resize_border(app: &tauri::AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, IsZoomed, SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER};
    let app = app.clone();
    std::thread::spawn(move || {
        // The border window appears with the webview, a moment after the window itself.
        for delay in [300, 1200, 3000] {
            std::thread::sleep(Duration::from_millis(delay));
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let Some(window) = handle.get_webview_window("main") else { return };
                let Ok(hwnd) = window.hwnd() else { return };
                let class: Vec<u16> = "TAURI_DRAG_RESIZE_BORDERS\0".encode_utf16().collect();
                unsafe {
                    if IsZoomed(hwnd.0 as _) == 0 { return; }
                    let border = FindWindowExW(hwnd.0 as _, std::ptr::null_mut(), class.as_ptr(), std::ptr::null());
                    if !border.is_null() {
                        SetWindowPos(border, std::ptr::null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER);
                    }
                }
            });
        }
    });
}

/// Development only. Prints what a probe script (see `start_debug_probe`) evaluated to.
#[tauri::command]
fn debug_report(text: String) {
    eprintln!("[probe] {text}");
}

/// Development only: with MILD_DEBUG_PROBE=<path>, re-run that file's JavaScript inside the
/// app webview each time it changes and report the awaited result through `debug_report`.
/// Lets the app be inspected from a terminal when no GUI automation is available.
#[cfg(target_os = "macos")]
fn start_debug_probe(app: tauri::AppHandle) {
    if !cfg!(debug_assertions) { return; }
    let Some(path) = std::env::var_os("MILD_DEBUG_PROBE").map(std::path::PathBuf::from) else { return };
    std::thread::spawn(move || {
        let mut seen: Option<std::time::SystemTime> = None;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) else { continue };
            if seen == Some(modified) {
                continue;
            }
            seen = Some(modified);
            let Ok(script) = std::fs::read_to_string(&path) else { continue };
            let wrapped = format!(
                "(async () => {{ let out; try {{ out = await (async () => {{ {script} }})(); }} catch (error) {{ out = 'ERR ' + (error && error.stack || error); }} window.__TAURI_INTERNALS__.invoke('debug_report', {{ text: String(out) }}); }})();"
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(&wrapped);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(clangd::ClangdState::default())
        .manage(runner::RunState::default())
        .manage(interactive::InteractiveState::default())
        .manage(terminal::TerminalState::default())
        .manage(companion::CompanionState::default())
        .manage(updates::PendingUpdate::default())
        .manage(browser::BrowserState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(target_os = "macos")]
    let builder = builder
        .setup(|app| {
            macos_menu::install(app.handle())?;
            // Start in the real macOS full screen — its own Space with the menu bar out of
            // the way — rather than the configured size in the middle of the display. An
            // undecorated window ignores `maximized` in the config, and maximising it only
            // fills the work area, which is not what full screen means here.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_fullscreen(true);
            }
            browser::prepare(app.handle());
            start_debug_probe(app.handle().clone());
            Ok(())
        })
        .on_menu_event(macos_menu::forward_event);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.setup(|app| {
        browser::prepare(app.handle());
        #[cfg(windows)]
        clear_maximized_resize_border(app.handle());
        Ok(())
    });

    builder
        .invoke_handler(tauri::generate_handler![
            runner::run_code,
            runner::stop_run,
            stress::stress_test,
            updates::check_update,
            updates::install_update,
            interactive::start_interactive,
            interactive::send_interactive,
            interactive::close_interactive_input,
            interactive::stop_interactive,
            close_app,
            files::export_settings_file,
            files::import_settings_file,
            files::read_font_file,
            files::read_image_file,
            workspace::save_workspace_tests,
            workspace::update_workspace_source,
            workspace::create_workspace,
            workspace::save_workspace,
            workspace::save_workspace_panel_mode,
            workspace::list_workspace_source_filenames,
            workspace::list_workspace_directories,
            workspace::reload_workspace_files,
            workspace::reorder_workspace_files,
            workspace::create_workspace_folder,
            workspace::rename_workspace_folder,
            workspace::move_workspace_folder,
            workspace::delete_workspace_folder,
            workspace::delete_workspace_file,
            workspace::open_workspace_file_location,
            workspace::open_workspace_folder_location,
            workspace::duplicate_workspace_file,
            workspace::rename_workspace_file,
            workspace::load_workspace,
            import::import_problem,
            submissions::refresh_submission_statuses,
            clangd::start_clangd,
            clangd::send_clangd_message,
            clangd::stop_clangd,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_stop,
            companion::start_companion,
            companion::stop_companion,
            browser::browser_status,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_navigate,
            browser::browser_go,
            browser::browser_extensions_list,
            browser::browser_extension_install,
            browser::browser_extension_remove,
            browser::browser_import_page,
            browser::browser_fill_submission,
            browser::browser_install_userscript,
            browser::problem_window_open,
            browser::problem_window_hide,
            browser::problem_window_close,
            browser::problem_window_take_url,
            dev_workspace_path,
            debug_report
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    // The problem window only ever hides: its page and browser are kept
                    // for the next time, and the app window is told so its chip follows.
                    if window.label() == browser::PROBLEM_WINDOW {
                        browser::hide_problem_window(window.app_handle());
                    } else {
                        let _ = window.emit("native-close-requested", ());
                    }
                }
                tauri::WindowEvent::Moved(_) => {
                    browser::window_moved(window, &window.state::<browser::BrowserState>());
                }
                tauri::WindowEvent::Destroyed if window.label() == browser::PROBLEM_WINDOW => {
                    browser::host_destroyed(window, &window.state::<browser::BrowserState>());
                }
                tauri::WindowEvent::Destroyed => {
                    clangd::stop(&window.state::<clangd::ClangdState>());
                    interactive::stop_session(&window.state::<interactive::InteractiveState>());
                    companion::stop(&window.state::<companion::CompanionState>());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building mild editor")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                browser::shutdown(app);
            }
        });
}
