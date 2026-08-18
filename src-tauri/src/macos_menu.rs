//! Native macOS menu bar.
//!
//! macOS always draws a menu bar for the focused app, so without one the editor
//! shows an empty "Mild Editor" menu and loses the shortcuts the platform expects
//! (`Cmd+,` for settings, a real Edit menu, `Enter Full Screen`). Predefined items
//! keep their native behaviour; custom items emit [`MENU_EVENT`] so the frontend
//! can reuse the handlers the toolbar buttons already call.

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Runtime};

/// Event carrying the id of an activated custom menu item.
pub const MENU_EVENT: &str = "menu";

pub fn install<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let package = app.package_info();
    let version = package.version.to_string();

    let settings = MenuItemBuilder::with_id("app:settings", "Settings…")
        .accelerator("CmdOrCtrl+Comma")
        .build(app)?;
    // Routed through the frontend rather than `PredefinedMenuItem::quit` so the
    // unsaved-changes prompt still runs before the app exits.
    let quit = MenuItemBuilder::with_id("app:quit", "Quit Mild Editor")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let application = SubmenuBuilder::new(app, "Mild Editor")
        .about(Some(
            AboutMetadata {
                name: Some("Mild Editor".into()),
                version: Some(version),
                comments: Some("A lightweight competitive programming editor".into()),
                ..Default::default()
            },
        ))
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;

    let new_file = MenuItemBuilder::with_id("file:new", "New File")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open = MenuItemBuilder::with_id("file:open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id("file:save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let import = MenuItemBuilder::with_id("file:import", "Import Problem…")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("file:close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&new_file)
        .item(&open)
        .item(&save)
        .separator()
        .item(&import)
        .separator()
        .item(&close_tab)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let toggle_explorer = MenuItemBuilder::with_id("view:toggle-explorer", "Toggle File Explorer")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let toggle_tests = MenuItemBuilder::with_id("view:toggle-tests", "Toggle Test Panel")
        .accelerator("CmdOrCtrl+Shift+B")
        .build(app)?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_explorer)
        .item(&toggle_tests)
        .separator()
        .fullscreen()
        .build()?;

    let run_tests = MenuItemBuilder::with_id("run:tests", "Run Tests")
        .accelerator("CmdOrCtrl+Enter")
        .build(app)?;
    let stop = MenuItemBuilder::with_id("run:stop", "Stop")
        .accelerator("CmdOrCtrl+Period")
        .build(app)?;

    let run = SubmenuBuilder::new(app, "Run")
        .item(&run_tests)
        .item(&stop)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&application, &file, &edit, &view, &run, &window])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn forward_event<R: Runtime>(app: &tauri::AppHandle<R>, event: tauri::menu::MenuEvent) {
    let _ = app.emit(MENU_EVENT, event.id().0.clone());
}
