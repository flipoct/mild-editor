//! The few files outside the workspace the frontend reads or writes: the settings backup,
//! a custom font, a background image.

use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Deserialize)]
pub(crate) struct ReadFileRequest {
    path: String,
}

#[derive(Serialize)]
pub(crate) struct ReadImageFileResponse {
    bytes: Vec<u8>,
    mime: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsFileRequest {
    path: String,
    #[serde(default)]
    contents: String,
}

/// Settings live in the webview's local storage, which no backup reaches and which a
/// reinstall or a changed app identifier can empty without warning. These two write and
/// read the one file the user can keep somewhere safe.
#[tauri::command]
pub(crate) fn export_settings_file(request: SettingsFileRequest) -> Result<(), String> {
    if request.contents.len() > 8 * 1024 * 1024 { return Err("The settings are too large to export.".into()); }
    fs::write(&request.path, &request.contents).map_err(|error| format!("Could not write {}: {error}", request.path))
}

#[tauri::command]
pub(crate) fn import_settings_file(request: SettingsFileRequest) -> Result<String, String> {
    let metadata = fs::metadata(&request.path).map_err(|error| format!("Could not read {}: {error}", request.path))?;
    if metadata.len() > 8 * 1024 * 1024 { return Err("That file is too large to be a settings backup.".into()); }
    fs::read_to_string(&request.path).map_err(|error| format!("Could not read {}: {error}", request.path))
}

#[tauri::command]
pub(crate) fn read_font_file(request: ReadFileRequest) -> Result<Vec<u8>, String> {
    let path = std::path::PathBuf::from(request.path);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "ttf" | "otf" | "woff" | "woff2") {
        return Err("Select a .ttf, .otf, .woff, or .woff2 font file.".into());
    }
    let metadata = fs::metadata(&path).map_err(|error| format!("Could not read font file: {error}"))?;
    if metadata.len() > 25 * 1024 * 1024 { return Err("Font files must be 25 MB or smaller.".into()); }
    fs::read(path).map_err(|error| format!("Could not read font file: {error}"))
}

#[tauri::command]
pub(crate) fn read_image_file(request: ReadFileRequest) -> Result<ReadImageFileResponse, String> {
    let path = std::path::PathBuf::from(request.path);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => return Err("Select a PNG, JPG, WEBP, GIF, or BMP image.".into()),
    };
    let metadata = fs::metadata(&path).map_err(|error| format!("Could not read background image: {error}"))?;
    if metadata.len() > 40 * 1024 * 1024 {
        return Err("Background images must be 40 MB or smaller.".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("Could not read background image: {error}"))?;
    Ok(ReadImageFileResponse { bytes, mime: mime.into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_supported_background_images() {
        let image = tempfile::Builder::new().suffix(".png").tempfile().expect("create image");
        fs::write(image.path(), [0x89, b'P', b'N', b'G']).expect("write image");
        let loaded = read_image_file(ReadFileRequest { path: image.path().to_string_lossy().into_owned() }).expect("read image");
        assert_eq!(loaded.mime, "image/png");
        assert_eq!(loaded.bytes, [0x89, b'P', b'N', b'G']);

        let text = tempfile::Builder::new().suffix(".txt").tempfile().expect("create text");
        assert!(read_image_file(ReadFileRequest { path: text.path().to_string_lossy().into_owned() }).is_err());
    }
}
