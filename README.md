# Mild Editor

A focused competitive-programming editor for C++ and Python 3. Import problems and sample test cases directly from **AtCoder**, **Codeforces**, and **doj.kr**, then code, run tests, and organize an entire contest in one workspace.

## Download

[Download the latest Mild Editor release](https://github.com/flipoct/mild-editor/releases/latest) for Windows, macOS, or Linux.

Windows releases include both an installer and a portable executable. The portable build has the same editor features, requires no installation, and can display the theme-aware runtime icon without the installed app identity overriding it.

On macOS, Mild Editor is ad-hoc signed for direct distribution. On first launch, you may need to approve it in **System Settings → Privacy & Security** because the release is not notarized with a paid Apple Developer account.

## Quick development preview

Run `dev.cmd` or `npm run quick` to open the development app without building an installer. Frontend changes reload automatically. Rust/Tauri changes trigger a backend rebuild and app restart.

```bash
npm install
npm run quick
```

Install `g++` and Python 3 and make both commands available on PATH to execute local tests.

On macOS the bundled app is started by launchd, which hands it only `/usr/bin:/bin:/usr/sbin:/sbin`. Mild Editor therefore also searches `/opt/homebrew/bin`, `/usr/local/bin`, and `/opt/local/bin`, and falls back to `xcrun --find`, so a toolchain installed through Homebrew, MacPorts, or the Xcode Command Line Tools is found without editing PATH.

## Workspace format and saving

Create a workspace once, then create or import files inside it. File operations, test cases, language changes, and workspace metadata are saved automatically. Source-body edits remain marked as modified until you press `Save` / `Ctrl+S` or run the tests.

```text
contest-folder/
├─ A.cpp
├─ B.cpp
├─ C.py
└─ .mild-editor.json  # file list, languages, origins, order metadata, and test cases
```

`Open` accepts `.mild-editor.json` or a supported source file. Opening a workspace restores the saved file list; only the tabs that were open in the previous session are reopened.

## Problem import

`Import` supports AtCoder, Codeforces, and doj.kr problem URLs. AtCoder and Codeforces contest URLs import their listed problems. Imported sample tests are stored with the workspace.

`use output` copies the latest program output into the expected-output field.

### Competitive Companion

Mild Editor listens for the [Competitive Companion](https://github.com/jmerle/competitive-companion) browser extension on `127.0.0.1:10043`, the same port cph uses. Open a problem on any judge the extension supports, press its button, and the file and its sample tests are created in the current workspace. Parsing a whole contest arrives as one batch and imports in a single step.

The listener is on by default and is confined to the loopback interface. Toggle it or change the port in **Settings → online judges**; the status bar shows `CC listening` while it is bound.

## Verdicts and diffs

Each test reports a competitive-programming verdict: `AC`, `WA`, `TLE`, `RE`, or `CE`. A wrong answer shows a line-by-line comparison of expected versus actual output instead of a plain text box, with mismatched lines highlighted and whitespace-only differences called out separately. Press `raw output` to switch back to the unformatted stream.

## Snippets

Open **Settings → Snippets**, create a snippet name, select C++ or Python, write the snippet body in Monaco, and press **Save snippet**. Snippets are stored locally on the current device.

There are two ways to insert a snippet into a file:

- Select it from the snippet menu in the title bar, then press **Insert**.
- Type `snippet::name` in an editor using the same language, then accept the completion with Tab or Enter.

Snippet bodies support Monaco placeholder syntax. `${1:value}` creates the first editable field, repeated placeholder numbers stay synchronized, and `${0}` marks the final cursor position after tabbing through the fields. Place the editor caret and press **Set cursor here** to insert or move `${0}` automatically.

## Templates and themes

Templates are stored separately by judge and language. Besides filename, platform, date, and time variables, `${cursor}` controls the initial caret position in a newly created file. Use **Set cursor here** in the template editor to place it without typing the marker.

The full interface and Monaco Editor share the selected palette. Mild Editor includes Pastel Dusk, Catppuccin Mocha, Rosé Pine Dawn, Dracula, Gruvbox Dark, Nord, and Tokyo Night.

## IntelliSense

Mild Editor includes lightweight C++ and Python completions. If `clangd` is installed, the app connects it to Monaco for C++ semantic completion, diagnostics, hover information, and signature help. The compiler path is passed as a query driver when available. Open the language-server settings from the status bar to configure a custom clangd path.

## macOS

The macOS build uses the system window chrome: native traffic lights sit over the title bar, the green button enters real full screen, and the app installs a standard menu bar.

| Shortcut | Action |
| --- | --- |
| `⌘N` / `⌘O` / `⌘S` | New file / Open / Save |
| `⌘T` | Import problem |
| `⌘W` | Close tab |
| `⌘1`–`⌘9` | Switch to tab |
| `⌘↵` / `⌘.` | Run tests / Stop |
| `⌘⇧↵` | Start an interactive run |
| `⌘⌥1` / `⌘⌥2` | Show the test cases / interactive panel |
| `⌘B` / `⌘⇧B` | Toggle file explorer / test panel |
| `⌘⇧N` | New folder in the selected Explorer directory |
| `⌥⌘R` | Reveal the selected file or folder in Finder |
| `↩` | Rename the selected Explorer file |
| `⌘⌫` | Delete the selected Explorer file or folder |
| `⌘,` | Settings |
| `⌃⌘F` | Full screen |

Inside the interactive panel, `↩` sends a line, `⇧↩` adds one, and `⌃D` closes the program's input the way it would in a terminal.

`↩` and `⌘⌫` apply only while an Explorer row has focus, so the editor keeps them for inserting a line and deleting to the start of one. The File menu lists Rename, Reveal in Finder, and Delete without accelerators for the same reason. Windows and Linux keep `F2` for renaming.

The Edit menu restores the standard macOS text-editing shortcuts, and the editor defaults to SF Mono with Menlo and Monaco also offered in **Settings → appearance**. Windows and Linux keep their existing custom title bar and `Ctrl`-based shortcuts.

## Build locally

```bash
npm run tauri:build
```

Native bundles are generated under `src-tauri/target/release/bundle`. GitHub Actions builds Windows, macOS, and Linux packages on their native runners and attaches them to the matching release.

> The local runner is intended for personal use with trusted code. Use an isolated sandbox before exposing code execution to untrusted users.
