//! The app's icon, when the user picks one of their own (Settings → Appearance).
//!
//! On Windows and Linux the window carries the icon the taskbar shows, and setting it is
//! enough. A Mac shows the application's icon in the Dock instead, which only the running
//! app can change, and only until it quits: so the frontend sets it again on every start.
//! An icon from the internet is downloaded here, since the page may not load images from
//! other sites; Discord is given the same address (src/discord.ts).

use std::time::Duration;

/// A picture larger than this is not an icon.
const MOST_BYTES: usize = 8 * 1024 * 1024;

/// Shows `png` as the app's icon; none puts the app's own back (on a Mac: the bundle's icon).
#[tauri::command]
pub fn set_app_icon(app: tauri::AppHandle, window: tauri::WebviewWindow, png: Option<Vec<u8>>) -> Result<(), String> {
    if png.as_ref().is_some_and(|bytes| bytes.len() > MOST_BYTES) {
        return Err("That image is too large for an icon.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &window;
        app.run_on_main_thread(move || {
            use objc2::{AnyThread, MainThreadMarker};
            use objc2_app_kit::{NSApplication, NSImage};
            use objc2_foundation::NSData;
            let Some(marker) = MainThreadMarker::new() else { return };
            let image = png.as_deref().and_then(|bytes| NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes)));
            // SAFETY: on the main thread, as AppKit requires; a nil image restores the bundle's icon.
            unsafe { NSApplication::sharedApplication(marker).setApplicationIconImage(image.as_deref()) };
        }).map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        // The theme's own icon is the frontend's to put back (src/themeIcon.ts).
        let Some(bytes) = png else { return Ok(()) };
        let image = tauri::image::Image::from_bytes(&bytes).map_err(|error| format!("That is not an image the window can show: {error}"))?;
        window.set_icon(image).map_err(|error| error.to_string())
    }
}

/// The picture at `url`, for an icon chosen by its address: an image, over https, not too large.
#[tauri::command]
pub async fn fetch_icon_image(url: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "That is not an address.".to_string())?;
        if parsed.scheme() != "https" {
            return Err("Discord only shows images from https addresses.".into());
        }
        let client = reqwest::blocking::Client::builder()
            .user_agent("mild-editor")
            .connect_timeout(crate::HTTP_CONNECT_TIMEOUT)
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client.get(parsed).send().and_then(|response| response.error_for_status())
            .map_err(|error| format!("Could not download the image: {error}"))?;
        let kind = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or("").to_lowercase();
        if !kind.starts_with("image/") {
            return Err("That address is not an image.".into());
        }
        if response.content_length().is_some_and(|length| length as usize > MOST_BYTES) {
            return Err("That image is too large for an icon.".into());
        }
        let bytes = response.bytes().map_err(|error| format!("Could not download the image: {error}"))?;
        if bytes.len() > MOST_BYTES {
            return Err("That image is too large for an icon.".into());
        }
        Ok(bytes.to_vec())
    }).await.map_err(|error| error.to_string())?
}
