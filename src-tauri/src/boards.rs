//! Drawing boards: `.board` files in the workspace, drawn on instead of edited (src/board in
//! the frontend). A board is a JSON document of elements and the pictures they show; this side
//! only lists, reads, writes and deletes them, and checks that what it is asked about is a board
//! inside the workspace. It also saves a board exported as a PNG where the user chose.

use crate::workspace::{metadata_lock, walk_workspace, workspace_relative_filename};
use serde::Deserialize;
use tauri::{Emitter, Manager};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const BOARD_EXTENSION: &str = "board";

/// A board larger than this is not one the editor wrote; it is refused rather than loaded.
const MOST_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoardsRequest {
    folder_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoardRequest {
    folder_path: String,
    filename: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteBoardRequest {
    folder_path: String,
    filename: String,
    text: String,
}

pub(crate) fn is_board(filename: &str) -> bool {
    Path::new(filename).extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case(BOARD_EXTENSION))
}

/// The board's place on disk: relative to the workspace, no way out of it, and a `.board`.
fn board_path(folder: &str, filename: &str) -> Result<PathBuf, String> {
    let relative = workspace_relative_filename(filename)?;
    if !is_board(&relative) {
        return Err("A board's name ends in .board.".into());
    }
    Ok(Path::new(folder).join(relative))
}

/// Every board in the workspace, by workspace path, in the explorer's order.
#[tauri::command(async)]
pub(crate) fn list_workspace_boards(request: BoardsRequest) -> Result<Vec<String>, String> {
    let folder = PathBuf::from(&request.folder_path);
    let mut boards = Vec::new();
    walk_workspace(&folder, &folder, &mut |relative, is_directory| {
        if !is_directory && is_board(&relative) {
            boards.push(relative);
        }
    })?;
    boards.sort_by_key(|name| crate::workspace::sort_key(name));
    Ok(boards)
}

#[tauri::command(async)]
pub(crate) fn read_workspace_board(request: BoardRequest) -> Result<String, String> {
    let path = board_path(&request.folder_path, &request.filename)?;
    let size = fs::metadata(&path).map_err(|error| format!("Could not read the board: {error}"))?.len();
    if size > MOST_BYTES {
        return Err("The board is too large to open.".into());
    }
    fs::read_to_string(&path).map_err(|error| format!("Could not read the board: {error}"))
}

/// Writes beside the board and moves it over, so a board is never left half written.
#[tauri::command(async)]
pub(crate) fn write_workspace_board(request: WriteBoardRequest) -> Result<(), String> {
    if request.text.len() as u64 > MOST_BYTES {
        return Err("The board is too large to save.".into());
    }
    let _metadata = metadata_lock();
    let path = board_path(&request.folder_path, &request.filename)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not save the board: {error}"))?;
    }
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let temporary = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    if fs::write(&temporary, &request.text).and_then(|_| fs::rename(&temporary, &path)).is_ok() {
        return Ok(());
    }
    let _ = fs::remove_file(&temporary);
    fs::write(&path, &request.text).map_err(|error| format!("Could not save the board: {error}"))
}

#[tauri::command(async)]
pub(crate) fn delete_workspace_board(request: BoardRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    let path = board_path(&request.folder_path, &request.filename)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not delete the board: {error}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoardPictureRequest {
    path: String,
    data: Vec<u8>,
}

/// Saves a board exported as a PNG (src/board/export.ts) at the path the save dialog gave.
#[tauri::command(async)]
pub(crate) fn save_board_picture(request: BoardPictureRequest) -> Result<(), String> {
    if request.data.len() as u64 > MOST_BYTES * 4 {
        return Err("The picture is too large to save.".into());
    }
    if !request.data.starts_with(b"\x89PNG") {
        return Err("Only a PNG is saved here.".into());
    }
    fs::write(&request.path, &request.data).map_err(|error| format!("Could not save {}: {error}", request.path))
}

/// The board window: one window of its own that shows a board instead of the editor's panel
/// (src/board/BoardWindow.tsx). The app window keeps holding the board — its file, its room,
/// its tablets — and the two pages sync over events (src/board/windowLink.ts).
pub(crate) const BOARD_WINDOW: &str = "board";
/// Told to the app window when the board window was hidden, by its own button or the system's.
pub(crate) const BOARD_WINDOW_HIDDEN_EVENT: &str = "board-window-hidden";

/// Shows the board window, making it the first time. Async, and built on the main thread
/// through the event loop: a window made from a synchronous command hangs WebView2.
#[tauri::command]
pub(crate) async fn board_window_open(app: tauri::AppHandle, focus: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(BOARD_WINDOW) {
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        if focus {
            let _ = window.set_focus();
        }
        return Ok(());
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        // The same chrome as the problem window: the page draws the title bar.
        let builder = tauri::WebviewWindowBuilder::new(&handle, BOARD_WINDOW, tauri::WebviewUrl::App("index.html".into()))
            .title("Board")
            .inner_size(1100.0, 780.0)
            .min_inner_size(480.0, 360.0)
            .shadow(true);
        #[cfg(target_os = "macos")]
        let builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(8.0, 18.0));
        #[cfg(not(target_os = "macos"))]
        let builder = builder.decorations(false);
        if let Err(error) = builder.build() {
            if !matches!(error, tauri::Error::WebviewLabelAlreadyExists(_)) {
                eprintln!("board window: {error}");
            }
        }
    }).map_err(|error| error.to_string())
}

/// Hides the board window, keeping its page for the next time; the app window is told.
#[tauri::command]
pub(crate) fn board_window_hide(app: tauri::AppHandle) {
    hide_board_window(&app);
}

pub(crate) fn hide_board_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(BOARD_WINDOW) {
        let _ = window.hide();
    }
    let _ = app.emit_to("main", BOARD_WINDOW_HIDDEN_EVENT, ());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("mild-boards-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn boards_are_listed_written_read_and_deleted() {
        let folder = scratch("cycle");
        let root = folder.to_string_lossy().into_owned();
        fs::write(folder.join("A.py"), "print(1)").unwrap();
        let write = |filename: &str, text: &str| write_workspace_board(WriteBoardRequest { folder_path: root.clone(), filename: filename.into(), text: text.into() });
        write("contest/share.board", "{\"version\":1,\"strokes\":[]}").unwrap();
        write("Plan.BOARD", "{}").unwrap();
        assert_eq!(list_workspace_boards(BoardsRequest { folder_path: root.clone() }).unwrap(), vec!["contest/share.board", "Plan.BOARD"]);
        assert_eq!(read_workspace_board(BoardRequest { folder_path: root.clone(), filename: "contest/share.board".into() }).unwrap(), "{\"version\":1,\"strokes\":[]}");
        delete_workspace_board(BoardRequest { folder_path: root.clone(), filename: "Plan.BOARD".into() }).unwrap();
        assert_eq!(list_workspace_boards(BoardsRequest { folder_path: root.clone() }).unwrap(), vec!["contest/share.board"]);
        // Nothing half-written is left beside it.
        assert_eq!(fs::read_dir(folder.join("contest")).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn only_boards_inside_the_workspace() {
        let folder = scratch("refuse");
        let root = folder.to_string_lossy().into_owned();
        let write = |filename: &str| write_workspace_board(WriteBoardRequest { folder_path: root.clone(), filename: filename.into(), text: "{}".into() });
        assert!(write("A.py").is_err());
        assert!(write("../outside.board").is_err());
        assert!(write("/tmp/absolute.board").is_err());
        assert!(read_workspace_board(BoardRequest { folder_path: root.clone(), filename: "A.cpp".into() }).is_err());
        assert!(fs::read_dir(&folder).unwrap().next().is_none());
        let _ = fs::remove_dir_all(&folder);
    }
}
