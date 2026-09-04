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
    // "Mild Editor", or "Mild Editor Dev" under tauri.dev.conf.json, so the two builds
    // can be told apart in the menu bar and the app switcher.
    let name = package.name.clone();

    let settings = MenuItemBuilder::with_id("app:settings", "Settings…")
        .accelerator("CmdOrCtrl+Comma")
        .build(app)?;
    // Routed through the frontend rather than `PredefinedMenuItem::quit` so the
    // unsaved-changes prompt still runs before the app exits.
    let quit = MenuItemBuilder::with_id("app:quit", format!("Quit {name}"))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let application = SubmenuBuilder::new(app, &name)
        .about(Some(
            AboutMetadata {
                name: Some(name.clone()),
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
    let new_folder = MenuItemBuilder::with_id("file:new-folder", "New Folder")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    // Rename and Delete deliberately carry no accelerator. A menu accelerator is
    // claimed application-wide, so binding Return or Cmd+Backspace here would take
    // them away from the code editor, where they insert a line and delete to the
    // start of one. The frontend binds both keys only while the Explorer has focus.
    let rename = MenuItemBuilder::with_id("file:rename", "Rename…").build(app)?;
    let reveal = MenuItemBuilder::with_id("file:reveal", "Reveal in Finder")
        .accelerator("CmdOrCtrl+Alt+R")
        .build(app)?;
    let delete = MenuItemBuilder::with_id("file:delete", "Delete").build(app)?;
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
        .item(&new_folder)
        .item(&open)
        .item(&save)
        .separator()
        .item(&rename)
        .item(&reveal)
        .item(&delete)
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
    // The side panel holds two modes and the menu bar is the only place a keyboard
    // user can reach the second one. Cmd+1..9 already switches editor tabs, so these
    // take the Option variant rather than a plain number.
    let panel_tests = MenuItemBuilder::with_id("view:panel-tests", "Test Cases")
        .accelerator("CmdOrCtrl+Alt+1")
        .build(app)?;
    let panel_interactive = MenuItemBuilder::with_id("view:panel-interactive", "Interactive")
        .accelerator("CmdOrCtrl+Alt+2")
        .build(app)?;

    let zoom_in = MenuItemBuilder::with_id("view:zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("view:zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("view:zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_explorer)
        .item(&toggle_tests)
        .separator()
        .item(&panel_tests)
        .item(&panel_interactive)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .fullscreen()
        .build()?;

    // Cmd+Return follows the panel on screen: tests, or the interactive runner when
    // that panel is showing. The two explicit items stay for when the other one is wanted.
    let run_active = MenuItemBuilder::with_id("run:active", "Run")
        .accelerator("CmdOrCtrl+Enter")
        .build(app)?;
    let run_tests = MenuItemBuilder::with_id("run:tests", "Run Tests").build(app)?;
    let run_interactive = MenuItemBuilder::with_id("run:interactive", "Start Interactive Run")
        .accelerator("CmdOrCtrl+Shift+Enter")
        .build(app)?;
    let stop = MenuItemBuilder::with_id("run:stop", "Stop")
        .accelerator("CmdOrCtrl+Period")
        .build(app)?;

    let run = SubmenuBuilder::new(app, "Run")
        .item(&run_active)
        .item(&run_tests)
        .item(&run_interactive)
        .separator()
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
