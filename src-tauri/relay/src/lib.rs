//! The relay behind shared rooms.
//!
//! A room is a set of WebSocket connections that asked for the same room id. Every binary
//! frame one of them sends is handed, untouched, to the others, and that is all the relay
//! does: it has no documents, no accounts and nothing on disk. What the frames mean is the
//! clients' business (src/collab/protocol.ts) — they are encrypted with a key the relay is
//! never given, and the room id is a one-way derivation of the join code, not the code.
//!
//!   ws://host:port/room/<id>?open     the room is created if it is not there
//!   ws://host:port/room/<id>          only an existing room can be joined
//!
//! Which of the two a client asks for is its own business: the editor opens with `?open`
//! when it already holds the document (it started the room, or is coming back to it) and
//! without when it is new to it, so that a wrong join code finds no room instead of making
//! an empty one. No connection is special to the relay, and a room has no owner: it lives
//! exactly as long as someone is in it. A connection that cannot be served is
//! accepted and then closed with one of the [`close`] codes, because a browser cannot read
//! the status of a refused handshake and the client has to tell "no such room" from "the
//! address is wrong".
//!
//! The same code runs in two places: inside the app, for the one room a user opens to the
//! LAN ([`Server`], see src-tauri/src/collab.rs), and as the `mild-relay` program on a
//! server (src/main.rs), which is why nothing here knows about Tauri.

use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Semaphore};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Bytes, Message};

/// The port a room is opened on unless another is asked for: the one after Competitive
/// Companion's, so the two listeners of the app sit side by side.
pub const DEFAULT_PORT: u16 = 10044;

/// Why the relay closed a connection, as WebSocket close codes in the application range.
pub mod close {
    /// Not `/room/<id>`, or a text frame: the peer is not speaking this protocol.
    pub const BAD_REQUEST: u16 = 4400;
    /// A room that is not there was asked for without `?open` — a wrong code, or everybody has left.
    pub const NO_ROOM: u16 = 4404;
    /// Nothing was heard from the peer for the idle timeout, not even a pong.
    pub const IDLE: u16 = 4408;
    /// The room already has as many peers as the relay allows.
    pub const ROOM_FULL: u16 = 4409;
    /// The peer did not read fast enough and frames meant for it were piling up. Dropping
    /// one of them instead would leave its document quietly behind; reconnecting makes it
    /// ask the others for everything it missed.
    pub const TOO_SLOW: u16 = 4413;
    /// The relay is serving as many rooms as it allows.
    pub const TOO_MANY_ROOMS: u16 = 4429;
}

#[derive(Clone, Debug)]
pub struct Limits {
    /// The largest frame relayed. A whole document travels in one frame when a peer joins,
    /// so this is also the largest file that can be shared.
    pub max_message_bytes: usize,
    pub max_peers_per_room: usize,
    pub max_rooms: usize,
    /// How long a connection may stay silent. The relay pings three times within it and a
    /// browser answers by itself, so only a dead connection ever reaches it.
    pub idle_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_message_bytes: 1024 * 1024, max_peers_per_room: 8, max_rooms: 256, idle_timeout: Duration::from_secs(90) }
    }
}

/// Frames waiting for one peer. A burst of typing is a few dozen; a peer this far behind
/// is not reading at all.
const QUEUE_FRAMES: usize = 512;
/// A connection that has not finished its WebSocket handshake by now is dropped, so idle
/// sockets cannot hold the relay's connection slots.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// One write to a peer. Past it the peer's socket is stuck, and waiting longer would also
/// keep this connection from noticing its own idle timeout.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a connection being closed is given to acknowledge it.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

struct Peer {
    id: u64,
    queue: mpsc::Sender<Bytes>,
}

#[derive(Default)]
struct Rooms {
    rooms: HashMap<String, Vec<Peer>>,
    next_peer: u64,
}

/// What the relay is serving right now. Counts only: there is nothing else to know.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub rooms: usize,
    pub peers: usize,
}

struct Hub {
    limits: Limits,
    state: Mutex<Rooms>,
    /// Bounds the sockets held at once, handshaking ones included.
    connections: Arc<Semaphore>,
}

impl Hub {
    fn new(limits: Limits) -> Arc<Self> {
        let slots = limits.max_rooms.saturating_mul(limits.max_peers_per_room).saturating_add(16);
        Arc::new(Self { limits, state: Mutex::new(Rooms::default()), connections: Arc::new(Semaphore::new(slots.min(Semaphore::MAX_PERMITS))) })
    }

    fn rooms(&self) -> std::sync::MutexGuard<'_, Rooms> {
        // Nothing panics while holding the lock, but a poisoned map is still the map.
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn stats(&self) -> Stats {
        let state = self.rooms();
        Stats { rooms: state.rooms.len(), peers: state.rooms.values().map(Vec::len).sum() }
    }

    /// Puts a peer in `room`, or says with which close code it is turned away.
    fn join(&self, room: &str, open: bool) -> Result<(u64, mpsc::Receiver<Bytes>), u16> {
        let mut state = self.rooms();
        if !state.rooms.contains_key(room) {
            if !open {
                return Err(close::NO_ROOM);
            }
            if state.rooms.len() >= self.limits.max_rooms {
                return Err(close::TOO_MANY_ROOMS);
            }
        }
        if state.rooms.get(room).is_some_and(|peers| peers.len() >= self.limits.max_peers_per_room) {
            return Err(close::ROOM_FULL);
        }
        state.next_peer += 1;
        let id = state.next_peer;
        let (queue, frames) = mpsc::channel(QUEUE_FRAMES);
        state.rooms.entry(room.to_owned()).or_default().push(Peer { id, queue });
        Ok((id, frames))
    }

    fn leave(&self, room: &str, id: u64) {
        let mut state = self.rooms();
        if let Some(peers) = state.rooms.get_mut(room) {
            peers.retain(|peer| peer.id != id);
            if peers.is_empty() {
                state.rooms.remove(room);
            }
        }
    }

    /// Hands `frame` to everyone in `room` but its sender. A peer whose queue is full is
    /// taken out of the room: its connection finds its queue closed and ends itself.
    fn relay(&self, room: &str, from: u64, frame: Bytes) {
        let mut state = self.rooms();
        if let Some(peers) = state.rooms.get_mut(room) {
            peers.retain(|peer| peer.id == from || peer.queue.try_send(frame.clone()).is_ok());
        }
    }
}

/// The room a handshake asked for: `/room/<id>`, with `?open` to create it.
fn parse_target(target: &str) -> Option<(String, bool)> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let id = path.strip_prefix("/room/")?;
    // What the clients derive is 32 hex digits; anything id-like is accepted so the
    // derivation can change without the relay having to.
    let valid = (16..=64).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    let open = query.split('&').any(|part| part == "open" || part.starts_with("open="));
    valid.then(|| (id.to_owned(), open))
}

type Socket = tokio_tungstenite::WebSocketStream<TcpStream>;

/// Says why and then hears the peer out for a moment: a socket dropped right after its
/// close frame can reset the connection under it, and the peer would never read the code.
async fn close_with(mut socket: Socket, code: u16) {
    let frame = CloseFrame { code: CloseCode::from(code), reason: "".into() };
    if matches!(timeout(WRITE_TIMEOUT, socket.close(Some(frame))).await, Ok(Ok(()))) {
        let _ = timeout(CLOSE_WAIT, async { while let Some(Ok(_)) = socket.next().await {} }).await;
    }
}

async fn connection(hub: Arc<Hub>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let limit = hub.limits.max_message_bytes;
    let config = WebSocketConfig::default().max_message_size(Some(limit)).max_frame_size(Some(limit));
    let mut target = String::new();
    let handshake = tokio_tungstenite::accept_hdr_async_with_config(
        stream,
        |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            target = request.uri().path_and_query().map(|value| value.as_str().to_owned()).unwrap_or_default();
            Ok(response)
        },
        Some(config),
    );
    let Ok(Ok(socket)) = timeout(HANDSHAKE_TIMEOUT, handshake).await else { return };

    let Some((room, open)) = parse_target(&target) else { return close_with(socket, close::BAD_REQUEST).await };
    let (id, mut frames) = match hub.join(&room, open) {
        Ok(joined) => joined,
        Err(code) => return close_with(socket, code).await,
    };

    let idle = hub.limits.idle_timeout;
    let mut heard = Instant::now();
    let mut ping = tokio::time::interval(idle / 3);
    ping.tick().await;
    let (mut sink, mut source) = socket.split();
    let reason = loop {
        tokio::select! {
            incoming = source.next() => match incoming {
                Some(Ok(Message::Binary(frame))) => {
                    heard = Instant::now();
                    hub.relay(&room, id, frame);
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => heard = Instant::now(),
                Some(Ok(Message::Text(_))) => break Some(close::BAD_REQUEST),
                // Closed by the peer, cut off, or a frame over the size limit.
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                Some(Ok(_)) => {}
            },
            outgoing = frames.recv() => match outgoing {
                Some(frame) => {
                    if !matches!(timeout(WRITE_TIMEOUT, sink.send(Message::Binary(frame))).await, Ok(Ok(()))) {
                        break None;
                    }
                }
                None => break Some(close::TOO_SLOW),
            },
            _ = ping.tick() => {
                if heard.elapsed() >= idle {
                    break Some(close::IDLE);
                }
                if !matches!(timeout(WRITE_TIMEOUT, sink.send(Message::Ping(Bytes::new()))).await, Ok(Ok(()))) {
                    break None;
                }
            }
        }
    };
    hub.leave(&room, id);
    if let Some(code) = reason {
        if let Ok(socket) = sink.reunite(source) {
            close_with(socket, code).await;
        }
    }
}

async fn accept_loop(hub: Arc<Hub>, listener: TcpListener, shutdown: impl Future<Output = ()>) {
    let mut connections = tokio::task::JoinSet::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            // Only to forget the connections that have ended.
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    // With every slot taken the socket is simply dropped.
                    if let Ok(permit) = hub.connections.clone().try_acquire_owned() {
                        let hub = hub.clone();
                        connections.spawn(async move {
                            connection(hub, stream).await;
                            drop(permit);
                        });
                    }
                }
                // Out of file descriptors, most likely: let some connections end first.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
        }
    }
    // Dropping the set ends every connection with it: the rooms are over.
}

/// Serves `listener` until `shutdown` resolves, then drops every connection.
pub async fn serve(listener: TcpListener, limits: Limits, shutdown: impl Future<Output = ()>) {
    accept_loop(Hub::new(limits), listener, shutdown).await;
}

/// A relay on a thread of its own, for a program that is not otherwise asynchronous: the
/// app opens one for the room a user shares, and the tests use it as the server.
pub struct Server {
    address: SocketAddr,
    hub: Arc<Hub>,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    /// Binds `address` and starts relaying. The port is bound before this returns, so a
    /// taken port is an error here and a client may connect straight away.
    pub fn start(address: SocketAddr, limits: Limits) -> std::io::Result<Self> {
        let listener = std::net::TcpListener::bind(address)?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_io().enable_time().build()?;
        let hub = Hub::new(limits);
        let (stop, stopped) = oneshot::channel::<()>();
        let served = hub.clone();
        let thread = std::thread::Builder::new().name("mild-relay".into()).spawn(move || {
            runtime.block_on(async move {
                let Ok(listener) = TcpListener::from_std(listener) else { return };
                // Stopping and dropping the server both end it: a dropped sender resolves too.
                accept_loop(served, listener, async { let _ = stopped.await; }).await;
            });
        })?;
        Ok(Self { address, hub, stop: Some(stop), thread: Some(thread) })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }

    pub fn stats(&self) -> Stats {
        self.hub.stats()
    }

    /// Ends every room and waits for the thread, so the port is free again when this returns.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_room_is_named_by_the_path_and_opened_by_the_query() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(parse_target(&format!("/room/{id}")), Some((id.to_owned(), false)));
        assert_eq!(parse_target(&format!("/room/{id}?open")), Some((id.to_owned(), true)));
        assert_eq!(parse_target(&format!("/room/{id}?v=1&open=1")), Some((id.to_owned(), true)));
        assert_eq!(parse_target(&format!("/room/{id}?reopen")), Some((id.to_owned(), false)));
    }

    #[test]
    fn anything_that_is_not_a_room_id_is_refused() {
        assert_eq!(parse_target("/"), None);
        assert_eq!(parse_target("/room/"), None);
        assert_eq!(parse_target("/room/short"), None);
        assert_eq!(parse_target("/room/0123456789abcdef/extra"), None);
        assert_eq!(parse_target("/room/0123456789abcde%2F"), None);
        assert_eq!(parse_target(&format!("/room/{}", "a".repeat(65))), None);
        assert_eq!(parse_target("/other/0123456789abcdef"), None);
    }

    #[test]
    fn a_room_exists_only_while_someone_is_in_it() {
        let hub = Hub::new(Limits { max_rooms: 1, max_peers_per_room: 2, ..Limits::default() });
        assert_eq!(hub.join("first-room-000000", false).err(), Some(close::NO_ROOM));
        let (opener, _opener_frames) = hub.join("first-room-000000", true).expect("the room is opened");
        let (joiner, _joiner_frames) = hub.join("first-room-000000", false).expect("and joined");
        assert_eq!(hub.join("first-room-000000", false).err(), Some(close::ROOM_FULL));
        assert_eq!(hub.join("other-room-000000", true).err(), Some(close::TOO_MANY_ROOMS));
        assert_eq!(hub.stats(), Stats { rooms: 1, peers: 2 });

        hub.leave("first-room-000000", opener);
        // Whoever is left keeps the room: it belongs to nobody, the one who opened it included.
        assert_eq!(hub.stats(), Stats { rooms: 1, peers: 1 });
        hub.leave("first-room-000000", joiner);
        assert_eq!(hub.stats(), Stats::default());
        assert_eq!(hub.join("first-room-000000", false).err(), Some(close::NO_ROOM));
    }

    #[test]
    fn a_peer_that_does_not_read_is_dropped_rather_than_skipped() {
        let hub = Hub::new(Limits::default());
        let (sender, _sender_frames) = hub.join("a-room-0000000000", true).expect("open");
        let (_stuck, mut stuck_frames) = hub.join("a-room-0000000000", false).expect("join");
        for _ in 0..QUEUE_FRAMES {
            hub.relay("a-room-0000000000", sender, Bytes::from_static(b"frame"));
        }
        assert_eq!(hub.stats().peers, 2);
        hub.relay("a-room-0000000000", sender, Bytes::from_static(b"one too many"));
        assert_eq!(hub.stats().peers, 1);
        // Everything queued before is still delivered, then the queue ends.
        let mut delivered = 0;
        while stuck_frames.try_recv().is_ok() {
            delivered += 1;
        }
        assert_eq!(delivered, QUEUE_FRAMES);
        assert!(matches!(stuck_frames.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)));
    }
}
