//! Embedded Chromium "problem panel".
//!
//! The panel is a real Chromium browser (CEF) hosted as a native child view inside the
//! Tauri window, so Chrome extensions such as Competitive Companion, Carrot and AtCoder
//! Better run against the problem page. The frontend owns the panel's rectangle and
//! reports it here; this module positions the native view over that rectangle.
//!
//! Threading: every CEF call happens on the main thread. Commands arrive on Tauri's
//! worker pool and hop over with `run_on_main_thread`. CEF's own message loop is pumped
//! from the main thread through `external_message_pump` plus a 60 Hz fallback timer, the
//! same scheme cefclient uses when the host application owns the run loop.

use cef::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Window};

/// Event carrying [`PanelStatus`] whenever the browser's title, URL or loading state changes.
pub const STATUS_EVENT: &str = "browser-status";

static INITIALIZED: AtomicBool = AtomicBool::new(false);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
/// Guards against re-entering `do_message_loop_work` from inside itself.
static PUMPING: AtomicBool = AtomicBool::new(false);
/// Why the one allowed CEF initialisation failed, if it did.
static INIT_FAILURE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
/// Delays (ms) requested by CEF's `OnScheduleMessagePumpWork`, consumed by the pump thread.
static PUMP_REQUESTS: std::sync::OnceLock<std::sync::mpsc::Sender<i64>> = std::sync::OnceLock::new();

/// Panel rectangle in CSS pixels of the app webview, plus the webview zoom so the
/// native view can be sized in device-independent points.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_scale")]
    pub scale: f64,
}

fn default_scale() -> f64 {
    1.0
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelStatus {
    /// CEF initialised; false with `error` set when the framework is missing or broken.
    pub available: bool,
    pub error: Option<String>,
    /// A browser exists (it may be hidden).
    pub open: bool,
    pub visible: bool,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[derive(Default)]
pub struct Shared {
    status: Mutex<PanelStatus>,
    browser: Mutex<Option<Browser>>,
    /// Applied when the browser finishes creating, which happens asynchronously.
    pending_bounds: Mutex<Option<PanelBounds>>,
    /// `<app data>/cef/extensions`, set once CEF has started.
    extensions_dir: Mutex<Option<PathBuf>>,
    /// Extension ids CEF was started with; anything else on disk is waiting for a restart.
    loaded_extensions: Mutex<std::collections::HashSet<String>>,
}

/// Tauri-managed handle to the panel.
#[derive(Clone, Default)]
pub struct BrowserState(pub Arc<Shared>);

impl Shared {
    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut PanelStatus)) {
        let snapshot = {
            let mut status = self.status.lock().expect("panel status");
            change(&mut status);
            status.clone()
        };
        let _ = app.emit(STATUS_EVENT, snapshot);
    }
}

// ---------------------------------------------------------------------------------------
// Layout: where the framework, helper and profile live.

struct Layout {
    #[cfg(target_os = "macos")]
    framework_dir: PathBuf,
    #[cfg(target_os = "macos")]
    helper: PathBuf,
    /// Stub bundle used by `tauri dev`, where the executable is bare. Chromium derives
    /// the Mach rendezvous name the helpers look for from the main bundle identifier, so
    /// without one the helpers cannot attach. Empty inside a real app bundle.
    #[cfg(target_os = "macos")]
    main_bundle: Option<PathBuf>,
    cache_dir: PathBuf,
    /// Unpacked extension directories, handed to Chromium as `--load-extension`.
    extensions: Vec<PathBuf>,
    /// DevTools protocol port; 0 keeps it closed. Set `MILD_CEF_DEBUG_PORT` to open it.
    debug_port: u16,
}

fn resolve_layout(app: &AppHandle) -> Result<Layout, String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("cef");
    std::fs::create_dir_all(&cache_dir).map_err(|error| format!("Could not create {}: {error}", cache_dir.display()))?;

    // Extensions installed through the app live under the profile; MILD_CEF_EXTENSIONS adds
    // unpacked directories for development.
    let mut extensions = Vec::new();
    if let Ok(entries) = std::fs::read_dir(cache_dir.join("extensions")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.join("manifest.json").is_file() {
                extensions.push(path);
            }
        }
    }
    if let Ok(extra) = std::env::var("MILD_CEF_EXTENSIONS") {
        extensions.extend(extra.split(',').filter(|item| !item.trim().is_empty()).map(PathBuf::from));
    }
    let debug_port = std::env::var("MILD_CEF_DEBUG_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(0);

    #[cfg(target_os = "macos")]
    {
        // The framework and helper bundles sit in "../Frameworks" relative to the
        // executable: Contents/Frameworks inside the app bundle, and
        // src-tauri/target/Frameworks for `tauri dev` (see scripts/prepare-cef.sh).
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let default_dir = exe.parent().map(|dir| dir.join("../Frameworks")).ok_or("executable has no parent directory")?;
        let framework_dir = std::env::var_os("MILD_CEF_DIR").map(PathBuf::from).unwrap_or(default_dir);
        let framework_dir = framework_dir.canonicalize().unwrap_or(framework_dir);
        let framework = framework_dir.join("Chromium Embedded Framework.framework/Chromium Embedded Framework");
        if !framework.is_file() {
            return Err(format!("CEF framework not found at {}", framework.display()));
        }
        // `tauri dev` puts the helpers next to the framework; the app bundle ships them as
        // resources under Contents/Resources/cef/helpers (the bundler only accepts
        // .framework and .dylib entries under Frameworks).
        const HELPER: &str = "Mild Editor Helper.app/Contents/MacOS/Mild Editor Helper";
        let resources_dir = exe.parent().map(|dir| dir.join("../Resources/cef/helpers")).ok_or("executable has no parent directory")?;
        let helper = [framework_dir.join(HELPER), resources_dir.join(HELPER)]
            .into_iter()
            .find(|path| path.is_file())
            .ok_or_else(|| format!("CEF helper not found under {} or {}", framework_dir.display(), resources_dir.display()))?;
        let inside_bundle = exe.ancestors().any(|dir| dir.extension().map(|ext| ext == "app").unwrap_or(false));
        let stub = framework_dir.join("Mild Editor.app");
        let main_bundle = (!inside_bundle && stub.join("Contents/Info.plist").is_file()).then_some(stub);
        Ok(Layout { framework_dir, helper, main_bundle, cache_dir, extensions, debug_port })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Layout { cache_dir, extensions, debug_port })
    }
}

// ---------------------------------------------------------------------------------------
// Process bootstrap.

/// On Windows and Linux CEF re-launches this same executable for its sub-processes,
/// flagged with `--type=`. Such a launch must run CEF and exit before any editor code.
/// macOS uses the separate helper binary instead, so this is a no-op there.
pub fn exit_if_subprocess() {
    #[cfg(not(target_os = "macos"))]
    {
        if !std::env::args().any(|argument| argument.starts_with("--type=")) {
            return;
        }
        let args = args::Args::new();
        let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
        let code = execute_process(Some(args.as_main_args()), None::<&mut App>, std::ptr::null_mut());
        std::process::exit(code);
    }
}

/// Called at start-up. Only checks that CEF is present and records where the profile
/// lives; Chromium itself is not started until the panel is first opened, so an editor
/// session that never touches the panel pays nothing for it.
pub fn prepare(app: &AppHandle) {
    let state = app.state::<BrowserState>();
    let shared = state.0.clone();
    match resolve_layout(app) {
        Ok(layout) => {
            *shared.extensions_dir.lock().expect("extensions dir") = Some(layout.cache_dir.join("extensions"));
            shared.update(app, |status| {
                status.available = true;
                status.error = None;
            });
        }
        Err(error) => {
            eprintln!("[browser] CEF unavailable: {error}");
            shared.update(app, |status| {
                status.available = false;
                status.error = Some(error);
            });
        }
    }
}

/// Start Chromium if it is not running yet. Main thread only; CEF can be initialised
/// once per process, so a failure is remembered and reported on every later attempt.
fn ensure_initialized(app: &AppHandle, shared: &Arc<Shared>) -> Result<(), String> {
    if INITIALIZED.load(Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(error) = INIT_FAILURE.get() {
        return Err(error.clone());
    }
    match try_initialize(app, shared) {
        Ok(()) => Ok(()),
        Err(error) => {
            eprintln!("[browser] CEF failed to start: {error}");
            let _ = INIT_FAILURE.set(error.clone());
            shared.update(app, |status| {
                status.available = false;
                status.error = Some(error.clone());
            });
            Err(error)
        }
    }
}

/// Chromium marks a profile in use with a `SingletonLock` symlink pointing at
/// `<host>-<pid>`. After a relaunch the previous process may still be shutting down, and
/// starting CEF against its profile would make Chromium defer to it; wait for it briefly.
fn wait_for_profile_lock(cache_dir: &std::path::Path) {
    let lock = cache_dir.join("SingletonLock");
    for _ in 0..20 {
        let Some(pid) = std::fs::read_link(&lock).ok().and_then(|target| target.to_string_lossy().rsplit('-').next()?.parse::<u32>().ok()) else { return };
        if pid == std::process::id() {
            return;
        }
        let alive = std::process::Command::new("kill").args(["-0", &pid.to_string()]).output().map(|out| out.status.success()).unwrap_or(false);
        if !alive {
            let _ = std::fs::remove_file(&lock);
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn try_initialize(app: &AppHandle, shared: &Arc<Shared>) -> Result<(), String> {
    let layout = resolve_layout(app)?;
    *shared.extensions_dir.lock().expect("extensions dir") = Some(layout.cache_dir.join("extensions"));
    *shared.loaded_extensions.lock().expect("loaded extensions") = layout
        .extensions
        .iter()
        .filter_map(|path| path.file_name().map(|name| name.to_string_lossy().into_owned()))
        .collect();
    wait_for_profile_lock(&layout.cache_dir);

    #[cfg(target_os = "macos")]
    {
        let framework = layout.framework_dir.join("Chromium Embedded Framework.framework/Chromium Embedded Framework");
        let path = std::ffi::CString::new(framework.to_string_lossy().as_bytes()).map_err(|error| error.to_string())?;
        if load_library(Some(unsafe { &*path.as_ptr() })) != 1 {
            return Err(format!("could not load {}", framework.display()));
        }
        mac::install_app_protocol()?;
    }

    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    // CEF keeps referring to argv, so the arguments must outlive this function.
    let args: &'static args::Args = Box::leak(Box::new(args::Args::new()));

    let load_extension = layout
        .extensions
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(",");
    let mut cef_app = MildApp::new(app.clone(), load_extension);

    let code = execute_process(Some(args.as_main_args()), Some(&mut cef_app), std::ptr::null_mut());
    if code >= 0 {
        // Only a sub-process returns here; the browser process gets -1.
        std::process::exit(code);
    }

    let settings = Settings {
        no_sandbox: 1,
        external_message_pump: 1,
        root_cache_path: CefString::from(layout.cache_dir.to_string_lossy().as_ref()),
        cache_path: CefString::from(layout.cache_dir.to_string_lossy().as_ref()),
        remote_debugging_port: layout.debug_port as _,
        log_severity: LogSeverity::WARNING,
        #[cfg(target_os = "macos")]
        framework_dir_path: CefString::from(layout.framework_dir.join("Chromium Embedded Framework.framework").to_string_lossy().as_ref()),
        #[cfg(target_os = "macos")]
        browser_subprocess_path: CefString::from(layout.helper.to_string_lossy().as_ref()),
        #[cfg(target_os = "macos")]
        main_bundle_path: CefString::from(layout.main_bundle.as_ref().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default().as_str()),
        ..Default::default()
    };
    if cef::initialize(Some(args.as_main_args()), Some(&settings), Some(&mut cef_app), std::ptr::null_mut()) != 1 {
        return Err("CEF initialisation failed".into());
    }
    INITIALIZED.store(true, Ordering::SeqCst);
    start_pump_thread(app.clone());
    Ok(())
}

/// One unit of CEF work on the main thread. Never nests: CEF calls
/// `OnScheduleMessagePumpWork` from inside its own work, and Tauri's
/// `run_on_main_thread` runs a closure inline when it is already on the main thread —
/// pumping again from there deadlocks on a lock CEF still holds.
fn pump() {
    if !INITIALIZED.load(Ordering::SeqCst) || SHUTTING_DOWN.load(Ordering::SeqCst) {
        return;
    }
    if PUMPING.swap(true, Ordering::SeqCst) {
        return;
    }
    do_message_loop_work();
    PUMPING.store(false, Ordering::SeqCst);
}

/// Called by CEF from any thread, including the main thread mid-pump. It only records
/// the request; the pump thread turns it into a queued main-thread task, so the work
/// always runs from the event loop and never re-enters CEF.
fn schedule_pump(delay_ms: i64) {
    if let Some(sender) = PUMP_REQUESTS.get() {
        let _ = sender.send(delay_ms.max(0));
    }
}

/// Drives the pump: honours CEF's requested delays and, like cefclient, also ticks on
/// its own at ~60 Hz so work CEF did not announce still gets serviced.
fn start_pump_thread(app: AppHandle) {
    let (sender, receiver) = std::sync::mpsc::channel::<i64>();
    let _ = PUMP_REQUESTS.set(sender);
    std::thread::spawn(move || {
        const TICK: Duration = Duration::from_millis(16);
        let mut due = std::time::Instant::now() + TICK;
        loop {
            if SHUTTING_DOWN.load(Ordering::SeqCst) {
                break;
            }
            let now = std::time::Instant::now();
            if now < due {
                match receiver.recv_timeout(due - now) {
                    Ok(delay) => {
                        let requested = now + Duration::from_millis(delay as u64);
                        if requested < due {
                            due = requested;
                        }
                        continue;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            if app.run_on_main_thread(pump).is_err() {
                break;
            }
            due = std::time::Instant::now() + TICK;
        }
    });
}

/// Close the browser and tear CEF down. Runs on the main thread at application exit.
pub fn shutdown(app: &AppHandle) {
    if !INITIALIZED.load(Ordering::SeqCst) {
        return;
    }
    let shared = app.state::<BrowserState>().0.clone();
    if let Some(browser) = shared.browser.lock().expect("browser").take() {
        if let Some(host) = browser.host() {
            host.close_browser(1);
        }
    }
    // Let the close round-trip through CEF's threads before shutdown.
    for _ in 0..20 {
        do_message_loop_work();
        std::thread::sleep(Duration::from_millis(10));
    }
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    cef::shutdown();
}

// ---------------------------------------------------------------------------------------
// CEF application and handlers.

wrap_app! {
    pub struct MildApp {
        app: AppHandle,
        load_extension: String,
    }

    impl App {
        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            // Only the browser process gets an empty type; Chromium forwards what the
            // children need on its own.
            let is_browser = process_type.map(|kind| kind.to_string().is_empty()).unwrap_or(true);
            if !is_browser {
                return;
            }
            if let Some(command_line) = command_line {
                // Chromium keeps its cookie-encryption key in the login keychain under an
                // ACL tied to the app's code identity. Ad-hoc signed builds get a new
                // identity every build, so macOS would ask for the password on each
                // launch; the mock keychain uses a fixed key and never prompts.
                #[cfg(target_os = "macos")]
                command_line.append_switch(Some(&CefString::from("use-mock-keychain")));
                if !self.load_extension.is_empty() {
                    command_line.append_switch_with_value(
                        Some(&CefString::from("load-extension")),
                        Some(&CefString::from(self.load_extension.as_str())),
                    );
                }
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(MildBrowserProcessHandler::new(self.app.clone()))
        }
    }
}

wrap_browser_process_handler! {
    struct MildBrowserProcessHandler {
        app: AppHandle,
    }

    impl BrowserProcessHandler {
        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            schedule_pump(delay_ms);
        }
    }
}

wrap_client! {
    struct MildClient {
        shared: Arc<Shared>,
        app: AppHandle,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(MildDisplayHandler::new(self.shared.clone(), self.app.clone()))
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(MildLifeSpanHandler::new(self.shared.clone(), self.app.clone()))
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(MildLoadHandler::new(self.shared.clone(), self.app.clone()))
        }
    }
}

wrap_display_handler! {
    struct MildDisplayHandler {
        shared: Arc<Shared>,
        app: AppHandle,
    }

    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            let title = title.map(CefString::to_string).unwrap_or_default();
            self.shared.update(&self.app, |status| status.title = title);
        }

        fn on_address_change(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            let is_main = frame.map(|frame| frame.is_main() != 0).unwrap_or(true);
            if !is_main {
                return;
            }
            let url = url.map(CefString::to_string).unwrap_or_default();
            self.shared.update(&self.app, |status| status.url = url);
        }
    }
}

wrap_life_span_handler! {
    struct MildLifeSpanHandler {
        shared: Arc<Shared>,
        app: AppHandle,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser.cloned() else { return };
            *self.shared.browser.lock().expect("browser") = Some(browser.clone());
            if let Some(bounds) = self.shared.pending_bounds.lock().expect("pending bounds").take() {
                if let Some(window) = self.app.get_webview_window("main") {
                    let _ = platform::apply_bounds(&window.as_ref().window(), &browser, &bounds);
                }
            }
            self.shared.update(&self.app, |status| {
                status.open = true;
                status.visible = true;
            });
        }

        fn do_close(&self, _browser: Option<&mut Browser>) -> i32 {
            0
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            *self.shared.browser.lock().expect("browser") = None;
            self.shared.update(&self.app, |status| {
                status.open = false;
                status.visible = false;
                status.loading = false;
            });
        }
    }
}

wrap_load_handler! {
    struct MildLoadHandler {
        shared: Arc<Shared>,
        app: AppHandle,
    }

    impl LoadHandler {
        fn on_loading_state_change(&self, _browser: Option<&mut Browser>, is_loading: i32, can_go_back: i32, can_go_forward: i32) {
            self.shared.update(&self.app, |status| {
                status.loading = is_loading != 0;
                status.can_go_back = can_go_back != 0;
                status.can_go_forward = can_go_forward != 0;
            });
        }
    }
}

// ---------------------------------------------------------------------------------------
// Commands. Each hops to the main thread; CEF objects are only touched there.

fn on_main<F>(window: &Window, task: F) -> Result<(), String>
where
    F: FnOnce() + Send + 'static,
{
    window.run_on_main_thread(task).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_status(state: tauri::State<'_, BrowserState>) -> PanelStatus {
    state.0.status.lock().expect("panel status").clone()
}

/// Show the panel at `bounds`, loading `url`. Creates the browser on first use.
#[tauri::command]
pub fn browser_open(window: Window, state: tauri::State<'_, BrowserState>, url: String, bounds: PanelBounds) -> Result<(), String> {
    if !state.0.status.lock().expect("panel status").available {
        return Err(state.0.status.lock().expect("panel status").error.clone().unwrap_or_else(|| "CEF is not available".into()));
    }
    let shared = state.0.clone();
    let app = window.app_handle().clone();
    let target = window.clone();
    on_main(&window, move || {
        if ensure_initialized(&app, &shared).is_err() {
            return;
        }
        let existing = shared.browser.lock().expect("browser").clone();
        match existing {
            Some(browser) => {
                let _ = platform::apply_bounds(&target, &browser, &bounds);
                platform::set_hidden(&browser, false);
                if let Some(frame) = browser.main_frame() {
                    frame.load_url(Some(&CefString::from(url.as_str())));
                }
                shared.update(&app, |status| status.visible = true);
            }
            None => {
                *shared.pending_bounds.lock().expect("pending bounds") = Some(bounds);
                if let Err(error) = create_browser(&target, &shared, &app, &url, bounds) {
                    shared.update(&app, |status| status.error = Some(error));
                }
            }
        }
    })
}

fn create_browser(window: &Window, shared: &Arc<Shared>, app: &AppHandle, url: &str, bounds: PanelBounds) -> Result<(), String> {
    let parent = platform::parent_handle(window)?;
    let rect = platform::rect_for(window, &bounds)?;
    // Alloy style is what a browser embedded in a host view gets; Chrome style cannot be
    // parented into a foreign window (CEF issue #3294). Extensions load either way.
    let window_info = WindowInfo { runtime_style: RuntimeStyle::ALLOY, ..Default::default() }.set_as_child(parent, &rect);
    let mut client = Some(MildClient::new(shared.clone(), app.clone()));
    let settings = BrowserSettings::default();
    if browser_host_create_browser(Some(&window_info), client.as_mut(), Some(&CefString::from(url)), Some(&settings), None, None) != 1 {
        return Err("CEF could not create the browser".into());
    }
    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(window: Window, state: tauri::State<'_, BrowserState>, bounds: PanelBounds) -> Result<(), String> {
    let shared = state.0.clone();
    let target = window.clone();
    on_main(&window, move || {
        let browser = shared.browser.lock().expect("browser").clone();
        match browser {
            Some(browser) => { let _ = platform::apply_bounds(&target, &browser, &bounds); }
            None => *shared.pending_bounds.lock().expect("pending bounds") = Some(bounds),
        }
    })
}

#[tauri::command]
pub fn browser_set_visible(window: Window, state: tauri::State<'_, BrowserState>, visible: bool) -> Result<(), String> {
    let shared = state.0.clone();
    let app = window.app_handle().clone();
    on_main(&window, move || {
        if let Some(browser) = shared.browser.lock().expect("browser").clone() {
            platform::set_hidden(&browser, !visible);
            shared.update(&app, |status| status.visible = visible);
        }
    })
}

#[tauri::command]
pub fn browser_navigate(window: Window, state: tauri::State<'_, BrowserState>, url: String) -> Result<(), String> {
    let shared = state.0.clone();
    on_main(&window, move || {
        if let Some(frame) = shared.browser.lock().expect("browser").as_ref().and_then(|browser| browser.main_frame()) {
            frame.load_url(Some(&CefString::from(url.as_str())));
        }
    })
}

/// `back`, `forward`, `reload` or `stop`.
#[tauri::command]
pub fn browser_go(window: Window, state: tauri::State<'_, BrowserState>, action: String) -> Result<(), String> {
    let shared = state.0.clone();
    on_main(&window, move || {
        if let Some(browser) = shared.browser.lock().expect("browser").clone() {
            match action.as_str() {
                "back" => browser.go_back(),
                "forward" => browser.go_forward(),
                "reload" => browser.reload(),
                "stop" => browser.stop_load(),
                _ => {}
            }
        }
    })
}

#[tauri::command]
pub fn browser_close(window: Window, state: tauri::State<'_, BrowserState>) -> Result<(), String> {
    let shared = state.0.clone();
    on_main(&window, move || {
        if let Some(host) = shared.browser.lock().expect("browser").as_ref().and_then(|browser| browser.host()) {
            host.close_browser(1);
        }
    })
}

/// Start a native window drag from the custom title bar.
///
/// Tauri's own drag path (`plugin:window|start_dragging`) reads `[NSApp currentEvent]`
/// on the main thread and crashes the process when that is nil, which it can be once a
/// drag request lands between events — something that happens readily with CEF pumping
/// work on the same loop. This does the same thing but synthesises a mouse-down at the
/// pointer when there is no current event, the way tao already does for its own proxy
/// events.
#[tauri::command]
pub fn mac_drag_window(window: Window) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        return on_main(&window, move || mac::drag_window(&target));
    }
    #[allow(unreachable_code)]
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Extensions. CEF has no Web Store UI and loads extensions only from unpacked directories
// named on the command line at start-up, so installing means: fetch the .crx Google serves
// for a store id, strip the CRX3 header, unzip it under the profile, and load it on the
// next start.

/// Chromium version reported to the update server, which serves the newest .crx compatible
/// with it. Keep in step with the pinned CEF (see Cargo.toml).
const CHROMIUM_VERSION: &str = "151.0.7922.174";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub path: String,
    /// Installed or changed since CEF started; a restart picks it up.
    pub pending: bool,
}

/// A Web Store id is 32 letters from a to p. Accepts the bare id or any store URL that
/// contains one (`…/detail/<slug>/<id>`).
fn extension_id_from_source(source: &str) -> Option<String> {
    let trimmed = source.trim();
    let is_id = |s: &str| s.len() == 32 && s.bytes().all(|b| (b'a'..=b'p').contains(&b));
    if is_id(trimmed) {
        return Some(trimmed.to_string());
    }
    trimmed
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|part| is_id(part))
        .map(str::to_string)
}

/// The zip inside a .crx. CRX3: "Cr24", u32 version (3), u32 header length, header, zip.
/// CRX2 differs only in carrying two lengths (public key, signature) instead of one.
fn crx_payload(bytes: &[u8]) -> Result<&[u8], String> {
    let word = |at: usize| -> Result<usize, String> {
        bytes
            .get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
            .ok_or_else(|| "truncated .crx header".to_string())
    };
    if bytes.get(0..4) != Some(b"Cr24") {
        return Err("not a .crx file (the store returned something else)".into());
    }
    let start = match word(4)? {
        3 => 12 + word(8)?,
        2 => 16 + word(8)? + word(12)?,
        other => return Err(format!("unsupported .crx version {other}")),
    };
    bytes.get(start..).ok_or_else(|| "truncated .crx payload".to_string())
}

fn read_manifest(dir: &std::path::Path) -> Option<(String, String)> {
    let manifest: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).ok()?).ok()?;
    let version = manifest.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut name = manifest.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // Localised names look like __MSG_appName__ and resolve through the default locale.
    if let Some(key) = name.strip_prefix("__MSG_").and_then(|rest| rest.strip_suffix("__")) {
        let locale = manifest.get("default_locale").and_then(|v| v.as_str()).unwrap_or("en");
        let messages = std::fs::read_to_string(dir.join("_locales").join(locale).join("messages.json")).ok();
        let resolved = messages
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|value| value.get(key)?.get("message")?.as_str().map(str::to_string));
        if let Some(resolved) = resolved {
            name = resolved;
        }
    }
    Some((name, version))
}

fn list_extensions(shared: &Shared) -> Vec<ExtensionInfo> {
    let Some(dir) = shared.extensions_dir.lock().expect("extensions dir").clone() else { return Vec::new() };
    let loaded = shared.loaded_extensions.lock().expect("loaded extensions").clone();
    let mut items: Vec<ExtensionInfo> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let (name, version) = read_manifest(&path)?;
            let id = entry.file_name().to_string_lossy().into_owned();
            let pending = INITIALIZED.load(Ordering::SeqCst) && !loaded.contains(&id);
            Some(ExtensionInfo { pending, path: path.to_string_lossy().into_owned(), id, name, version })
        })
        .collect();
    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    items
}

fn install_extension(shared: &Shared, source: &str) -> Result<ExtensionInfo, String> {
    let id = extension_id_from_source(source).ok_or("That is not a Chrome Web Store link or extension id.")?;
    let dir = shared.extensions_dir.lock().expect("extensions dir").clone().ok_or("The problem browser is not initialised.")?;
    let url = format!(
        "https://clients2.google.com/service/update2/crx?response=redirect&prodversion={CHROMIUM_VERSION}&acceptformat=crx2,crx3&x=id%3D{id}%26installsource%3Dondemand%26uc"
    );
    let client = reqwest::blocking::Client::builder()
        .user_agent(format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROMIUM_VERSION} Safari/537.36"))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.get(&url).send().map_err(|error| format!("Download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("The store answered {} for {id}. Is the id right?", response.status()));
    }
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    let payload = crx_payload(&bytes)?;

    // Unpack beside the target, then swap it in, so a failed download never leaves a
    // half-written extension for the next start to trip over.
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let staging = dir.join(format!(".{id}.partial"));
    let _ = std::fs::remove_dir_all(&staging);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(payload)).map_err(|error| format!("Unreadable .crx: {error}"))?;
    archive.extract(&staging).map_err(|error| format!("Could not unpack the extension: {error}"))?;
    if !staging.join("manifest.json").is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("The download did not contain an extension manifest.".into());
    }
    let target = dir.join(&id);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|error| error.to_string())?;

    let (name, version) = read_manifest(&target).unwrap_or_default();
    Ok(ExtensionInfo { pending: true, path: target.to_string_lossy().into_owned(), id, name, version })
}

#[tauri::command]
pub fn browser_extensions_list(state: tauri::State<'_, BrowserState>) -> Vec<ExtensionInfo> {
    list_extensions(&state.0)
}

/// `source` is a Web Store link or a bare extension id. Runs off the main thread: the
/// download can take a while and must not stall CEF's pump.
#[tauri::command]
pub async fn browser_extension_install(state: tauri::State<'_, BrowserState>, source: String) -> Result<ExtensionInfo, String> {
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || install_extension(&shared, &source))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn browser_extension_remove(state: tauri::State<'_, BrowserState>, id: String) -> Result<(), String> {
    let dir = state.0.extensions_dir.lock().expect("extensions dir").clone().ok_or("The problem browser is not initialised.")?;
    let id = extension_id_from_source(&id).ok_or("Unknown extension id.")?;
    std::fs::remove_dir_all(dir.join(&id)).map_err(|error| format!("Could not remove the extension: {error}"))?;
    // It stays loaded in the running CEF until the next start; the list reports it gone.
    state.0.loaded_extensions.lock().expect("loaded extensions").remove(&id);
    Ok(())
}

#[cfg(test)]
mod extension_tests {
    use super::*;

    #[test]
    fn accepts_a_bare_id_and_store_links() {
        assert_eq!(extension_id_from_source("cjnmckjndlpiamhfimnnjmnckgghkjbl").as_deref(), Some("cjnmckjndlpiamhfimnnjmnckgghkjbl"));
        assert_eq!(
            extension_id_from_source("https://chromewebstore.google.com/detail/competitive-companion/cjnmckjndlpiamhfimnnjmnckgghkjbl?hl=en").as_deref(),
            Some("cjnmckjndlpiamhfimnnjmnckgghkjbl")
        );
        assert_eq!(extension_id_from_source("https://chrome.google.com/webstore/detail/cjnmckjndlpiamhfimnnjmnckgghkjbl").as_deref(), Some("cjnmckjndlpiamhfimnnjmnckgghkjbl"));
        assert_eq!(extension_id_from_source("not an id"), None);
        assert_eq!(extension_id_from_source("cjnmckjndlpiamhfimnnjmnckgghkjbz"), None, "z is outside a-p");
    }

    #[test]
    fn strips_crx3_and_crx2_headers() {
        let zip = b"PK\x03\x04payload";
        let mut crx3 = b"Cr24".to_vec();
        crx3.extend(3u32.to_le_bytes());
        crx3.extend(5u32.to_le_bytes());
        crx3.extend(b"hdr..");
        crx3.extend(zip);
        assert_eq!(crx_payload(&crx3).unwrap(), zip);

        let mut crx2 = b"Cr24".to_vec();
        crx2.extend(2u32.to_le_bytes());
        crx2.extend(2u32.to_le_bytes());
        crx2.extend(3u32.to_le_bytes());
        crx2.extend(b"kksig");
        crx2.extend(zip);
        assert_eq!(crx_payload(&crx2).unwrap(), zip);

        assert!(crx_payload(b"<html>nope").is_err());
        assert!(crx_payload(b"Cr24\x03\x00\x00\x00\xff\xff\x00\x00").is_err(), "header longer than the file");
    }

    /// Needs the network: fetches Competitive Companion from the Web Store and unpacks it.
    #[test]
    #[ignore = "downloads from clients2.google.com"]
    fn installs_competitive_companion_from_the_store() {
        let shared = Shared::default();
        let dir = tempfile::tempdir().expect("temp dir");
        // MILD_TEST_EXTENSIONS_DIR redirects the install into a real profile, which is how
        // the end-to-end check seeds the dev app with a store extension.
        let root = std::env::var_os("MILD_TEST_EXTENSIONS_DIR").map(PathBuf::from).unwrap_or_else(|| dir.path().join("extensions"));
        *shared.extensions_dir.lock().unwrap() = Some(root);
        let info = install_extension(&shared, "https://chromewebstore.google.com/detail/competitive-companion/cjnmckjndlpiamhfimnnjmnckgghkjbl").expect("install");
        assert_eq!(info.id, "cjnmckjndlpiamhfimnnjmnckgghkjbl");
        assert!(info.name.to_lowercase().contains("competitive"), "name was {:?}", info.name);
        assert!(std::path::Path::new(&info.path).join("manifest.json").is_file());
        assert!(info.pending);
        let listed = list_extensions(&shared);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, info.id);
    }
}

// ---------------------------------------------------------------------------------------
// Platform glue.

#[cfg(target_os = "macos")]
mod mac {
    use super::PanelBounds;
    use cef::{ImplBrowser, ImplBrowserHost, Rect};
    use objc2::encode::Encoding;
    use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, Bool, Imp, Sel};
    use objc2::{ffi, sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSView};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::Window;

    static HANDLING_SEND_EVENT: AtomicBool = AtomicBool::new(false);
    static ORIGINAL_SEND_EVENT: OnceLock<Imp> = OnceLock::new();

    extern "C-unwind" fn is_handling_send_event(_this: *mut AnyObject, _sel: Sel) -> Bool {
        Bool::from(HANDLING_SEND_EVENT.load(Ordering::SeqCst))
    }

    extern "C-unwind" fn set_handling_send_event(_this: *mut AnyObject, _sel: Sel, value: Bool) {
        HANDLING_SEND_EVENT.store(value.as_bool(), Ordering::SeqCst);
    }

    extern "C-unwind" fn send_event(this: *mut AnyObject, sel: Sel, event: *mut AnyObject) {
        let was_handling = HANDLING_SEND_EVENT.swap(true, Ordering::SeqCst);
        if let Some(original) = ORIGINAL_SEND_EVENT.get() {
            let original: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) = unsafe { std::mem::transmute(*original) };
            unsafe { original(this, sel, event) };
        }
        HANDLING_SEND_EVENT.store(was_handling, Ordering::SeqCst);
    }

    /// CEF requires the NSApplication to implement `CefAppProtocol` (an
    /// `isHandlingSendEvent` flag it toggles around event dispatch). Tauri's `TaoApp`
    /// does not, so the methods and protocol conformance are added to it at runtime,
    /// and its `sendEvent:` is wrapped to maintain the flag.
    pub fn install_app_protocol() -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("CEF must be initialised on the main thread")?;
        let app = NSApplication::sharedApplication(mtm);
        let class: &AnyClass = app.class();
        let class_ptr = class as *const AnyClass as *mut AnyClass;
        if ORIGINAL_SEND_EVENT.get().is_some() {
            return Ok(());
        }
        let bool_encoding = Encoding::Bool;
        let getter_types = std::ffi::CString::new(format!("{}{}{}", bool_encoding, Encoding::Object, Encoding::Sel)).map_err(|e| e.to_string())?;
        let setter_types = std::ffi::CString::new(format!("{}{}{}{}", Encoding::Void, Encoding::Object, Encoding::Sel, bool_encoding)).map_err(|e| e.to_string())?;
        unsafe {
            let getter: Imp = std::mem::transmute(is_handling_send_event as extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool);
            let setter: Imp = std::mem::transmute(set_handling_send_event as extern "C-unwind" fn(*mut AnyObject, Sel, Bool));
            ffi::class_addMethod(class_ptr, sel!(isHandlingSendEvent), getter, getter_types.as_ptr());
            ffi::class_addMethod(class_ptr, sel!(setHandlingSendEvent:), setter, setter_types.as_ptr());

            let method = ffi::class_getInstanceMethod(class_ptr, sel!(sendEvent:));
            if method.is_null() {
                return Err("NSApplication has no sendEvent: method".into());
            }
            let wrapper: Imp = std::mem::transmute(send_event as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject));
            let original = ffi::method_setImplementation(method, wrapper).ok_or("could not wrap sendEvent:")?;
            let _ = ORIGINAL_SEND_EVENT.set(original);

            // The protocols come from the framework, which is loaded by now.
            for name in [c"CrAppProtocol", c"CrAppControlProtocol", c"CefAppProtocol"] {
                if let Some(protocol) = AnyProtocol::get(name) {
                    ffi::class_addProtocol(class_ptr, protocol as *const AnyProtocol);
                }
            }
        }
        Ok(())
    }

    pub fn parent_handle(window: &Window) -> Result<cef::sys::cef_window_handle_t, String> {
        window.ns_view().map_err(|error| error.to_string())
    }

    pub fn drag_window(window: &Window) {
        use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
        use objc2_foundation::NSProcessInfo;
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Ok(ns_window) = window.ns_window() else { return };
        let ns_window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        let current = NSApplication::sharedApplication(mtm)
            .currentEvent()
            .filter(|event| matches!(event.r#type(), NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged));
        let event = current.or_else(|| {
            NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                NSEventType::LeftMouseDown,
                ns_window.mouseLocationOutsideOfEventStream(),
                NSEventModifierFlags::empty(),
                NSProcessInfo::processInfo().systemUptime(),
                ns_window.windowNumber(),
                None,
                0,
                1,
                1.0,
            )
        });
        if let Some(event) = event {
            ns_window.performWindowDragWithEvent(&event);
        }
    }

    /// Convert the frontend's top-left CSS rectangle into the parent view's coordinate
    /// space. AppKit views measure from the bottom-left unless flipped.
    pub fn rect_for(window: &Window, bounds: &PanelBounds) -> Result<Rect, String> {
        let parent = window.ns_view().map_err(|error| error.to_string())? as *const NSView;
        let parent: &NSView = unsafe { parent.as_ref() }.ok_or("window has no content view")?;
        let parent_height = parent.bounds().size.height;
        let x = bounds.x * bounds.scale;
        let top = bounds.y * bounds.scale;
        let width = (bounds.width * bounds.scale).max(1.0);
        let height = (bounds.height * bounds.scale).max(1.0);
        let y = if parent.isFlipped() { top } else { parent_height - (top + height) };
        Ok(Rect { x: x.round() as i32, y: y.round() as i32, width: width.round() as i32, height: height.round() as i32 })
    }

    fn browser_view(browser: &cef::Browser) -> Option<(cef::BrowserHost, &'static NSView)> {
        let host = browser.host()?;
        let view = host.window_handle() as *const NSView;
        let view: &'static NSView = unsafe { view.as_ref() }?;
        Some((host, view))
    }

    pub fn apply_bounds(window: &Window, browser: &cef::Browser, bounds: &PanelBounds) -> Result<(), String> {
        let rect = rect_for(window, bounds)?;
        let (host, view) = browser_view(browser).ok_or("browser has no native view")?;
        view.setFrame(NSRect::new(NSPoint::new(rect.x as f64, rect.y as f64), NSSize::new(rect.width as f64, rect.height as f64)));
        host.was_resized();
        Ok(())
    }

    pub fn set_hidden(browser: &cef::Browser, hidden: bool) {
        if let Some((host, view)) = browser_view(browser) {
            view.setHidden(hidden);
            host.was_hidden(hidden as i32);
        }
    }
}

#[cfg(target_os = "windows")]
mod win {
    use super::PanelBounds;
    use cef::{ImplBrowser, ImplBrowserHost, Rect};
    use tauri::Window;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOW};

    pub fn parent_handle(window: &Window) -> Result<cef::sys::cef_window_handle_t, String> {
        window.hwnd().map(|hwnd| hwnd.0 as HWND).map_err(|error| error.to_string())
    }

    /// WebView2 lays the page out in device pixels, so the CSS rectangle is scaled by
    /// both the webview zoom and the monitor scale factor.
    pub fn rect_for(window: &Window, bounds: &PanelBounds) -> Result<Rect, String> {
        let dpi = window.scale_factor().map_err(|error| error.to_string())?;
        let factor = bounds.scale * dpi;
        Ok(Rect {
            x: (bounds.x * factor).round() as i32,
            y: (bounds.y * factor).round() as i32,
            width: (bounds.width * factor).round().max(1.0) as i32,
            height: (bounds.height * factor).round().max(1.0) as i32,
        })
    }

    pub fn apply_bounds(window: &Window, browser: &cef::Browser, bounds: &PanelBounds) -> Result<(), String> {
        let rect = rect_for(window, bounds)?;
        let host = browser.host().ok_or("browser has no host")?;
        let hwnd = host.window_handle();
        if hwnd.is_null() {
            return Err("browser has no native window".into());
        }
        unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), rect.x, rect.y, rect.width, rect.height, SWP_NOZORDER | SWP_NOACTIVATE) };
        host.was_resized();
        Ok(())
    }

    pub fn set_hidden(browser: &cef::Browser, hidden: bool) {
        if let Some(host) = browser.host() {
            let hwnd = host.window_handle();
            if !hwnd.is_null() {
                unsafe { ShowWindow(hwnd, if hidden { SW_HIDE } else { SW_SHOW }) };
            }
            host.was_hidden(hidden as i32);
        }
    }
}

#[cfg(target_os = "macos")]
use mac as platform;
#[cfg(target_os = "windows")]
use win as platform;
