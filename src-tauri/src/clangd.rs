//! The clangd process behind the editor's C++ language features: started on demand, with
//! its LSP messages relayed to and from the webview.

use serde::Serialize;
use std::sync::{Arc, Mutex};
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
pub(crate) struct ClangdState(Mutex<Option<ClangdProcess>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClangdInfo {
    available: bool,
    path: Option<String>,
    version: Option<String>,
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

fn read_lsp_stream<R: Read>(reader: R, app: tauri::AppHandle) {
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
            if !config_path.exists() {
                let compiler_path = compiler.to_string_lossy().replace('\\', "/");
                let mut flags = vec!["-std=gnu++20".to_string()];
                if let Some(include) = atcoder_library_path.as_ref().filter(|path| !path.trim().is_empty()) {
                    flags.push(format!("-I{}", include.replace('\\', "/")));
                }
                let config = format!("CompileFlags:\n  Compiler: {compiler_path}\n  Add: [{}]\n", flags.join(", "));
                let _ = fs::write(config_path, config);
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
    let stdout_app = app.clone();
    thread::spawn(move || read_lsp_stream(stdout, stdout_app));
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
