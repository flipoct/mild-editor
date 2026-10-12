//! The relay as its clients see it: real WebSocket connections to a [`Server`] on a free port.

use futures_util::{SinkExt, StreamExt};
use mild_relay::{close, Limits, Server, Stats};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

const ROOM: &str = "00112233445566778899aabbccddeeff";
const OTHER_ROOM: &str = "ffeeddccbbaa99887766554433221100";

fn start(limits: Limits) -> Server {
    // Port 0: the system picks a free one, so a test never meets a running app or another test.
    Server::start(SocketAddr::from(([127, 0, 0, 1], 0)), limits).expect("bind the relay")
}

async fn connect(server: &Server, room: &str, open: bool) -> Client {
    let url = format!("ws://{}/room/{room}{}", server.local_addr(), if open { "?open" } else { "" });
    connect_async(url).await.expect("connect to the relay").0
}

/// The handshake answers before the peer is in its room, so a test that sends next waits for this.
async fn settled(server: &Server, stats: Stats) {
    for _ in 0..200 {
        if server.stats() == stats {
            return;
        }
        sleep(Duration::from_millis(10)).await;
    }
    panic!("the relay holds {:?}, not {stats:?}", server.stats());
}

/// The next binary frame; pings on the way are the relay checking the connection.
async fn frame(client: &mut Client) -> Vec<u8> {
    loop {
        match timeout(Duration::from_secs(5), client.next()).await.expect("a frame in time") {
            Some(Ok(Message::Binary(frame))) => return frame.to_vec(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            other => panic!("expected a binary frame, got {other:?}"),
        }
    }
}

async fn silent(client: &mut Client) {
    let waited = timeout(Duration::from_millis(200), async {
        loop {
            match client.next().await {
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                other => return other,
            }
        }
    })
    .await;
    assert!(waited.is_err(), "expected nothing, got {waited:?}");
}

/// The close code the relay ends this connection with, or `None` when it just went away.
async fn closed(client: &mut Client) -> Option<u16> {
    loop {
        match timeout(Duration::from_secs(5), client.next()).await.expect("the connection to end in time") {
            Some(Ok(Message::Close(frame))) => return frame.map(|frame| u16::from(frame.code)),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Ok(other)) => panic!("expected the connection to close, got {other:?}"),
            Some(Err(_)) | None => return None,
        }
    }
}

async fn send(client: &mut Client, bytes: &'static [u8]) {
    client.send(Message::Binary(Bytes::from_static(bytes))).await.expect("send a frame");
}

#[tokio::test]
async fn peers_of_a_room_get_each_others_frames_and_nobody_elses() {
    let server = start(Limits::default());
    let mut opener = connect(&server, ROOM, true).await;
    let mut joiner = connect(&server, ROOM, false).await;
    let mut third = connect(&server, ROOM, false).await;
    let mut outsider = connect(&server, OTHER_ROOM, true).await;
    settled(&server, Stats { rooms: 2, peers: 4 }).await;

    send(&mut opener, b"from the opener").await;
    assert_eq!(frame(&mut joiner).await, b"from the opener");
    assert_eq!(frame(&mut third).await, b"from the opener");

    send(&mut joiner, b"from a joiner").await;
    assert_eq!(frame(&mut opener).await, b"from a joiner");
    assert_eq!(frame(&mut third).await, b"from a joiner");

    // Bytes are bytes: nothing in a frame is looked at, so anything goes through as it is.
    let opaque: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
    third.send(Message::Binary(opaque.clone().into())).await.expect("send");
    assert_eq!(frame(&mut opener).await, opaque);
    assert_eq!(frame(&mut joiner).await, opaque);

    // Nobody hears its own frame, and the other room heard none of it.
    silent(&mut third).await;
    silent(&mut outsider).await;
    send(&mut outsider, b"elsewhere").await;
    silent(&mut opener).await;
}

#[tokio::test]
async fn frames_keep_their_order() {
    let server = start(Limits::default());
    let mut opener = connect(&server, ROOM, true).await;
    let mut joiner = connect(&server, ROOM, false).await;
    settled(&server, Stats { rooms: 1, peers: 2 }).await;
    for index in 0..300u32 {
        opener.send(Message::Binary(index.to_be_bytes().to_vec().into())).await.expect("send");
    }
    for index in 0..300u32 {
        assert_eq!(frame(&mut joiner).await, index.to_be_bytes());
    }
}

#[tokio::test]
async fn a_room_nobody_opened_cannot_be_joined() {
    let server = start(Limits::default());
    let mut joiner = connect(&server, ROOM, false).await;
    assert_eq!(closed(&mut joiner).await, Some(close::NO_ROOM));
    assert_eq!(server.stats(), Stats::default());
}

#[tokio::test]
async fn a_request_that_is_not_for_a_room_is_refused() {
    let server = start(Limits::default());
    let (mut stray, _) = connect_async(format!("ws://{}/", server.local_addr())).await.expect("connect");
    assert_eq!(closed(&mut stray).await, Some(close::BAD_REQUEST));

    let mut talker = connect(&server, ROOM, true).await;
    let mut listener = connect(&server, ROOM, false).await;
    settled(&server, Stats { rooms: 1, peers: 2 }).await;
    talker.send(Message::Text("hello".into())).await.expect("send");
    assert_eq!(closed(&mut talker).await, Some(close::BAD_REQUEST));
    silent(&mut listener).await;
}

#[tokio::test]
async fn the_limits_on_peers_and_rooms_hold() {
    let server = start(Limits { max_peers_per_room: 2, max_rooms: 1, ..Limits::default() });
    let mut opener = connect(&server, ROOM, true).await;
    let joiner = connect(&server, ROOM, false).await;
    settled(&server, Stats { rooms: 1, peers: 2 }).await;

    let mut late = connect(&server, ROOM, false).await;
    assert_eq!(closed(&mut late).await, Some(close::ROOM_FULL));
    let mut elsewhere = connect(&server, OTHER_ROOM, true).await;
    assert_eq!(closed(&mut elsewhere).await, Some(close::TOO_MANY_ROOMS));

    // Being turned away disturbed nobody, and a place that frees up can be taken.
    assert_eq!(server.stats(), Stats { rooms: 1, peers: 2 });
    drop(joiner);
    settled(&server, Stats { rooms: 1, peers: 1 }).await;
    let mut next = connect(&server, ROOM, false).await;
    settled(&server, Stats { rooms: 1, peers: 2 }).await;
    send(&mut next, b"made it").await;
    assert_eq!(frame(&mut opener).await, b"made it");
}

#[tokio::test]
async fn a_frame_over_the_size_limit_ends_its_sender_and_reaches_nobody() {
    let server = start(Limits { max_message_bytes: 1024, ..Limits::default() });
    let mut opener = connect(&server, ROOM, true).await;
    let mut joiner = connect(&server, ROOM, false).await;
    settled(&server, Stats { rooms: 1, peers: 2 }).await;

    joiner.send(Message::Binary(vec![7u8; 1024].into())).await.expect("send");
    assert_eq!(frame(&mut opener).await.len(), 1024);

    joiner.send(Message::Binary(vec![7u8; 1025].into())).await.expect("send");
    silent(&mut opener).await;
    settled(&server, Stats { rooms: 1, peers: 1 }).await;
    assert_eq!(closed(&mut joiner).await, None);
}

#[tokio::test]
async fn a_connection_that_stops_answering_is_dropped() {
    let server = start(Limits { idle_timeout: Duration::from_millis(600), ..Limits::default() });
    // A client that is never read never answers the relay's pings.
    let mut dead = connect(&server, ROOM, true).await;
    // One that is read answers them without sending anything of its own, and stays.
    let mut alive = connect(&server, ROOM, false).await;
    settled(&server, Stats { rooms: 1, peers: 2 }).await;
    // Five quiet stretches of 200 ms: well past the timeout, with a ping answered in each.
    for _ in 0..5 {
        silent(&mut alive).await;
    }
    settled(&server, Stats { rooms: 1, peers: 1 }).await;
    assert_eq!(closed(&mut dead).await, Some(close::IDLE));
    send(&mut alive, b"still here").await;
    settled(&server, Stats { rooms: 1, peers: 1 }).await;
}

#[tokio::test]
async fn a_room_is_gone_when_its_last_peer_leaves() {
    let server = start(Limits::default());
    let mut opener = connect(&server, ROOM, true).await;
    let joiner = connect(&server, ROOM, false).await;
    settled(&server, Stats { rooms: 1, peers: 2 }).await;

    // The one who opened the room going does not end it for whoever is still in it…
    opener.close(None).await.expect("close");
    settled(&server, Stats { rooms: 1, peers: 1 }).await;
    // …and a dropped connection counts as leaving just as a closed one does.
    drop(joiner);
    settled(&server, Stats::default()).await;

    let mut late = connect(&server, ROOM, false).await;
    assert_eq!(closed(&mut late).await, Some(close::NO_ROOM));
    assert_eq!(server.stats(), Stats::default());
}

#[tokio::test]
async fn stopping_the_server_ends_its_rooms_and_frees_the_port() {
    // Not port 0: a port the system handed out can be handed to someone else the moment it
    // is free, and the second bind below would then fail for a reason that is not stop()'s.
    // Ports under the ephemeral ranges are never given out that way.
    let offset = (std::process::id() % 1000) as u16 * 7;
    let server = (0..200u16)
        .find_map(|step| Server::start(SocketAddr::from(([127, 0, 0, 1], 30_000 + (offset + step) % 10_000)), Limits::default()).ok())
        .expect("bind the relay");
    let address = server.local_addr();
    let mut opener = connect(&server, ROOM, true).await;
    settled(&server, Stats { rooms: 1, peers: 1 }).await;

    // stop() joins the relay's thread; off the test's own thread so its client keeps being polled.
    tokio::task::spawn_blocking(move || server.stop()).await.expect("stop");
    assert_eq!(closed(&mut opener).await, None);
    // Bound again at once: stop() returned only after the listener was closed.
    let again = Server::start(address, Limits::default()).expect("bind the same port again");
    assert_eq!(again.local_addr(), address);
}
