//! Manual interactive judging: the program under test runs as a long-lived child process
//! while the user plays the interactor, typing each response by hand. Output is streamed to
//! the frontend as it arrives instead of being collected at exit.

use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

use crate::{prepare_program, tool_search_path, CommandExtHidden, PreparedProgram};

const MAX_CODE: usize = 100_000;
const MAX_STREAM_OUTPUT: usize = 1_000_000;
const MAX_SEND: usize = 100_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInteractiveRequest {
    language: String,
    code: String,
    session_id: String,
    #[serde(default)]
    atcoder_library_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendInteractiveRequest {
    session_id: String,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InteractiveOutputEvent {
    session_id: String,
    stream: &'static str,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InteractiveExitEvent {
    session_id: String,
    code: Option<i32>,
    time_ms: u128,
    stopped: bool,
}

pub struct Session {
    id: String,
    child: Arc<Mutex<std::process::Child>>,
    stdin: Option<std::process::ChildStdin>,
    stopped: Arc<Mutex<bool>>,
    /// Keeps the compiled binary alive for as long as the process runs.
    _directory: tempfile::TempDir,
}

#[derive(Default)]
pub struct InteractiveState(pub Mutex<Option<Session>>);

fn kill(session: &Session) {
    if let Ok(mut flag) = session.stopped.lock() {
        *flag = true;
    }
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
}

/// Stops whatever session is currently running, if any.
pub fn stop_session(state: &InteractiveState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(session) = guard.take() {
            kill(&session);
        }
    }
}

/// Streams one output pipe to the frontend, holding back only the bytes that split a UTF-8
/// character so that a prompt without a trailing newline still shows up immediately.
fn pump<R: Read + Send + 'static>(
    reader: R,
    app: tauri::AppHandle,
    session_id: String,
    stream: &'static str,
) {
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        let mut total = 0usize;
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            total += read;
            pending.extend_from_slice(&buffer[..read]);
            let text = match std::str::from_utf8(&pending) {
                Ok(text) => {
                    let text = text.to_owned();
                    pending.clear();
                    text
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    let mut text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    let skip = match error.error_len() {
                        Some(length) => {
                            text.push('\u{fffd}');
                            valid + length
                        }
                        None => valid,
                    };
                    pending.drain(..skip);
                    text
                }
            };
            if !text.is_empty() {
                let _ = app.emit(
                    "interactive-output",
                    InteractiveOutputEvent { session_id: session_id.clone(), stream, text },
                );
            }
            if total > MAX_STREAM_OUTPUT {
                let _ = app.emit(
                    "interactive-output",
                    InteractiveOutputEvent {
                        session_id: session_id.clone(),
                        stream: "stderr",
                        text: "\nError: output limit exceeded\n".into(),
                    },
                );
                break;
            }
        }
    });
}

fn spawn_session(app: tauri::AppHandle, request: StartInteractiveRequest) -> Result<Session, String> {
    if !matches!(request.language.as_str(), "cpp" | "python") {
        return Err("Unsupported language.".into());
    }
    if request.code.len() > MAX_CODE {
        return Err("The source code is too large.".into());
    }

    let directory = tempfile::Builder::new()
        .prefix("mild-editor-interactive-")
        .tempdir()
        .map_err(|error| error.to_string())?;
    let cwd = directory.path();

    let (command, args) = match prepare_program(
        &request.language,
        &request.code,
        request.atcoder_library_path.as_deref(),
        cwd,
        true,
    )? {
        PreparedProgram::Ready { command, args } => (command, args),
        PreparedProgram::CompileError(result) => return Err(result.stderr),
    };

    let started = Instant::now();
    let mut child = Command::new(&command)
        .args(&args)
        .current_dir(cwd)
        // The test runner widens PATH the same way; without it an interactive run
        // launched from a macOS `.app` sees only launchd's bare PATH and cannot
        // reach anything the solution shells out to.
        .env("PATH", tool_search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|error| error.to_string())?;

    let stdin = child.stdin.take();
    if let Some(stdout) = child.stdout.take() {
        pump(stdout, app.clone(), request.session_id.clone(), "stdout");
    }
    if let Some(stderr) = child.stderr.take() {
        pump(stderr, app.clone(), request.session_id.clone(), "stderr");
    }

    let child = Arc::new(Mutex::new(child));
    let stopped = Arc::new(Mutex::new(false));
    let session = Session {
        id: request.session_id.clone(),
        child: child.clone(),
        stdin,
        stopped: stopped.clone(),
        _directory: directory,
    };

    let session_id = request.session_id;
    thread::spawn(move || {
        let status = loop {
            let waited = child.lock().ok().and_then(|mut child| child.try_wait().ok().flatten());
            match waited {
                Some(status) => break Some(status),
                None => thread::sleep(Duration::from_millis(40)),
            }
        };
        let _ = app.emit(
            "interactive-exit",
            InteractiveExitEvent {
                session_id,
                code: status.and_then(|status| status.code()),
                time_ms: started.elapsed().as_millis(),
                stopped: stopped.lock().map(|flag| *flag).unwrap_or(false),
            },
        );
    });

    Ok(session)
}

#[tauri::command]
pub async fn start_interactive(
    app: tauri::AppHandle,
    request: StartInteractiveRequest,
) -> Result<(), String> {
    stop_session(&app.state::<InteractiveState>());
    let handle = app.clone();
    let session = tauri::async_runtime::spawn_blocking(move || spawn_session(handle, request))
        .await
        .map_err(|error| error.to_string())??;
    let state = app.state::<InteractiveState>();
    let mut guard = state.0.lock().map_err(|_| "Interactive state is unavailable.".to_string())?;
    if let Some(previous) = guard.take() {
        kill(&previous);
    }
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
pub fn send_interactive(
    state: tauri::State<'_, InteractiveState>,
    request: SendInteractiveRequest,
) -> Result<(), String> {
    if request.text.len() > MAX_SEND {
        return Err("The response is too large.".into());
    }
    let mut guard = state.0.lock().map_err(|_| "Interactive state is unavailable.".to_string())?;
    let session = guard.as_mut().ok_or("No interactive run is active.")?;
    if session.id != request.session_id {
        return Err("This interactive run has already ended.".into());
    }
    let stdin = session.stdin.as_mut().ok_or("Standard input is already closed.")?;
    stdin
        .write_all(request.text.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|_| "The program is no longer reading input.".to_string())
}

/// Sends EOF, which is how an interactor tells the solution that no more input follows.
#[tauri::command]
pub fn close_interactive_input(state: tauri::State<'_, InteractiveState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "Interactive state is unavailable.".to_string())?;
    let session = guard.as_mut().ok_or("No interactive run is active.")?;
    session.stdin = None;
    Ok(())
}

#[tauri::command]
pub fn stop_interactive(state: tauri::State<'_, InteractiveState>) {
    stop_session(&state);
}
