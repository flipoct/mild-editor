//! Competitive Companion bridge.
//!
//! The Competitive Companion browser extension POSTs a problem as JSON to a
//! loopback port. Listening for it turns "open the problem page, click the
//! extension" into a fully populated file with sample tests, which is the
//! workflow competitive programmers already have muscle memory for.
//!
//! The protocol is a single unauthenticated POST, so a hand-rolled reader over
//! `TcpListener` covers it without pulling in an HTTP server dependency.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

/// The port cph listens on, and the one Competitive Companion tries first.
pub const DEFAULT_PORT: u16 = 10043;

const MAX_BODY: usize = 4 * 1024 * 1024;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct CompanionTest {
    pub input: String,
    pub output: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompanionBatch {
    pub id: String,
    pub size: usize,
}

/// The subset of the Competitive Companion payload the editor uses. Unknown
/// fields (`testType`, `input`, `output`, `languages`, …) are ignored.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompanionProblem {
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub tests: Vec<CompanionTest>,
    #[serde(default)]
    pub time_limit: Option<u64>,
    #[serde(default)]
    pub memory_limit: Option<u64>,
    #[serde(default)]
    pub batch: Option<CompanionBatch>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub listening: bool,
    pub port: Option<u16>,
}

struct Listener {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
}

/// How long the accept loop may sleep before it notices [`stop`]. It is also the
/// worst case `stop` blocks for, so keep it short enough to rebind immediately after.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Default)]
pub struct CompanionState(Mutex<Option<Listener>>);

pub struct ParsedRequest {
    pub method: String,
    pub body: String,
}

/// Reads one HTTP request: the request line, headers up to the blank line, and
/// exactly `Content-Length` body bytes. Returns `None` on an empty stream.
pub fn parse_request<R: BufRead>(reader: &mut R) -> std::io::Result<Option<ParsedRequest>> {
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(None);
    }
    let method = request_line
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();

    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let header = header.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }

    let mut body = vec![0u8; length.min(MAX_BODY)];
    if !body.is_empty() {
        reader.read_exact(&mut body)?;
    }
    Ok(Some(ParsedRequest {
        method,
        body: String::from_utf8_lossy(&body).into_owned(),
    }))
}

fn respond(stream: &mut TcpStream, status: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: content-type\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\r\n"
    );
    let _ = stream.flush();
}

fn handle(deliver: &dyn Fn(CompanionProblem), mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let peer = match stream.try_clone() {
        Ok(peer) => peer,
        Err(_) => return,
    };
    let mut reader = BufReader::new(peer);
    let request = match parse_request(&mut reader) {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(_) => {
            respond(&mut stream, "400 Bad Request");
            return;
        }
    };

    match request.method.as_str() {
        "OPTIONS" => respond(&mut stream, "204 No Content"),
        "POST" => match serde_json::from_str::<CompanionProblem>(&request.body) {
            Ok(problem) => {
                deliver(problem);
                respond(&mut stream, "200 OK");
            }
            Err(_) => respond(&mut stream, "400 Bad Request"),
        },
        _ => respond(&mut stream, "405 Method Not Allowed"),
    }
}

/// Binds the loopback port and hands every parsed problem to `deliver` until [`stop`]
/// is called. Restarts cleanly if a listener is already running.
pub fn start<F>(state: &CompanionState, port: u16, deliver: F) -> Result<u16, String>
where
    F: Fn(CompanionProblem) + Send + 'static,
{
    {
        let guard = state.0.lock().map_err(|_| "Could not lock the listener state.")?;
        // Already serving the requested port: re-binding would only race with ourselves.
        if let Some(listener) = guard.as_ref() {
            if listener.port == port {
                return Ok(listener.port);
            }
        }
    }
    stop(state);

    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("Could not listen on port {port}: {error}"))?;
    let port = listener.local_addr().map(|address| address.port()).unwrap_or(port);
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_flag = stop_flag.clone();
    let thread = thread::spawn(move || {
        while !thread_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    handle(&deliver, stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(POLL_INTERVAL)
                }
                Err(_) => break,
            }
        }
    });

    let mut guard = state.0.lock().map_err(|_| "Could not lock the listener state.")?;
    *guard = Some(Listener { port, stop: stop_flag, thread });
    Ok(port)
}

/// Signals the accept loop and waits for it to exit, so the socket is released
/// before the caller tries to bind the same port again.
pub fn stop(state: &CompanionState) {
    let listener = state.0.lock().ok().and_then(|mut guard| guard.take());
    if let Some(listener) = listener {
        listener.stop.store(true, Ordering::Relaxed);
        let _ = listener.thread.join();
    }
}

pub fn status(state: &CompanionState) -> CompanionStatus {
    let port = state
        .0
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|listener| listener.port));
    CompanionStatus { listening: port.is_some(), port }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_a_post_with_a_json_body() {
        let raw = "POST / HTTP/1.1\r\nHost: localhost:10043\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
        let mut reader = Cursor::new(raw.as_bytes());
        let request = parse_request(&mut reader).expect("read request").expect("a request");
        assert_eq!(request.method, "POST");
        assert_eq!(request.body, "{\"a\":1}");
    }

    #[test]
    fn parses_a_preflight_without_a_body() {
        let raw = "OPTIONS / HTTP/1.1\r\nOrigin: https://codeforces.com\r\n\r\n";
        let mut reader = Cursor::new(raw.as_bytes());
        let request = parse_request(&mut reader).expect("read request").expect("a request");
        assert_eq!(request.method, "OPTIONS");
        assert!(request.body.is_empty());
    }

    #[test]
    fn deserializes_a_competitive_companion_payload() {
        let payload = r#"{
            "name": "A. Theatre Square",
            "group": "Codeforces - Codeforces Beta Round 1",
            "url": "https://codeforces.com/contest/1/problem/A",
            "interactive": false,
            "memoryLimit": 256,
            "timeLimit": 1000,
            "tests": [{ "input": "6 6 4\n", "output": "4\n" }],
            "testType": "single",
            "input": { "type": "stdin" },
            "output": { "type": "stdout" },
            "languages": { "java": { "mainClass": "Main", "taskClass": "TheatreSquare" } },
            "batch": { "id": "5f7c0d02", "size": 5 }
        }"#;
        let problem: CompanionProblem = serde_json::from_str(payload).expect("parse payload");
        assert_eq!(problem.name, "A. Theatre Square");
        assert_eq!(problem.url, "https://codeforces.com/contest/1/problem/A");
        assert_eq!(problem.time_limit, Some(1000));
        assert_eq!(problem.tests.len(), 1);
        assert_eq!(problem.tests[0].input, "6 6 4\n");
        assert_eq!(problem.tests[0].output, "4\n");
        let batch = problem.batch.expect("batch metadata");
        assert_eq!(batch.id, "5f7c0d02");
        assert_eq!(batch.size, 5);
    }

    #[test]
    fn serves_a_real_post_and_delivers_the_problem() {
        use std::io::Read;
        use std::net::TcpStream;
        use std::sync::mpsc;

        let state = CompanionState::default();
        let (sender, receiver) = mpsc::channel();
        // Port 0 lets the OS pick a free one so the test never collides with a running app.
        let port = start(&state, 0, move |problem| { let _ = sender.send(problem); }).expect("bind listener");
        assert_eq!(status(&state).port, Some(port));

        let body = r#"{"name":"B. Sum","url":"https://codeforces.com/contest/2/problem/B","tests":[{"input":"1 2\n","output":"3\n"}]}"#;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        write!(
            stream,
            "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .expect("send request");
        stream.flush().expect("flush request");

        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        assert!(response.starts_with("HTTP/1.1 200 OK"), "unexpected response: {response}");

        let problem = receiver.recv_timeout(Duration::from_secs(5)).expect("delivered problem");
        assert_eq!(problem.name, "B. Sum");
        assert_eq!(problem.tests[0].input, "1 2\n");

        stop(&state);
        assert!(!status(&state).listening);
    }

    #[test]
    fn restarting_on_the_same_port_keeps_one_listener() {
        let state = CompanionState::default();
        let first = start(&state, 0, |_| {}).expect("bind listener");
        // The React effect runs twice on mount, so a second start must not fail to rebind.
        let second = start(&state, first, |_| {}).expect("restart listener");
        assert_eq!(first, second);
        assert!(status(&state).listening);

        stop(&state);
        // stop() joined the accept thread, so the port is free again straight away.
        let rebound = start(&state, first, |_| {}).expect("rebind after stop");
        assert_eq!(rebound, first);
        stop(&state);
    }

    #[test]
    fn deserializes_a_payload_without_optional_fields() {
        let problem: CompanionProblem =
            serde_json::from_str(r#"{ "name": "1000", "url": "https://doj.kr/ko/problems/1000" }"#)
                .expect("parse minimal payload");
        assert!(problem.tests.is_empty());
        assert!(problem.batch.is_none());
        assert!(problem.group.is_none());
    }
}
