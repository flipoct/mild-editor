# Changelog

## 1.4.0

- Add an interactive panel that runs the solution as a live process so you can play the interactor yourself, typing each response by hand.
- Stream program output as it is produced, including prompts printed without a trailing newline, and send EOF on demand.
- Remember the panel last used in each workspace in `.mild-editor.json`, defaulting to test cases.
- Reuse one compile step for both the test runner and interactive runs.
- Add the v1.3.0 Explorer commands to the native macOS menu bar: New Folder, Rename, Reveal in Finder, and Delete, with Return and Cmd+Backspace bound while an Explorer row has focus.
- Find toolchains on macOS that a GUI-launched app cannot see: `/opt/homebrew/bin`, `/usr/local/bin`, and `/opt/local/bin` are searched and `xcrun --find` is used as a fallback, so Homebrew, MacPorts, and Xcode installs of g++, Python, and clangd work without editing PATH.
- Let the Stop menu item end an interactive run as well as a test run.

## 1.3.0

- Discover existing C++ and Python source files recursively when a workspace is opened, while silently ignoring unsupported extensions.
- Add nested folders to Explorer with persistent expand/collapse state, recursive folder deletion, and working file/folder location actions.
- Add Explorer actions for creating files and folders in the selected directory, including context-menu support.
- Improve nested-file layout, path handling, active-file synchronization, and case-insensitive source extensions.
- Improve live Codeforces and AtCoder imports and correct sequential naming for newly created problems.

## 1.2.7

- Keep the Explorer highlight synchronized with the file currently shown in the editor, including tab switches and `Ctrl+W`.
- Add a themed scrollbar to Settings → Online Judge when its contents exceed the available height.
