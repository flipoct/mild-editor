//! The built-in terminal: the user's shell on a pseudo-terminal, streamed to the panel.
//!
//! One session at a time, started in the workspace folder. Output is read on a thread and
//! sent to the frontend as `terminal-output` events; keystrokes and resizes come back as
//! commands. A pseudo-terminal (ConPTY on Windows) rather than plain pipes, so the shell
//! sees a real terminal: prompts, colours, line editing and full-screen programs all work.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const OUTPUT_EVENT: &str = "terminal-output";
pub const EXIT_EVENT: &str = "terminal-exit";
/// Output gathered for this long is sent as one event: a program printing a flood of lines
/// would otherwise send the webview more events than it can draw.
const BATCH_WINDOW: Duration = Duration::from_millis(8);
const MAX_BATCH: usize = 256 * 1024;

/// The shell's process, as portable-pty hands it back.
type ShellProcess = Box<dyn Child + Send + Sync>;

struct Session {
    id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    shell: ShellProcess,
}

impl Session {
    /// Ends the shell. Used when a session is replaced or stopped, and when the app exits.
    fn end(&mut self) {
        let _ = self.shell.kill();
    }
}

impl Drop for Session {
    fn drop(&mut self) { self.end(); }
}

#[derive(Default)]
pub struct TerminalState(Arc<Mutex<Option<Session>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    /// The folder the shell starts in; without one, or when it is gone, the home folder.
    #[serde(default)]
    cwd: Option<String>,
    cols: u16,
    rows: u16,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    session_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    session_id: String,
    code: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    session_id: String,
    shell: String,
}

/// The shell to start and its arguments. On macOS and Linux it is the user's own `$SHELL`,
/// as a login shell: an app started from the Dock or a launcher gets a bare PATH, and a
/// login shell reads the profile that puts Homebrew, pyenv and the rest on it. On Windows,
/// PowerShell 7 when installed, then Windows PowerShell, then `cmd`.
pub(crate) fn shell_command(windows: bool, env_shell: Option<&str>, installed: &dyn Fn(&str) -> bool) -> (String, Vec<String>) {
    if windows {
        for program in ["pwsh", "powershell"] {
            if installed(program) { return (program.into(), vec!["-NoLogo".into()]); }
        }
        return ("cmd".into(), Vec::new());
    }
    let shell = env_shell
        .map(str::trim)
        .filter(|path| !path.is_empty() && Path::new(path).is_absolute() && installed(path))
        .map(str::to_string)
        .unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() });
    // Plain POSIX shells do not all take -l; the ones people use as their shell do.
    let name = Path::new(&shell).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let login = !matches!(name.as_str(), "sh" | "dash");
    (shell, if login { vec!["-l".into()] } else { Vec::new() })
}

fn starting_folder(cwd: Option<&str>) -> PathBuf {
    cwd.map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Takes the text `pending` holds, leaving behind the start of a character the next read
/// will finish: a read can end in the middle of one, and decoding that half on its own
/// would print garbage where a Korean syllable should be. Bytes that are not UTF-8 at all
/// come out as U+FFFD.
pub(crate) fn take_text(pending: &mut Vec<u8>) -> String {
    let mut text = String::new();
    let mut rest: &[u8] = pending;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => { text.push_str(valid); rest = &[]; break; }
            Err(error) => {
                let (valid, after) = rest.split_at(error.valid_up_to());
                text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match error.error_len() {
                    Some(length) => { text.push('\u{FFFD}'); rest = &after[length..]; }
                    None => { rest = after; break; }
                }
            }
        }
    }
    let tail = rest.to_vec();
    *pending = tail;
    text
}

/// Reads the terminal on one thread and sends what it read on another, in batches.
fn pump(app: AppHandle, session_id: String, mut reader: Box<dyn Read + Send>) {
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => if sender.send(buffer[..read].to_vec()).is_err() { break },
            }
        }
    });
    std::thread::spawn(move || {
        let mut pending = Vec::new();
        while let Ok(first) = receiver.recv() {
            pending.extend(first);
            let deadline = std::time::Instant::now() + BATCH_WINDOW;
            while pending.len() < MAX_BATCH {
                match receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
                    Ok(more) => pending.extend(more),
                    Err(_) => break,
                }
            }
            let data = take_text(&mut pending);
            if !data.is_empty() {
                let _ = app.emit(OUTPUT_EVENT, OutputEvent { session_id: session_id.clone(), data });
            }
        }
    });
}

/// Watches for the shell to end — `exit`, or a crash — and tells the panel, which offers a
/// new one. The session is cleared so its terminal is closed with it.
fn watch_exit(app: AppHandle, sessions: Arc<Mutex<Option<Session>>>, session_id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
        let mut guard = match sessions.lock() { Ok(guard) => guard, Err(_) => return };
        let Some(session) = guard.as_mut() else { return };
        if session.id != session_id { return; }
        match session.shell.try_wait() {
            Ok(None) => continue,
            Ok(Some(status)) => {
                let code = Some(status.exit_code());
                guard.take();
                let _ = app.emit(EXIT_EVENT, ExitEvent { session_id, code });
                return;
            }
            Err(_) => {
                guard.take();
                let _ = app.emit(EXIT_EVENT, ExitEvent { session_id, code: None });
                return;
            }
        }
    });
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.clamp(2, 1000), cols: cols.clamp(2, 1000), pixel_width: 0, pixel_height: 0 }
}

type Opened = (Box<dyn MasterPty + Send>, Box<dyn Write + Send>, ShellProcess, Box<dyn Read + Send>);

/// Starts `program` on a new pseudo-terminal in `folder`, returning both ends of it.
fn open_session(program: &str, args: &[String], folder: &Path, cols: u16, rows: u16) -> Result<Opened, String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|error| format!("Could not open a terminal: {error}"))?;
    let mut command = CommandBuilder::new(program);
    command.args(args);
    command.cwd(folder);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "MildEditor");
    let shell = pair.slave.spawn_command(command).map_err(|error| format!("Could not start {program}: {error}"))?;
    // The shell holds the other end now; keeping it here would keep the terminal open after the shell exits.
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    Ok((pair.master, writer, shell, reader))
}

/// Starts a shell, ending the one before it.
#[tauri::command]
pub fn terminal_start(app: AppHandle, state: tauri::State<'_, TerminalState>, request: StartRequest) -> Result<Started, String> {
    let sessions = state.0.clone();
    let mut guard = sessions.lock().map_err(|_| "The terminal is busy.")?;
    guard.take();

    let installed = |program: &str| if Path::new(program).is_absolute() { Path::new(program).is_file() } else { crate::find_tool(program).is_some() };
    let shell_env = std::env::var("SHELL").ok();
    let (program, args) = shell_command(cfg!(windows), shell_env.as_deref(), &installed);
    let (master, writer, shell, reader) = open_session(&program, &args, &starting_folder(request.cwd.as_deref()), request.cols, request.rows)?;

    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or_default();
    let session_id = format!("{stamp:x}");
    pump(app.clone(), session_id.clone(), reader);
    *guard = Some(Session { id: session_id.clone(), master, writer, shell });
    drop(guard);
    watch_exit(app, sessions, session_id.clone());
    let shell_name = Path::new(&program).file_stem().map(|name| name.to_string_lossy().into_owned()).unwrap_or(program);
    Ok(Started { session_id, shell: shell_name })
}

/// Keystrokes and pasted text, as the terminal produced them.
#[tauri::command]
pub fn terminal_write(state: tauri::State<'_, TerminalState>, session_id: String, data: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "The terminal is busy.")?;
    let session = guard.as_mut().filter(|session| session.id == session_id).ok_or("The terminal has ended.")?;
    session.writer.write_all(data.as_bytes()).and_then(|_| session.writer.flush()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn terminal_resize(state: tauri::State<'_, TerminalState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.0.lock().map_err(|_| "The terminal is busy.")?;
    let Some(session) = guard.as_ref().filter(|session| session.id == session_id) else { return Ok(()) };
    session.master.resize(size(cols, rows)).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn terminal_stop(state: tauri::State<'_, TerminalState>) {
    if let Ok(mut guard) = state.0.lock() { guard.take(); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_split_mid_character_waits_for_the_rest() {
        let word = "한글 ok".as_bytes();
        // Cut inside the first syllable (3 bytes): nothing to send yet.
        let mut pending = word[..2].to_vec();
        assert_eq!(take_text(&mut pending), "");
        assert_eq!(pending, word[..2]);
        pending.extend_from_slice(&word[2..]);
        assert_eq!(take_text(&mut pending), "한글 ok");
        assert!(pending.is_empty());
        // Not UTF-8 at all: replaced, and what follows still comes through.
        let mut broken = vec![b'a', 0xff, b'b'];
        assert_eq!(take_text(&mut broken), "a\u{FFFD}b");
        assert!(broken.is_empty());
    }

    #[test]
    fn the_shell_is_the_users_own_as_a_login_shell() {
        let everything = |_: &str| true;
        assert_eq!(shell_command(false, Some("/opt/homebrew/bin/fish"), &everything), ("/opt/homebrew/bin/fish".to_string(), vec!["-l".to_string()]));
        // A relative or missing $SHELL falls back to the platform's shell.
        let fallback = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" };
        assert_eq!(shell_command(false, Some("fish"), &everything).0, fallback);
        assert_eq!(shell_command(false, Some("/no/such/shell"), &|program| program != "/no/such/shell").0, fallback);
        assert_eq!(shell_command(false, None, &everything).0, fallback);
        // dash and sh are not asked for a login shell they may not support.
        assert_eq!(shell_command(false, Some("/bin/sh"), &everything).1, Vec::<String>::new());
    }

    #[test]
    fn windows_prefers_powershell_7_then_windows_powershell_then_cmd() {
        assert_eq!(shell_command(true, None, &|_| true).0, "pwsh");
        assert_eq!(shell_command(true, None, &|program| program == "powershell").0, "powershell");
        assert_eq!(shell_command(true, None, &|_| false), ("cmd".to_string(), Vec::new()));
    }

    #[test]
    fn a_missing_folder_starts_the_shell_at_home() {
        let home = starting_folder(Some("/definitely/not/here"));
        assert!(home.is_dir(), "{}", home.display());
        let temp = std::env::temp_dir();
        assert_eq!(starting_folder(temp.to_str()), temp);
    }

    /// A real session: a shell on a pseudo-terminal, in the folder asked for, that reads
    /// what is typed and whose output comes back — the whole path the panel uses.
    #[cfg(unix)]
    #[test]
    fn a_session_runs_in_its_folder_and_echoes_what_is_typed() {
        let folder = tempfile::tempdir().expect("temp dir");
        let canonical = folder.path().canonicalize().expect("canonical");
        let (master, mut writer, mut shell, mut reader) = open_session("/bin/sh", &[], &canonical, 80, 24).expect("opens");
        // Read on a thread for as long as the terminal is open, as the app does: on macOS a
        // shell leaving a terminal waits for its last output to be read, so a reader that
        // stops early would leave it hanging in exit.
        let output = Arc::new(Mutex::new(Vec::new()));
        let collected = output.clone();
        let drain = std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => collected.lock().expect("output").extend_from_slice(&buffer[..read]),
                }
            }
        });
        writer.write_all(b"pwd; printf 'tty=%s term=%s\\n' \"$(test -t 0 && echo yes)\" \"$TERM\"; exit 7\n").expect("types");
        writer.flush().expect("flush");
        let status = shell.wait().expect("exits");
        assert_eq!(status.exit_code(), 7);
        drop(writer);
        drop(master);
        // The reader ends once the terminal is closed; not waited on past a few seconds.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !drain.is_finished() && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
        let text = String::from_utf8_lossy(&output.lock().expect("output")).into_owned();
        assert!(text.contains(&*canonical.to_string_lossy()), "{text}");
        assert!(text.contains("tty=yes term=xterm-256color"), "the shell should see a colour terminal: {text}");
    }
}
