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
//! A teammate somewhere else reaches this computer only if the router lets them in, so
//! while the room is open the router is asked (UPnP) to forward the port here, the way
//! games that host on the player's own machine do. The forward is taken back with the room.
//! Where the router will not, or the network has no public address of its own, the room is
//! simply one for the local network — or a VPN the team shares — as before.
//!
//! The join code never comes here: the frontend makes it, and derives the room id and the
//! key from it.

use igd_next::{AddPortError, Gateway, PortMappingProtocol, SearchOptions};
use mild_relay::{Limits, Server};
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::Mutex;
use std::time::Duration;

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

/// A port the router forwards to the relay, to be given back when the room closes.
struct Forward {
    gateway: Gateway,
    external_port: u16,
    /// The relay's port the forward leads to; a relay moved elsewhere needs a new one.
    internal_port: u16,
    /// What a teammate outside types: the router's public address and the forwarded port.
    address: String,
}

#[derive(Default)]
pub struct CollabState {
    server: Mutex<Option<Server>>,
    forward: Mutex<Option<Forward>>,
}

/// The relay inside the app serves the one room its user opened, not the network.
fn limits() -> Limits {
    Limits { max_rooms: 1, ..Limits::default() }
}

/// Starts the relay on every IPv4 interface. Asking again for the port it is already on
/// keeps it — and the room on it — as it is.
pub fn open(state: &CollabState, port: u16) -> Result<u16, String> {
    let mut guard = state.server.lock().map_err(|_| "Could not lock the room state.")?;
    if let Some(server) = guard.as_ref() {
        if port == server.local_addr().port() {
            return Ok(port);
        }
    }
    // Stopped before the new one binds; stopping waits for the old listener to be gone.
    if let Some(server) = guard.take() {
        server.stop();
        unforward(state);
    }
    let server = Server::start(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)), limits())
        .map_err(|error| format!("Could not listen on port {port}: {error}"))?;
    let port = server.local_addr().port();
    *guard = Some(server);
    Ok(port)
}

/// Ends the room for everyone connected and frees the port before returning.
pub fn close(state: &CollabState) {
    let server = state.server.lock().ok().and_then(|mut guard| guard.take());
    if let Some(server) = server {
        server.stop();
    }
    unforward(state);
}

fn relay_port(state: &CollabState) -> Option<u16> {
    state.server.lock().ok().and_then(|guard| guard.as_ref().map(|server| server.local_addr().port()))
}

pub fn status(state: &CollabState) -> RelayStatus {
    let port = relay_port(state);
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

// ── Letting teammates elsewhere in ──

/// How long the router keeps the forward if the app never takes it back (a crash, a power
/// cut): longer than any contest, short enough not to be found there next week.
const LEASE_SECONDS: u32 = 12 * 60 * 60;
const FORWARD_NAME: &str = "mild editor shared room";

/// Whether `address` is one the internet routes to. A router whose "external" address is
/// not — a second router in front of it, or the provider's shared NAT (100.64/10) — can
/// forward all it likes; nobody outside will arrive.
fn is_public(address: Ipv4Addr) -> bool {
    let [a, b, ..] = address.octets();
    !(address.is_private() || address.is_loopback() || address.is_link_local() || address.is_unspecified()
        || address.is_broadcast() || address.is_documentation() || address.is_multicast()
        || (a == 100 && (b & 0xC0) == 64) || a == 0 || a >= 240)
}

/// Asks the router to forward the relay's port to this computer, and returns the address a
/// teammate outside the network connects to. An error is one of a few words the frontend
/// has a sentence for: `closed` (no room is open), `no-gateway` (no router answered),
/// `nat` (it has no public address) or `refused`.
///
/// Blocks for as long as the router takes to answer — up to a few seconds when there is
/// none — so it is run off the main thread, after the room is already open.
pub fn forward(state: &CollabState) -> Result<String, &'static str> {
    let port = relay_port(state).ok_or("closed")?;
    let known = state.forward.lock().ok().and_then(|guard| guard.as_ref().filter(|known| known.internal_port == port).map(|known| known.address.clone()));
    if let Some(address) = known {
        return Ok(address);
    }
    unforward(state);
    let mut search = SearchOptions::default();
    search.timeout = Some(Duration::from_secs(3));
    let gateway = igd_next::search_gateway(search).map_err(|_| "no-gateway")?;
    let external = match gateway.get_external_ip() {
        Ok(IpAddr::V4(address)) if is_public(address) => address,
        Ok(_) => return Err("nat"),
        Err(_) => return Err("refused"),
    };
    // The address of this computer on the router's network: the one a socket towards the
    // router is given.
    let local = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).and_then(|socket| { socket.connect(gateway.addr)?; socket.local_addr() }).map_err(|_| "refused")?;
    let local = SocketAddr::new(local.ip(), port);
    let add = |external_port: u16, lease: u32| gateway.add_port(PortMappingProtocol::TCP, external_port, local, lease, FORWARD_NAME);
    let external_port = match add(port, LEASE_SECONDS) {
        Ok(()) => port,
        // Some routers only keep forwards until they are told to drop them.
        Err(AddPortError::OnlyPermanentLeasesSupported) => add(port, 0).map(|()| port).map_err(|_| "refused")?,
        // Another computer behind this router has the same port: any other one will do,
        // since the invitation carries it.
        Err(AddPortError::PortInUse) => gateway.add_any_port(PortMappingProtocol::TCP, local, LEASE_SECONDS, FORWARD_NAME).map_err(|_| "refused")?,
        Err(_) => return Err("refused"),
    };
    let address = format!("{external}:{external_port}");
    let made = Forward { gateway, external_port, internal_port: port, address: address.clone() };
    // The room may have been closed while the router was thinking.
    if relay_port(state) != Some(port) {
        drop_forward(made);
        return Err("closed");
    }
    match state.forward.lock() {
        Ok(mut guard) => *guard = Some(made),
        Err(_) => {
            drop_forward(made);
            return Err("refused");
        }
    }
    Ok(address)
}

/// Gives the forwarded port back. Waits for the router only briefly: this also runs while
/// the window is closing, and a router that has gone quiet must not hold that up — the
/// lease ends the forward by itself then.
fn drop_forward(forward: Forward) {
    let (done, wait) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = forward.gateway.remove_port(PortMappingProtocol::TCP, forward.external_port);
        let _ = done.send(());
    });
    let _ = wait.recv_timeout(Duration::from_secs(2));
}

fn unforward(state: &CollabState) {
    let forward = state.forward.lock().ok().and_then(|mut guard| guard.take());
    if let Some(forward) = forward {
        drop_forward(forward);
    }
}

#[tauri::command]
pub async fn collab_forward_port(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || forward(&app.state::<CollabState>()).map_err(str::to_string))
        .await.map_err(|error| error.to_string())?
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
    fn only_an_address_the_internet_routes_to_is_worth_forwarding_from() {
        for public in ["211.36.140.7", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.32.0.1"] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
        // A router behind another router, or behind the provider's shared NAT.
        for inside in ["192.168.0.1", "10.4.2.1", "172.16.0.1", "172.31.255.254", "100.64.0.1", "100.127.255.254", "169.254.1.1", "127.0.0.1", "0.0.0.0", "255.255.255.255", "240.0.0.1", "224.0.0.251"] {
            assert!(!is_public(inside.parse().unwrap()), "{inside}");
        }
    }

    #[test]
    fn without_a_room_nothing_is_asked_of_the_router() {
        assert_eq!(forward(&CollabState::default()), Err("closed"));
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
