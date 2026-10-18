//! Drawing boards: `.board` files in the workspace, drawn on instead of edited (src/board in
//! the frontend). A board is a JSON document of strokes; this side only lists, reads, writes
//! and deletes them, and checks that what it is asked about is a board inside the workspace.

use crate::workspace::{filename_key, metadata_lock, walk_workspace, workspace_relative_filename};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const BOARD_EXTENSION: &str = "board";

/// A board larger than this is not one the editor wrote; it is refused rather than loaded.
const MOST_BYTES: u64 = 32 * 1024 * 1024;

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
#[tauri::command]
pub(crate) fn list_workspace_boards(request: BoardsRequest) -> Result<Vec<String>, String> {
    let folder = PathBuf::from(&request.folder_path);
    let mut boards = Vec::new();
    walk_workspace(&folder, &folder, &mut |relative, is_directory| {
        if !is_directory && is_board(&relative) {
            boards.push(relative);
        }
    })?;
    boards.sort_by_key(|name| filename_key(name));
    Ok(boards)
}

#[tauri::command]
pub(crate) fn read_workspace_board(request: BoardRequest) -> Result<String, String> {
    let path = board_path(&request.folder_path, &request.filename)?;
    let size = fs::metadata(&path).map_err(|error| format!("Could not read the board: {error}"))?.len();
    if size > MOST_BYTES {
        return Err("The board is too large to open.".into());
    }
    fs::read_to_string(&path).map_err(|error| format!("Could not read the board: {error}"))
}

/// Writes beside the board and moves it over, so a board is never left half written.
#[tauri::command]
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

#[tauri::command]
pub(crate) fn delete_workspace_board(request: BoardRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    let path = board_path(&request.folder_path, &request.filename)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not delete the board: {error}")),
    }
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
