#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Windows and Linux CEF sub-processes re-enter this binary; they must never
    // reach the editor. Nothing to do on macOS, which uses the separate helper.
    mild_editor_lib::browser::exit_if_subprocess();
    mild_editor_lib::run();
}
