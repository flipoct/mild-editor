//! Problem-panel commands for platforms without CEF (currently Linux). Same command
//! surface as `browser.rs`, always reporting the panel as unavailable, so the frontend
//! and the invoke handler list stay identical across platforms.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Window};

pub const STATUS_EVENT: &str = "browser-status";
const REASON: &str = "The problem browser is not available on this platform yet.";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub scale: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelStatus {
    pub available: bool,
    pub error: Option<String>,
    pub open: bool,
    pub visible: bool,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[derive(Clone, Default)]
pub struct BrowserState;

fn status() -> PanelStatus {
    PanelStatus { available: false, error: Some(REASON.into()), ..Default::default() }
}

pub fn exit_if_subprocess() {}

pub fn initialize(app: &AppHandle) {
    let _ = app.emit(STATUS_EVENT, status());
}

pub fn shutdown(_app: &AppHandle) {}

#[tauri::command]
pub fn browser_status(_state: tauri::State<'_, BrowserState>) -> PanelStatus {
    status()
}

#[tauri::command]
pub fn browser_open(_window: Window, _state: tauri::State<'_, BrowserState>, _url: String, _bounds: PanelBounds) -> Result<(), String> {
    Err(REASON.into())
}

#[tauri::command]
pub fn browser_set_bounds(_window: Window, _state: tauri::State<'_, BrowserState>, _bounds: PanelBounds) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn browser_set_visible(_window: Window, _state: tauri::State<'_, BrowserState>, _visible: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(_window: Window, _state: tauri::State<'_, BrowserState>, _url: String) -> Result<(), String> {
    Err(REASON.into())
}

#[tauri::command]
pub fn browser_go(_window: Window, _state: tauri::State<'_, BrowserState>, _action: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn browser_close(_window: Window, _state: tauri::State<'_, BrowserState>) -> Result<(), String> {
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub path: String,
    pub pending: bool,
}

#[tauri::command]
pub fn browser_extensions_list(_state: tauri::State<'_, BrowserState>) -> Vec<ExtensionInfo> {
    Vec::new()
}

#[tauri::command]
pub async fn browser_extension_install(_state: tauri::State<'_, BrowserState>, _source: String) -> Result<ExtensionInfo, String> {
    Err(REASON.into())
}

#[tauri::command]
pub fn browser_extension_remove(_state: tauri::State<'_, BrowserState>, _id: String) -> Result<(), String> {
    Err(REASON.into())
}
