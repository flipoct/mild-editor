//! The clangd process behind the editor's C++ language features: started on demand, with
//! its LSP messages relayed to and from the webview.

use serde::Serialize;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
};
use tauri::Emitter;

use crate::tools::{find_tool, tool_search_path, CommandExtHidden};

const MISSING_CLANGD: &str = if cfg!(target_os = "macos") {
    "clangd was not found. Install it with `brew install llvm`, or configure its path in Settings."
} else {
    "clangd was not found. Install LLVM clangd or configure its path in Settings."
};

struct ClangdProcess {
    child: std::process::Child,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
}

#[derive(Default)]
pub(crate) struct ClangdState(Mutex<Option<ClangdProcess>>, AtomicU64);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClangdInfo {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    /// Which start this is; `clangd-exit` names it, so an editor can tell a crash of the
    /// clangd it talks to from the end of one it replaced.
    generation: u64,
}

/// The first line of every `.clangd` the editor writes. A file with it is the editor's to keep
/// up to date; one without it is the user's own and is never touched.
const MANAGED_MARKER: &str = "# Written by Mild Editor; edit freely after deleting this line.";

/// A YAML double-quoted scalar: a Windows path, a space or a `#` is safe inside one.
fn yaml_quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The `.clangd` for a compiler and the AtCoder Library's folder.
fn clangd_config(compiler: &str, atcoder_library_path: Option<&str>) -> String {
    let mut flags = vec![yaml_quoted("-std=gnu++20")];
    if let Some(include) = atcoder_library_path.filter(|path| !path.trim().is_empty()) {
        flags.push(yaml_quoted(&format!("-I{}", include.replace('\\', "/"))));
    }
    format!("{MANAGED_MARKER}\nCompileFlags:\n  Compiler: {}\n  Add: [{}]\n", yaml_quoted(&compiler.replace('\\', "/")), flags.join(", "))
}

/// Whether the `.clangd` there may be (re)written: there is none, it carries the marker, or it
/// is exactly what versions before the marker wrote — so a changed compiler or library folder
/// reaches it, instead of clangd going on with the paths of the day it was first written.
fn config_is_managed(existing: Option<&str>) -> bool {
    let Some(text) = existing else { return true };
    if text.starts_with(MANAGED_MARKER) { return true; }
    let lines: Vec<&str> = text.lines().collect();
    lines.len() == 3
        && lines[0] == "CompileFlags:"
        && lines[1].starts_with("  Compiler: ")
        && lines[2].starts_with("  Add: [-std=gnu++20")
}

fn resolve_clangd(configured_path: Option<String>) -> Result<std::path::PathBuf, String> {
    if let Some(path) = configured_path.filter(|path| !path.trim().is_empty()) {
        let path = std::path::PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err("The configured clangd executable was not found.".into());
    }
    find_tool("clangd").ok_or_else(|| MISSING_CLANGD.to_string())
}

/// Relays clangd's messages until its output ends, then says so: the end of the stream is
/// the end of the process, however it came.
fn read_lsp_stream<R: Read>(reader: R, app: tauri::AppHandle, generation: u64) {
    relay_lsp_messages(reader, &app);
    let _ = app.emit("clangd-exit", generation);
}

fn relay_lsp_messages<R: Read>(reader: R, app: &tauri::AppHandle) {
    let mut reader = BufReader::new(reader);
    loop {
        let mut content_length = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
        let Some(length) = content_length else {
            continue;
        };
        let mut body = vec![0u8; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        if let Ok(message) = String::from_utf8(body) {
            let _ = app.emit("clangd-message", message);
        }
    }
}

#[tauri::command]
pub(crate) fn start_clangd(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClangdState>,
    configured_path: Option<String>,
    workspace_path: Option<String>,
    atcoder_library_path: Option<String>,
) -> Result<ClangdInfo, String> {
    let path = resolve_clangd(configured_path)?;
    let mut process_guard = state.0.lock().map_err(|_| "Could not lock clangd state.")?;
    if let Some(mut previous) = process_guard.take() {
        let _ = previous.child.kill();
        let _ = previous.child.wait();
    }
    let mut clangd_args = vec![
        "--background-index=false".to_string(),
        "--clang-tidy=false".to_string(),
        "--header-insertion=never".to_string(),
        "--log=error".to_string(),
    ];
    if let Some(compiler) = find_tool("g++") {
        clangd_args.push(format!("--query-driver={}", compiler.to_string_lossy()));
        if let Some(workspace_path) = workspace_path {
            let config_path = Path::new(&workspace_path).join(".clangd");
            let existing = fs::read_to_string(&config_path).ok();
            if config_is_managed(existing.as_deref()) {
                let config = clangd_config(&compiler.to_string_lossy(), atcoder_library_path.as_deref());
                if existing.as_deref() != Some(config.as_str()) {
                    let _ = fs::write(config_path, config);
                }
            }
        }
    }
    let mut child = Command::new(&path)
        .args(&clangd_args)
        .env("PATH", tool_search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|error| format!("Could not start clangd: {error}"))?;
    let stdin = Arc::new(Mutex::new(
        child.stdin.take().ok_or("Could not open clangd stdin.")?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or("Could not open clangd stdout.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Could not open clangd stderr.")?;
    let generation = state.1.fetch_add(1, Ordering::Relaxed) + 1;
    let stdout_app = app.clone();
    thread::spawn(move || read_lsp_stream(stdout, stdout_app, generation));
    thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut sink);
    });
    *process_guard = Some(ClangdProcess { child, stdin });
    let version = Command::new(&path)
        .arg("--version")
        .env("PATH", tool_search_path())
        .creation_flags(0x08000000)
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| text.lines().next().map(str::to_string));
    Ok(ClangdInfo {
        available: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
        generation,
    })
}

#[tauri::command]
pub(crate) fn send_clangd_message(
    state: tauri::State<'_, ClangdState>,
    message: String,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|_| "Could not lock clangd state.")?;
    let process = guard.as_ref().ok_or("clangd is not running.")?;
    let mut stdin = process.stdin.lock().map_err(|_| "Could not lock clangd stdin.")?;
    write!(
        stdin,
        "Content-Length: {}\r\n\r\n{}",
        message.as_bytes().len(),
        message
    )
    .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

/// Kills clangd, if it is running.
pub(crate) fn stop(state: &ClangdState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut process) = guard.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

#[tauri::command]
pub(crate) fn stop_clangd(state: tauri::State<'_, ClangdState>) {
    stop(&state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_config_quotes_what_yaml_would_misread() {
        let config = clangd_config("C:\\Program Files\\mingw64\\bin\\g++.exe", Some("C:\\lib # ac-library"));
        assert!(config.starts_with(MANAGED_MARKER));
        assert!(config.contains("Compiler: \"C:/Program Files/mingw64/bin/g++.exe\""), "{config}");
        assert!(config.contains("Add: [\"-std=gnu++20\", \"-IC:/lib # ac-library\"]"), "{config}");
    }

    #[test]
    fn only_the_editors_own_config_is_rewritten() {
        assert!(config_is_managed(None));
        assert!(config_is_managed(Some(&clangd_config("/usr/bin/g++", None))));
        // What versions before the marker wrote.
        assert!(config_is_managed(Some("CompileFlags:\n  Compiler: C:/old/g++.exe\n  Add: [-std=gnu++20]\n")));
        // Anything else is the user's.
        assert!(!config_is_managed(Some("CompileFlags:\n  Add: [-std=c++17]\n")));
        assert!(!config_is_managed(Some("CompileFlags:\n  Compiler: g++\n  Add: [-std=gnu++20]\nDiagnostics:\n  Suppress: '*'\n")));
    }
}
