//! Opening a shared room on this computer.
//!
//! Sharing a file with teammates goes through a relay (the `mild-relay` crate): a
//! WebSocket server that forwards encrypted frames between the peers of a room and knows
//! nothing else. "Open to LAN" starts that relay inside the app, for as long as the room
//! is open; the app's own window then connects to it like every other member does, so a
//! room here and a room on a relay on a server are the same thing to the frontend
//! (src/collab) — except that this one ends when its opener leaves, since the relay goes
//! with them. Nothing listens until a room is opened, and closing it frees the port.
//!
//! The join code never comes here: the frontend makes it, and derives the room id and the
//! key from it.

use mild_relay::{Limits, Server};
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::Mutex;

pub use mild_relay::DEFAULT_PORT;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub open: bool,
    pub port: Option<u16>,
    /// The addresses of this computer a teammate on the same network can type, the one
    /// the default route uses first. Empty while closed.
    pub addresses: Vec<String>,
}

#[derive(Default)]
pub struct CollabState(Mutex<Option<Server>>);

/// The relay inside the app serves the one room its user opened, not the network.
fn limits() -> Limits {
    Limits { max_rooms: 1, ..Limits::default() }
}

/// Starts the relay on every IPv4 interface. Asking again for the port it is already on
/// keeps it — and the room on it — as it is.
pub fn open(state: &CollabState, port: u16) -> Result<u16, String> {
    let mut guard = state.0.lock().map_err(|_| "Could not lock the room state.")?;
    if let Some(server) = guard.as_ref() {
        if port == server.local_addr().port() {
            return Ok(port);
        }
    }
    // Stopped before the new one binds; stopping waits for the old listener to be gone.
    if let Some(server) = guard.take() {
        server.stop();
    }
    let server = Server::start(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)), limits())
        .map_err(|error| format!("Could not listen on port {port}: {error}"))?;
    let port = server.local_addr().port();
    *guard = Some(server);
    Ok(port)
}

/// Ends the room for everyone connected and frees the port before returning.
pub fn close(state: &CollabState) {
    let server = state.0.lock().ok().and_then(|mut guard| guard.take());
    if let Some(server) = server {
        server.stop();
    }
}

pub fn status(state: &CollabState) -> RelayStatus {
    let port = state.0.lock().ok().and_then(|guard| guard.as_ref().map(|server| server.local_addr().port()));
    RelayStatus { open: port.is_some(), port, addresses: if port.is_some() { lan_addresses() } else { Vec::new() } }
}

/// The IPv4 addresses other computers can reach this one at.
///
/// Found without a dependency for listing interfaces: connecting a UDP socket sends
/// nothing, but makes the system choose the interface it would route through, and that
/// interface's address is the socket's own. The public target finds the default route;
/// the others find a second network the default route does not cover — another LAN, or a
/// virtual one (Tailscale and Hamachi hand out 100.64/10 and 25/8), which is how friends
/// in different places usually "play on LAN".
fn lan_addresses() -> Vec<String> {
    const PROBES: [[u8; 4]; 6] = [[8, 8, 8, 8], [192, 168, 255, 254], [10, 255, 255, 254], [172, 31, 255, 254], [100, 127, 255, 254], [25, 255, 255, 254]];
    let routed = PROBES.iter().filter_map(|target| {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        socket.connect((Ipv4Addr::from(*target), 9)).ok()?;
        socket.local_addr().ok().map(|address| address.ip())
    });
    // Windows resolves the computer's own name to every adapter's address, which also
    // covers a network none of the probes happens to route to.
    let named = std::env::var("COMPUTERNAME").ok().filter(|_| cfg!(windows))
        .and_then(|name| (name.as_str(), 0).to_socket_addrs().ok())
        .into_iter().flatten().map(|address| address.ip());
    let mut addresses: Vec<String> = Vec::new();
    for address in routed.chain(named) {
        let IpAddr::V4(v4) = address else { continue };
        if v4.is_loopback() || v4.is_unspecified() || v4.is_link_local() {
            continue;
        }
        let text = v4.to_string();
        if !addresses.contains(&text) {
            addresses.push(text);
        }
    }
    addresses
}

#[tauri::command]
pub fn collab_open_relay(state: tauri::State<'_, CollabState>, port: Option<u16>) -> Result<RelayStatus, String> {
    open(&state, port.unwrap_or(DEFAULT_PORT))?;
    Ok(status(&state))
}

#[tauri::command]
pub fn collab_close_relay(state: tauri::State<'_, CollabState>) -> RelayStatus {
    close(&state);
    status(&state)
}

#[tauri::command]
pub fn collab_relay_status(state: tauri::State<'_, CollabState>) -> RelayStatus {
    status(&state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    #[test]
    fn nothing_listens_until_a_room_is_opened() {
        let state = CollabState::default();
        let closed = status(&state);
        assert!(!closed.open);
        assert_eq!(closed.port, None);
        assert!(closed.addresses.is_empty());

        // Port 0 lets the OS pick a free one so the test never collides with a running app.
        let port = open(&state, 0).expect("open the relay");
        let opened = status(&state);
        assert!(opened.open);
        assert_eq!(opened.port, Some(port));
        TcpStream::connect(("127.0.0.1", port)).expect("the relay accepts connections");

        close(&state);
        assert!(!status(&state).open);
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err(), "the port is closed with the room");
    }

    #[test]
    fn opening_again_on_the_same_port_keeps_the_room() {
        let state = CollabState::default();
        let port = open(&state, 0).expect("open the relay");
        // The dialog asks again when it is reopened; the relay must not be restarted under a room.
        assert_eq!(open(&state, port).expect("open again"), port);
        // Another port moves it, and the old one is free at once.
        let moved = open(&state, 0).expect("open elsewhere");
        assert_ne!(moved, port);
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
        close(&state);
    }

    #[test]
    fn a_taken_port_is_reported() {
        let taken = std::net::TcpListener::bind(("0.0.0.0", 0)).expect("bind");
        let port = taken.local_addr().expect("address").port();
        let state = CollabState::default();
        let error = open(&state, port).expect_err("the port is in use");
        assert!(error.contains(&port.to_string()), "unexpected message: {error}");
        assert!(!status(&state).open);
    }

    #[test]
    fn the_addresses_offered_are_ones_another_computer_could_use() {
        let addresses = lan_addresses();
        for address in &addresses {
            let parsed: Ipv4Addr = address.parse().expect("an IPv4 address");
            assert!(!parsed.is_loopback() && !parsed.is_unspecified() && !parsed.is_link_local(), "{address}");
        }
        let mut unique = addresses.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), addresses.len());
    }
}
