//! Discord's activity status ("Rich Presence"): what is being solved, in which language, and
//! how long the contest has left, on the user's Discord profile.
//!
//! Discord's desktop app listens on a local socket — `discord-ipc-<n>` in the temporary
//! directory on macOS and Linux, a named pipe of that name on Windows — and an app that knows
//! a Discord application id may say what it is doing there. Nothing goes over the network
//! from here, and nothing is sent at all while Discord is not running. The frontend builds the
//! activity (src/discord.ts); this side only keeps the connection and passes on the latest one.
//!
//! The protocol: frames of a little-endian opcode and length, then JSON. A handshake (opcode
//! 0) names the application; `SET_ACTIVITY` commands (opcode 1) follow, at most one every few
//! seconds, as Discord asks; closing the socket clears the status.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const HANDSHAKE: u32 = 0;
const FRAME: u32 = 1;
const CLOSE: u32 = 2;
const PING: u32 = 3;
const PONG: u32 = 4;

/// Discord takes five updates in twenty seconds; this stays under that whatever the editor does.
const MIN_GAP: Duration = Duration::from_secs(4);
/// How often Discord is looked for again while it is not running.
const RETRY: Duration = Duration::from_secs(20);
/// A frame larger than this is not one Discord sends.
const MOST_FRAME: usize = 64 * 1024;

/// What the editor wants shown: the application, and the activity — none clears it.
#[derive(Clone, PartialEq, Default)]
struct Wanted {
    client_id: String,
    activity: Option<Value>,
}

#[derive(Serialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscordStatus {
    /// Connected to Discord, with the application accepted.
    pub connected: bool,
    /// Who is signed in to Discord, as Discord greets the connection.
    pub user: Option<String>,
    /// Why the last attempt did not work, when it did not.
    pub error: Option<String>,
}

#[derive(Default)]
struct Shared {
    wanted: Mutex<(Wanted, u64)>,
    changed: Condvar,
    status: Mutex<DiscordStatus>,
}

#[derive(Default)]
pub struct DiscordState {
    shared: Arc<Shared>,
    started: std::sync::atomic::AtomicBool,
}

// ── The socket ──

#[cfg(unix)]
type Socket = std::os::unix::net::UnixStream;
#[cfg(windows)]
type Socket = std::fs::File;

/// The places Discord's socket may be: the temporary directories, and where the Flatpak and
/// Snap builds of Discord keep theirs.
#[cfg(unix)]
fn candidates() -> Vec<std::path::PathBuf> {
    let mut directories: Vec<std::path::PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"].into_iter()
        .filter_map(std::env::var_os).map(std::path::PathBuf::from).collect();
    #[cfg(target_os = "macos")]
    directories.extend(user_temp_directory());
    directories.push("/tmp".into());
    let mut places = Vec::new();
    for directory in directories {
        for sub in ["", "app/com.discordapp.Discord", "snap.discord", ".flatpak/com.discordapp.Discord/xdg-run"] {
            for number in 0..10 {
                places.push(directory.join(sub).join(format!("discord-ipc-{number}")));
            }
        }
    }
    places
}

/// The user's own temporary directory, where Discord puts its socket, whatever `TMPDIR` says
/// in the environment the editor was started with.
#[cfg(target_os = "macos")]
fn user_temp_directory() -> Option<std::path::PathBuf> {
    let mut buffer = vec![0u8; 1024];
    // SAFETY: the buffer is writable for the length given; confstr writes at most that much.
    let length = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buffer.as_mut_ptr().cast(), buffer.len()) };
    if length == 0 || length > buffer.len() { return None; }
    buffer.truncate(length - 1);
    String::from_utf8(buffer).ok().map(std::path::PathBuf::from)
}

#[cfg(unix)]
fn open() -> Option<Socket> {
    candidates().into_iter().find_map(|path| {
        let socket = std::os::unix::net::UnixStream::connect(path).ok()?;
        socket.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        socket.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
        Some(socket)
    })
}

#[cfg(windows)]
fn open() -> Option<Socket> {
    (0..10).find_map(|number| std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\?\pipe\discord-ipc-{number}")).ok())
}

#[cfg(not(any(unix, windows)))]
type Socket = std::fs::File;
#[cfg(not(any(unix, windows)))]
fn open() -> Option<Socket> { None }

fn write_frame(socket: &mut impl Write, opcode: u32, payload: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(payload)?;
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&opcode.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    socket.write_all(&frame)
}

fn read_frame(socket: &mut impl Read) -> std::io::Result<(u32, Value)> {
    let mut header = [0u8; 8];
    socket.read_exact(&mut header)?;
    let opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    if length > MOST_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; length];
    socket.read_exact(&mut body)?;
    Ok((opcode, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

/// Discord's answer to the last frame, answering its pings on the way.
fn answer(socket: &mut (impl Read + Write)) -> Result<Value, String> {
    loop {
        let (opcode, payload) = read_frame(socket).map_err(|error| error.to_string())?;
        match opcode {
            PING => { let _ = write_frame(socket, PONG, &payload); }
            CLOSE => return Err(payload.get("message").and_then(Value::as_str).unwrap_or("Discord closed the connection").to_string()),
            _ => return Ok(payload),
        }
    }
}

/// Says hello as `client_id`; returns who is signed in to Discord.
fn handshake(socket: &mut (impl Read + Write), client_id: &str) -> Result<Option<String>, String> {
    write_frame(socket, HANDSHAKE, &json!({ "v": 1, "client_id": client_id })).map_err(|error| error.to_string())?;
    let ready = answer(socket)?;
    if ready.get("evt").and_then(Value::as_str) != Some("READY") {
        return Err(ready.pointer("/data/message").and_then(Value::as_str).unwrap_or("Discord did not accept the application").to_string());
    }
    let user = ready.pointer("/data/user");
    Ok(user.and_then(|user| user.get("global_name").and_then(Value::as_str).filter(|name| !name.is_empty())
        .or_else(|| user.get("username").and_then(Value::as_str))).map(str::to_string))
}

fn set_activity(socket: &mut (impl Read + Write), activity: Option<&Value>, nonce: u64) -> Result<(), String> {
    let command = json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": nonce.to_string() });
    write_frame(socket, FRAME, &command).map_err(|error| error.to_string())?;
    let reply = answer(socket)?;
    if reply.get("evt").and_then(Value::as_str) == Some("ERROR") {
        return Err(reply.pointer("/data/message").and_then(Value::as_str).unwrap_or("Discord refused the status").to_string());
    }
    Ok(())
}

// ── The worker ──

/// Keeps the connection and the status in step with what is wanted, for as long as the app runs.
fn work(shared: Arc<Shared>) {
    let mut socket: Option<(Socket, String)> = None;
    let mut shown: Option<Wanted> = None;
    let mut last_sent: Option<Instant> = None;
    let mut last_try: Option<Instant> = None;
    let mut nonce = 0u64;
    let report = |status: DiscordStatus| { if let Ok(mut current) = shared.status.lock() { *current = status; } };
    loop {
        let wanted = {
            let Ok(guard) = shared.wanted.lock() else { return };
            let seen = guard.1;
            // Wakes for a change, or now and then to look for Discord again.
            let (guard, _) = shared.changed.wait_timeout_while(guard, RETRY, |state| state.1 == seen && shown.as_ref() == Some(&state.0)).unwrap_or_else(|poison| poison.into_inner());
            guard.0.clone()
        };
        if shown.as_ref() == Some(&wanted) && socket.is_some() { continue; }
        // Turned off: the socket goes, and with it the status.
        if wanted.client_id.is_empty() || (wanted.activity.is_none() && socket.is_none()) {
            if socket.take().is_some() { report(DiscordStatus::default()); }
            shown = Some(wanted);
            continue;
        }
        if socket.as_ref().is_some_and(|(_, id)| *id != wanted.client_id) { socket = None; }
        if socket.is_none() {
            if last_try.is_some_and(|at| at.elapsed() < RETRY / 4) { std::thread::sleep(RETRY / 4); }
            last_try = Some(Instant::now());
            let Some(mut opened) = open() else {
                report(DiscordStatus { connected: false, user: None, error: Some("not-running".into()) });
                shown = None;
                continue;
            };
            match handshake(&mut opened, &wanted.client_id) {
                Ok(user) => {
                    report(DiscordStatus { connected: true, user, error: None });
                    socket = Some((opened, wanted.client_id.clone()));
                }
                Err(error) => {
                    report(DiscordStatus { connected: false, user: None, error: Some(error) });
                    // A refused application stays refused until another id is given.
                    shown = Some(wanted);
                    continue;
                }
            }
        }
        if let Some(at) = last_sent { if at.elapsed() < MIN_GAP { std::thread::sleep(MIN_GAP - at.elapsed()); } }
        // Whatever is wanted by now: a change made during the wait is not sent separately.
        let latest = shared.wanted.lock().map(|guard| guard.0.clone()).unwrap_or(wanted);
        nonce += 1;
        let Some((connection, _)) = socket.as_mut() else { continue };
        match set_activity(connection, latest.activity.as_ref(), nonce) {
            Ok(()) => { shown = Some(latest); last_sent = Some(Instant::now()); }
            Err(error) => {
                // Discord quit or restarted: connect again next time round.
                socket = None;
                shown = None;
                let user = shared.status.lock().ok().and_then(|status| status.user.clone());
                report(DiscordStatus { connected: false, user, error: Some(error) });
            }
        }
    }
}

/// An activity as the frontend gave it: an object, not too large. Discord checks the rest.
fn acceptable(activity: &Option<Value>) -> bool {
    activity.as_ref().is_none_or(|value| value.is_object() && value.to_string().len() <= 8 * 1024)
}

#[tauri::command]
pub fn discord_set_activity(state: tauri::State<'_, DiscordState>, client_id: String, activity: Option<Value>) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if !client_id.is_empty() && !(client_id.len() <= 32 && client_id.chars().all(|character| character.is_ascii_digit())) {
        return Err("A Discord application id is a number.".into());
    }
    if !acceptable(&activity) {
        return Err("That activity is not one Discord takes.".into());
    }
    let shared = state.shared.clone();
    if !state.started.swap(true, std::sync::atomic::Ordering::SeqCst) {
        std::thread::spawn(move || work(shared));
    }
    let mut wanted = state.shared.wanted.lock().map_err(|_| "Could not lock the Discord state.")?;
    let next = Wanted { client_id, activity };
    if wanted.0 != next {
        wanted.0 = next;
        wanted.1 += 1;
        state.shared.changed.notify_all();
    }
    Ok(())
}

#[tauri::command]
pub fn discord_status(state: tauri::State<'_, DiscordState>) -> DiscordStatus {
    state.shared.status.lock().map(|status| status.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pretend Discord on the other end of a pair of sockets.
    #[cfg(unix)]
    #[test]
    fn handshake_and_activity_speak_discords_frames() {
        let (mut editor, mut discord) = std::os::unix::net::UnixStream::pair().unwrap();
        let server = std::thread::spawn(move || {
            let (opcode, hello) = read_frame(&mut discord).unwrap();
            assert_eq!((opcode, hello["client_id"].as_str()), (HANDSHAKE, Some("1234")));
            write_frame(&mut discord, FRAME, &json!({ "cmd": "DISPATCH", "evt": "READY", "data": { "user": { "username": "watson", "global_name": "Watson" } } })).unwrap();
            let (opcode, command) = read_frame(&mut discord).unwrap();
            assert_eq!(opcode, FRAME);
            assert_eq!(command["cmd"], "SET_ACTIVITY");
            assert_eq!(command["args"]["activity"]["details"], "ABC 300 A");
            assert!(command["args"]["pid"].as_u64().is_some());
            // A ping on the way is answered, and the reply still arrives.
            write_frame(&mut discord, PING, &json!({ "n": 1 })).unwrap();
            write_frame(&mut discord, FRAME, &json!({ "cmd": "SET_ACTIVITY", "evt": null })).unwrap();
            assert_eq!(read_frame(&mut discord).unwrap().0, PONG);
            let (_, cleared) = read_frame(&mut discord).unwrap();
            assert!(cleared["args"]["activity"].is_null());
            write_frame(&mut discord, FRAME, &json!({ "evt": "ERROR", "data": { "message": "child \"activity\" fails" } })).unwrap();
        });
        assert_eq!(handshake(&mut editor, "1234").unwrap().as_deref(), Some("Watson"));
        set_activity(&mut editor, Some(&json!({ "details": "ABC 300 A" })), 1).unwrap();
        assert_eq!(set_activity(&mut editor, None, 2).unwrap_err(), "child \"activity\" fails");
        server.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_application_says_why() {
        let (mut editor, mut discord) = std::os::unix::net::UnixStream::pair().unwrap();
        let server = std::thread::spawn(move || {
            read_frame(&mut discord).unwrap();
            write_frame(&mut discord, CLOSE, &json!({ "code": 4000, "message": "Invalid Client ID" })).unwrap();
        });
        assert_eq!(handshake(&mut editor, "1").unwrap_err(), "Invalid Client ID");
        server.join().unwrap();
    }

    #[test]
    fn frames_are_little_endian_opcode_length_and_json() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, FRAME, &json!({ "a": 1 })).unwrap();
        assert_eq!(&buffer[..8], &[1, 0, 0, 0, 7, 0, 0, 0]);
        assert_eq!(&buffer[8..], br#"{"a":1}"#);
        assert_eq!(read_frame(&mut buffer.as_slice()).unwrap(), (FRAME, json!({ "a": 1 })));
        let mut huge = Vec::new();
        huge.extend_from_slice(&1u32.to_le_bytes());
        huge.extend_from_slice(&(MOST_FRAME as u32 + 1).to_le_bytes());
        assert!(read_frame(&mut huge.as_slice()).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_users_temporary_directory_is_found() {
        assert!(user_temp_directory().is_some_and(|directory| directory.is_dir()));
    }

    #[test]
    fn only_small_objects_are_passed_on() {
        assert!(acceptable(&None));
        assert!(acceptable(&Some(json!({ "details": "x" }))));
        assert!(!acceptable(&Some(json!("text"))));
        assert!(!acceptable(&Some(json!({ "details": "x".repeat(9000) }))));
    }
}
