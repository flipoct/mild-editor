//! Update checks and installs.
//!
//! The updater plugin's own JS commands build their HTTP client with no connect timeout,
//! so a release host address that black-holes packets stalls the request for however long
//! the OS takes to give up on the TCP handshake — about 21 seconds on Windows. GitHub's
//! `release-assets.githubusercontent.com` resolves to four addresses and hands them out in
//! rotating order, so on a network where one of them is unreachable a check fails roughly
//! one time in four, and only for the people on that network. Driving the updater from Rust
//! lets us cap each connection attempt, after which the next address is tried and the check
//! finishes in about a second.

use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Long enough for a slow mobile handshake, short enough that walking all four of
/// GitHub's addresses still beats the check timeout below.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Covers the whole check, which is one small JSON document.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressEvent {
    received: usize,
    total: Option<u64>,
}

/// The update found by the last check, kept so that installing does not have to ask again.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

fn describe(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Option<AvailableUpdate>, String> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| client.connect_timeout(CONNECT_TIMEOUT))
        .build()
        .map_err(describe)?;
    let update = updater.check().await.map_err(describe)?;

    let found = update.as_ref().map(|update| AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.as_ref().map(|body| body.trim().to_string()).filter(|body| !body.is_empty()),
    });
    *app.state::<PendingUpdate>().0.lock().map_err(|_| "Update state is unavailable.")? = update;
    Ok(found)
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    // Cloned out of the lock: the guard cannot be held across the download.
    let pending = {
        let state = app.state::<PendingUpdate>();
        let guard = state.0.lock().map_err(|_| "Update state is unavailable.")?;
        guard.clone()
    };
    let update = match pending {
        Some(update) => update,
        // The check either never ran or found nothing; ask again rather than fail.
        None => check_pending(&app).await?,
    };

    let handle = app.clone();
    let finished = app.clone();
    let mut received = 0usize;
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk;
                let _ = handle.emit("update-download-progress", DownloadProgressEvent { received, total });
            },
            // Installing happens after the last chunk and can take a moment of its own,
            // so the frontend is told when the download ends rather than when the whole
            // call returns.
            move || { let _ = finished.emit("update-download-finished", ()); },
        )
        .await
        .map_err(describe)?;
    Ok(())
}

/// Re-runs the check and returns the update, erroring when there is nothing to install.
async fn check_pending(app: &tauri::AppHandle) -> Result<Update, String> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| client.connect_timeout(CONNECT_TIMEOUT))
        .build()
        .map_err(describe)?;
    updater
        .check()
        .await
        .map_err(describe)?
        .ok_or_else(|| "There is no update to install.".to_string())
}
