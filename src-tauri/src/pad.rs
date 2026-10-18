//! Drawing on a board from a tablet or a phone, with nothing to install.
//!
//! The board in front shows a QR code; the tablet's browser opens it and gets a small page
//! (`pad.html`, built with the rest of the frontend) from this computer, which then talks to
//! the editor over a WebSocket on the same port. The browser on the tablet cannot join the
//! room itself — a page from a plain `http://` address has no WebCrypto, and the room's
//! frames are encrypted with it — so it draws on its owner's copy of the board, and the
//! editor carries the strokes into the room like its own.
//!
//! This side is a pipe. Every message from a tablet becomes a `pad-message` event for the
//! window, with the client and the pairing it came through; `pad_send` goes the other way.
//! Only a socket that names a pairing the editor opened (`pad_open`, a random token in the
//! QR code) is accepted, and when the last pairing closes nothing listens any more.
//!
//! A tablet on the same network as the computer reaches it at once. One that is not — on
//! mobile data, say — needs a way in from outside: on request (`pad_forward_port`) the router
//! is asked to forward the port here, as for a room (src/collab.rs), and given it back when
//! the server stops. That part of the way is plain HTTP over the internet: only strokes go
//! over it, and only to a page that knows the pairing's token.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::Message;

/// The port tried first, beside the relay's; any free one when it is taken.
pub const DEFAULT_PORT: u16 = 10046;
/// A request head larger than this is not one this page's browser sends.
const MOST_HEAD: usize = 16 * 1024;
const MOST_MESSAGE: usize = 4 * 1024 * 1024;

type Outbox = mpsc::UnboundedSender<String>;

#[derive(Default)]
struct Shared {
    /// The pairings open now, by token.
    tokens: std::collections::HashSet<String>,
    /// Every connected tablet: its pairing, and the way to it.
    clients: HashMap<u64, (String, Outbox)>,
}

struct Running {
    port: u16,
    shared: Arc<Mutex<Shared>>,
    stop: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct PadState {
    running: Mutex<Option<Running>>,
    /// The router's forward to the server, while one was asked for.
    forward: Mutex<Option<crate::collab::Forward>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PadAddress {
    pub port: u16,
    /// This computer's addresses on the local network, the likeliest first.
    pub addresses: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PadEvent {
    client: u64,
    token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

/// What a request asks for, read off its head without taking it from the socket: the path,
/// and whether it is a WebSocket upgrade. None when it is not a request this server answers.
fn read_head(head: &[u8]) -> Option<(String, bool)> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let mut request = lines.next()?.split(' ');
    if request.next()? != "GET" {
        return None;
    }
    let path = request.next()?.to_owned();
    let upgrade = lines.take_while(|line| !line.is_empty()).any(|line| {
        let (name, value) = line.split_once(':').unwrap_or((line, ""));
        name.trim().eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
    });
    Some((path, upgrade))
}

/// The pairing a socket's path names: `/ws?t=<token>`.
fn token_of(path: &str) -> Option<&str> {
    let (route, query) = path.split_once('?')?;
    if route != "/ws" {
        return None;
    }
    query.split('&').find_map(|pair| pair.strip_prefix("t=")).filter(|token| !token.is_empty())
}

/// Which file of the frontend a page request is for, or None for anything else. Only the
/// pad page and the built assets are served, never the editor's own page.
fn page_path(path: &str) -> Option<String> {
    let path = path.split(['?', '#']).next().unwrap_or("/");
    if path.contains("..") || path.contains('\\') {
        return None;
    }
    match path {
        "/" | "/pad" | "/pad.html" => Some("/pad.html".into()),
        _ if path.starts_with("/assets/") => Some(path.into()),
        // The development server serves the page as modules from all over the tree.
        _ if cfg!(debug_assertions) => Some(path.into()),
        _ => None,
    }
}

async fn asset(app: &tauri::AppHandle, path: &str) -> Option<(Vec<u8>, String)> {
    // A development build has no frontend bundled: the page comes from the development server.
    #[cfg(debug_assertions)]
    if let Some(dev) = app.config().build.dev_url.clone() {
        let url = dev.join(path.trim_start_matches('/')).ok()?;
        let response = reqwest::get(url).await.ok()?.error_for_status().ok()?;
        let kind = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or("application/octet-stream").to_owned();
        return Some((response.bytes().await.ok()?.to_vec(), kind));
    }
    let asset = app.asset_resolver().get(path.to_owned())?;
    Some((asset.bytes, asset.mime_type))
}

async fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

/// The head of the request on `stream`, once it has all arrived, left in the socket.
async fn peek_head(stream: &TcpStream) -> Option<Vec<u8>> {
    let mut buffer = vec![0u8; MOST_HEAD];
    for _ in 0..250 {
        let seen = stream.peek(&mut buffer).await.ok()?;
        if seen == 0 {
            return None;
        }
        if let Some(end) = buffer[..seen].windows(4).position(|window| window == b"\r\n\r\n") {
            buffer.truncate(end + 4);
            return Some(buffer);
        }
        if seen == MOST_HEAD {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    None
}

async fn connection(app: tauri::AppHandle, shared: Arc<Mutex<Shared>>, mut stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let Some(head) = peek_head(&stream).await else { return };
    let Some((path, upgrade)) = read_head(&head) else {
        return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"").await;
    };
    if upgrade {
        return socket(app, shared, stream, &path).await;
    }
    // The head was only looked at; it is taken now that it is answered here.
    let mut taken = vec![0u8; head.len()];
    if stream.read_exact(&mut taken).await.is_err() {
        return;
    }
    match page_path(&path) {
        Some(file) => match asset(&app, &file).await {
            Some((body, kind)) => respond(&mut stream, "200 OK", &kind, &body).await,
            None => respond(&mut stream, "404 Not Found", "text/plain", b"").await,
        },
        None => respond(&mut stream, "404 Not Found", "text/plain", b"").await,
    }
}

/// One tablet, from its handshake until either side goes.
// The handshake callback's error type is tungstenite's own.
#[allow(clippy::result_large_err)]
async fn socket(app: tauri::AppHandle, shared: Arc<Mutex<Shared>>, stream: TcpStream, path: &str) {
    let token = token_of(path).map(str::to_owned);
    let paired = token.as_ref().is_some_and(|token| shared.lock().is_ok_and(|shared| shared.tokens.contains(token)));
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(MOST_MESSAGE)).max_frame_size(Some(MOST_MESSAGE));
    let handshake = tokio_tungstenite::accept_hdr_async_with_config(
        stream,
        |_: &Request, response: Response| -> Result<Response, ErrorResponse> {
            if paired {
                Ok(response)
            } else {
                let mut refusal = ErrorResponse::new(Some("this pairing is closed".into()));
                *refusal.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                Err(refusal)
            }
        },
        Some(config),
    );
    let Ok(Ok(socket)) = tokio::time::timeout(Duration::from_secs(10), handshake).await else { return };
    let Some(token) = token else { return };
    let client = NEXT_CLIENT.fetch_add(1, Ordering::Relaxed);
    let (outbox, mut queued) = mpsc::unbounded_channel::<String>();
    if let Ok(mut shared) = shared.lock() {
        shared.clients.insert(client, (token.clone(), outbox));
    }
    let _ = app.emit("pad-open", PadEvent { client, token: token.clone(), text: None });
    let (mut sink, mut source) = socket.split();
    loop {
        tokio::select! {
            incoming = source.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let _ = app.emit("pad-message", PadEvent { client, token: token.clone(), text: Some(text.to_string()) });
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_))) => {}
                _ => break,
            },
            outgoing = queued.recv() => match outgoing {
                Some(text) => if sink.send(Message::Text(text.into())).await.is_err() { break },
                // The pairing was closed: the editor let go of this tablet.
                None => break,
            },
        }
    }
    let _ = sink.close().await;
    if let Ok(mut shared) = shared.lock() {
        shared.clients.remove(&client);
    }
    let _ = app.emit("pad-gone", PadEvent { client, token, text: None });
}

fn start(app: &tauri::AppHandle) -> Result<Running, String> {
    let listener = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, DEFAULT_PORT)))
        .or_else(|_| std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))))
        .map_err(|error| format!("Could not listen for a tablet: {error}"))?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let shared = Arc::new(Mutex::new(Shared::default()));
    let (stop, mut stopped) = oneshot::channel::<()>();
    let app = app.clone();
    let serving = shared.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(listener) else { return };
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => if let Ok((stream, _)) = accepted {
                    tokio::spawn(connection(app.clone(), serving.clone(), stream));
                },
            }
        }
    });
    Ok(Running { port, shared, stop: Some(stop) })
}

/// Opens a pairing: the server starts if it is not running, and sockets naming `token` are let in.
#[tauri::command]
pub fn pad_open(app: tauri::AppHandle, state: tauri::State<'_, PadState>, token: String) -> Result<PadAddress, String> {
    if token.len() < 16 || !token.chars().all(|character| character.is_ascii_alphanumeric()) {
        return Err("A pairing needs a long random token.".into());
    }
    let mut running = state.running.lock().map_err(|_| "Could not lock the tablet state.")?;
    if running.is_none() {
        *running = Some(start(&app)?);
    }
    let server = running.as_ref().ok_or("The tablet server did not start.")?;
    server.shared.lock().map_err(|_| "Could not lock the tablet state.")?.tokens.insert(token);
    Ok(PadAddress { port: server.port, addresses: crate::collab::lan_addresses() })
}

/// Closes a pairing and lets go of its tablets; with no pairing left, nothing listens.
#[tauri::command]
pub fn pad_close(state: tauri::State<'_, PadState>, token: String) {
    close(&state, Some(&token));
}

/// Ends one pairing, or every one; the server stops once none is left.
pub fn close(state: &PadState, token: Option<&str>) {
    let Ok(mut running) = state.running.lock() else { return };
    let Some(server) = running.as_mut() else { return };
    let empty = server.shared.lock().map(|mut shared| {
        match token {
            Some(token) => {
                shared.tokens.remove(token);
                shared.clients.retain(|_, (pairing, _)| pairing != token);
            }
            None => {
                shared.tokens.clear();
                shared.clients.clear();
            }
        }
        shared.tokens.is_empty()
    }).unwrap_or(true);
    if empty {
        if let Some(stop) = server.stop.take() {
            let _ = stop.send(());
        }
        *running = None;
        // The router lets go too; it may take a moment to answer, so not on this thread.
        if let Some(forward) = state.forward.lock().ok().and_then(|mut guard| guard.take()) {
            std::thread::spawn(move || crate::collab::drop_forward(forward));
        }
    }
}

/// Sends `text` to one tablet, or to every tablet of the pairing when `client` is None.
#[tauri::command]
pub fn pad_send(state: tauri::State<'_, PadState>, token: String, client: Option<u64>, text: String) {
    let Ok(running) = state.running.lock() else { return };
    let Some(server) = running.as_ref() else { return };
    let Ok(shared) = server.shared.lock() else { return };
    for (id, (pairing, outbox)) in &shared.clients {
        if *pairing == token && client.is_none_or(|wanted| wanted == *id) {
            let _ = outbox.send(text.clone());
        }
    }
}

fn running_port(state: &PadState) -> Option<u16> {
    state.running.lock().ok().and_then(|running| running.as_ref().map(|server| server.port))
}

/// Asks the router to let a tablet outside this network reach the server, and returns the
/// address it connects to. The error is one of the words `collab::forward` names: `closed`
/// (no pairing is open), `no-gateway`, `nat` or `refused`.
#[tauri::command]
pub async fn pad_forward_port(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PadState>();
        let port = running_port(&state).ok_or("closed")?;
        let known = state.forward.lock().ok().and_then(|guard| guard.as_ref().filter(|known| known.internal_port == port).map(|known| known.address.clone()));
        if let Some(address) = known {
            return Ok(address);
        }
        let made = crate::collab::forward_port(port, "mild editor drawing board")?;
        let address = made.address.clone();
        // The pairings may all have closed while the router was thinking.
        if running_port(&state) != Some(port) {
            crate::collab::drop_forward(made);
            return Err("closed");
        }
        let previous = state.forward.lock().map_err(|_| "refused")?.replace(made);
        if let Some(previous) = previous {
            crate::collab::drop_forward(previous);
        }
        Ok(address)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heads_and_paths() {
        assert_eq!(read_head(b"GET /ws?t=abc HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"), Some(("/ws?t=abc".into(), true)));
        assert_eq!(read_head(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"), Some(("/".into(), false)));
        assert_eq!(read_head(b"POST / HTTP/1.1\r\n\r\n"), None);
        assert_eq!(token_of("/ws?t=abc123"), Some("abc123"));
        assert_eq!(token_of("/ws?x=1&t=tok"), Some("tok"));
        assert_eq!(token_of("/ws"), None);
        assert_eq!(token_of("/ws?t="), None);
        assert_eq!(token_of("/other?t=abc"), None);
        assert_eq!(page_path("/"), Some("/pad.html".into()));
        assert_eq!(page_path("/?x#t"), Some("/pad.html".into()));
        assert_eq!(page_path("/assets/pad-1.js"), Some("/assets/pad-1.js".into()));
        assert_eq!(page_path("/assets/../secret"), None);
    }
}
