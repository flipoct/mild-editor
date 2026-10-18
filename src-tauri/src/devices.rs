//! Development only: more copies of the app on this computer, each as if it ran on a device
//! of its own, so that a shared room can be tried with nobody else around.
//!
//! A copy is this same binary started again with `MILD_DEVICE=<n>`. It takes another
//! identifier, and with it an app data directory of its own — its own scratch workspace,
//! settings and browser profile — and its window keeps its own web storage. What it shares
//! with the first copy is only what two devices on one network share: the network. A room
//! opened in one is joined from the other with the invitation, through the relay, exactly
//! as a teammate would.

use std::process::Command;
use std::sync::Mutex;

/// Which device this copy plays: none for the first, 2 and up for the ones started from it.
pub fn number() -> Option<u32> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("MILD_DEVICE").ok()?.parse().ok().filter(|number| *number >= 2)
}

/// The web storage of device `number` (macOS keeps a webview's storage per identifier, not
/// per app data directory as Windows and Linux do).
fn store(number: u32) -> [u8; 16] {
    let mut store = [0u8; 16];
    store[..8].copy_from_slice(b"mild-dev");
    store[12..].copy_from_slice(&number.to_be_bytes());
    store
}

/// Gives this copy its own identity before the app is built, when it is a device of its own.
/// Its windows are then made by `open_windows`: the storage a window is given in the
/// configuration is not passed on to the webview.
pub fn separate<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    let Some(number) = number() else { return };
    let config = context.config_mut();
    config.identifier = format!("{}.device{number}", config.identifier);
    for window in config.app.windows.iter_mut() {
        window.create = false;
        window.title = format!("{} · device {number}", window.title);
        // Beside the first window rather than over it: where it asked, or cascaded.
        window.maximized = false;
        window.center = false;
        let frame = std::env::var("MILD_DEVICE_FRAME").ok().and_then(|frame| {
            let parts: Vec<f64> = frame.split(',').filter_map(|part| part.parse().ok()).collect();
            (parts.len() == 4).then(|| (parts[0], parts[1], parts[2], parts[3]))
        });
        let (x, y, width, height) = frame.unwrap_or((60.0 * f64::from(number), 40.0 * f64::from(number), 1100.0, 760.0));
        window.x = Some(x);
        window.y = Some(y);
        window.width = width.max(window.min_width.unwrap_or(0.0));
        window.height = height.max(window.min_height.unwrap_or(0.0));
    }
}

/// Makes the windows `separate` held back, each with the device's own storage.
pub fn open_windows(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(number) = number() else { return Ok(()) };
    follow_first_copy(app.clone());
    for mut config in app.config().app.windows.clone() {
        config.create = true;
        let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
        #[cfg(target_os = "macos")]
        let builder = builder.data_store_identifier(store(number));
        builder.build()?;
    }
    Ok(())
}

/// A device goes when the copy that started it does, however that went: `tauri dev` stops
/// the first copy without letting it close anything when it rebuilds.
fn follow_first_copy(app: tauri::AppHandle) {
    #[cfg(unix)]
    std::thread::spawn(move || {
        let first = std::os::unix::process::parent_id();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if std::os::unix::process::parent_id() != first {
                app.exit(0);
                return;
            }
        }
    });
    #[cfg(not(unix))]
    let _ = app;
}

/// The copies the first one started; they go when it does.
#[derive(Default)]
pub struct Devices(Mutex<Vec<(u32, std::process::Child)>>);

/// What this copy is, for the window: its device number, and the invitation to the room it
/// was started to join, if any.
#[derive(serde::Serialize)]
pub struct Device {
    number: u32,
    invite: Option<String>,
}

#[tauri::command]
pub fn dev_device() -> Option<Device> {
    let number = number()?;
    Some(Device { number, invite: std::env::var("MILD_DEVICE_JOIN").ok().filter(|invite| !invite.trim().is_empty()) })
}

/// Starts one more device, joining the room `invite` leads to when there is one. Only the
/// first copy does, so no two get the same number.
#[tauri::command]
pub fn dev_open_device(app: tauri::AppHandle, state: tauri::State<'_, Devices>, invite: Option<String>) -> Result<u32, String> {
    if !cfg!(debug_assertions) || number().is_some() {
        return Err("only the first development copy starts devices".into());
    }
    let mut started = state.0.lock().map_err(|error| error.to_string())?;
    // A device that was closed gives its number back; opened again, it is the same device, with its workspace as it was left.
    started.retain_mut(|(_, copy)| matches!(copy.try_wait(), Ok(None)));
    let next = (2..).find(|number| started.iter().all(|(taken, _)| taken != number)).unwrap_or(2);
    let program = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(program);
    command.env("MILD_DEVICE", next.to_string()).env_remove("MILD_DEVICE_JOIN").env_remove("MILD_DEVICE_FRAME");
    // The first device and this window share the screen half and half, both in sight: a
    // window in full screen is in a Space of its own, and a webview out of sight is slowed down.
    if next == 2 {
        if let Some(frame) = side_by_side(&app) {
            command.env("MILD_DEVICE_FRAME", frame);
        }
    }
    if let Some(invite) = invite {
        command.env("MILD_DEVICE_JOIN", invite);
    }
    let copy = command.spawn().map_err(|error| error.to_string())?;
    started.push((next, copy));
    Ok(next)
}

/// Takes the app window out of full screen into the left half of its display, and returns
/// the right half (`x,y,width,height`, in logical pixels) for the device.
fn side_by_side(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    let window = app.get_webview_window("main")?;
    let monitor = window.current_monitor().ok()??;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (x, y) = (f64::from(area.position.x) / scale, f64::from(area.position.y) / scale);
    let (width, height) = (f64::from(area.size.width) / scale, f64::from(area.size.height) / scale);
    let half = (width / 2.0).floor();
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    std::thread::spawn(move || {
        if fullscreen {
            let _ = window.set_fullscreen(false);
            // Leaving full screen is animated, and a frame set during it is lost.
            std::thread::sleep(std::time::Duration::from_millis(900));
        }
        let _ = window.unmaximize();
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        let _ = window.set_size(tauri::LogicalSize::new(half, height));
    });
    Some(format!("{},{},{},{}", x + half, y, width - half, height))
}

/// Ends every device this copy started.
pub fn close_all(state: &Devices) {
    if let Ok(mut started) = state.0.lock() {
        for (_, copy) in started.iter_mut() {
            let _ = copy.kill();
            let _ = copy.wait();
        }
        started.clear();
    }
}
