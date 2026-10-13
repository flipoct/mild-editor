//! `mild-relay`: the relay of the shared rooms as a program for a server.
//!
//! For teammates who cannot reach each other's computers directly. Both connect to this
//! one instead — one of them opens the room "through a relay" and the others join with the
//! same address and the join code. It keeps nothing and can read nothing: see the library.
//!
//! It speaks plain `ws://`. For `wss://`, put it behind a reverse proxy that terminates
//! TLS and forwards WebSocket upgrades (Caddy: `reverse_proxy 127.0.0.1:10044`).

use mild_relay::{serve, Limits, DEFAULT_PORT};
use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Duration;

const USAGE: &str = "\
mild-relay — relay for Mild Editor's shared rooms

usage: mild-relay [options]
  --bind <address>        address to listen on            [0.0.0.0:10044]
  --port <port>           the port alone, on every IPv4 interface
  --max-rooms <n>         rooms served at once            [256]
  --max-peers <n>         peers in one room               [8]
  --max-message <bytes>   largest frame relayed           [1048576]
  --idle <seconds>        silence before a peer is dropped [90]
  -h, --help

Nothing is stored and nothing is logged about rooms or their traffic.";

struct Options {
    bind: SocketAddr,
    limits: Limits,
}

fn parse(arguments: impl Iterator<Item = String>) -> Result<Option<Options>, String> {
    let mut options = Options { bind: SocketAddr::from(([0, 0, 0, 0], DEFAULT_PORT)), limits: Limits::default() };
    let mut arguments = arguments;
    while let Some(flag) = arguments.next() {
        if flag == "-h" || flag == "--help" {
            return Ok(None);
        }
        let value = arguments.next().ok_or_else(|| format!("{flag} needs a value"))?;
        let number = || value.parse::<usize>().ok().filter(|&number| number > 0).ok_or_else(|| format!("{flag}: {value} is not a positive number"));
        match flag.as_str() {
            "--bind" => options.bind = value.parse().map_err(|_| format!("--bind: {value} is not an address like 0.0.0.0:{DEFAULT_PORT}"))?,
            "--port" => options.bind = SocketAddr::from(([0, 0, 0, 0], value.parse::<u16>().map_err(|_| format!("--port: {value} is not a port"))?)),
            "--max-rooms" => options.limits.max_rooms = number()?,
            "--max-peers" => options.limits.max_peers_per_room = number()?,
            "--max-message" => options.limits.max_message_bytes = number()?,
            "--idle" => options.limits.idle_timeout = Duration::from_secs(number()? as u64),
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    Ok(Some(options))
}

fn main() -> ExitCode {
    let options = match parse(std::env::args().skip(1)) {
        Ok(Some(options)) => options,
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("mild-relay: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_io().enable_time().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("mild-relay: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(async {
        let listener = match tokio::net::TcpListener::bind(options.bind).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("mild-relay: could not listen on {}: {error}", options.bind);
                return ExitCode::FAILURE;
            }
        };
        let address = listener.local_addr().unwrap_or(options.bind);
        println!("mild-relay listening on ws://{address}");
        // Until the process is told to end; there is no state to put away first.
        serve(listener, options.limits, std::future::pending()).await;
        ExitCode::SUCCESS
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(arguments: &[&str]) -> Result<Option<Options>, String> {
        parse(arguments.iter().map(|argument| argument.to_string()))
    }

    #[test]
    fn the_defaults_listen_on_the_rooms_port_everywhere() {
        let options = options(&[]).expect("parse").expect("options");
        assert_eq!(options.bind.to_string(), format!("0.0.0.0:{DEFAULT_PORT}"));
        assert_eq!(options.limits.max_peers_per_room, Limits::default().max_peers_per_room);
    }

    #[test]
    fn options_replace_the_defaults() {
        let options = options(&["--bind", "127.0.0.1:9000", "--max-rooms", "4", "--idle", "30"]).expect("parse").expect("options");
        assert_eq!(options.bind.to_string(), "127.0.0.1:9000");
        assert_eq!(options.limits.max_rooms, 4);
        assert_eq!(options.limits.idle_timeout, Duration::from_secs(30));
    }

    #[test]
    fn a_bad_option_is_an_error_and_help_is_not() {
        assert!(options(&["--max-rooms", "0"]).is_err());
        assert!(options(&["--port"]).is_err());
        assert!(options(&["--nope", "1"]).is_err());
        assert!(options(&["--help"]).expect("parse").is_none());
    }
}
