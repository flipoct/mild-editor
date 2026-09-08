# Mild Editor

A focused competitive-programming editor for C++ and Python 3. Import problems and sample test cases directly from **AtCoder**, **Codeforces**, and **doj.kr**, then code, run tests, and organize an entire contest in one workspace.

## Download

[Download the latest Mild Editor release](https://github.com/flipoct/mild-editor/releases/latest) for Windows, macOS, or Linux.

Windows releases include both an installer and a portable executable. The portable build has the same editor features, requires no installation, and can display the theme-aware runtime icon without the installed app identity overriding it.

On macOS, Mild Editor is ad-hoc signed for direct distribution. On first launch, you may need to approve it in **System Settings → Privacy & Security** because the release is not notarized with a paid Apple Developer account.

## Updates

Mild Editor checks the latest GitHub release a few seconds after it starts. When a newer version exists, a notice offers **update and restart**: the update downloads in the background, is verified against the public key built into the app, and the app relaunches into the new version. **Settings → updates** shows the running version, a manual check, and the release notes. Release assets are signed in CI with `TAURI_SIGNING_PRIVATE_KEY`; the matching public key lives in `src-tauri/tauri.conf.json`.

## Quick development preview

Run `dev.cmd` or `npm run quick` to open the development app without building an installer. Frontend changes reload automatically. Rust/Tauri changes trigger a backend rebuild and app restart.

The development app runs as **Mild Editor Dev** (`src-tauri/tauri.dev.conf.json`): its own name in the menu bar and app switcher, a `dev` badge in the title bar, a separate settings store, and no update checks, so it never gets mixed up with an installed release.

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

Mild Editor listens for the [Competitive Companion](https://github.com/jmerle/competitive-companion) browser extension on `127.0.0.1:10043`, the same port cph uses. Open a problem on any judge the extension supports, press its button, and the file and its sample tests are created in the current workspace. Parsing a whole contest arrives as one batch and imports in a single step. The extension is built into the problem panel as well, where the panel's `import` button stands in for its toolbar button; the listener is the same either way, so the extension in your everyday browser keeps working.

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
| `⌘↵` / `⌘.` | Run the panel on screen (tests, or interactive when that panel is showing) / Stop |
| `⌘⇧↵` | Start an interactive run |
| `⌘⌥1` / `⌘⌥2` | Show the test cases / interactive panel |
| `⌘=` / `⌘-` / `⌘0` | Zoom the interface in / out / back to 100% |
| `⌘B` / `⌘⇧B` | Toggle file explorer / test panel |
| `⌘⇧N` | New folder in the selected Explorer directory |
| `⌥⌘R` | Reveal the selected file or folder in Finder |
| `↩` | Rename the selected Explorer file or folder in place |
| `⌘⌫` | Delete the selected Explorer file or folder |
| `⌘,` | Settings |
| `⌃⌘F` | Full screen |

The interface scale is also in **Settings → appearance**, next to a code font size in px that sizes only the editor text, and the same `Ctrl` shortcuts work on Windows and Linux. The default language for imported problems and new files is in **Settings → online judge**; while no file is open, the language menu in the status bar changes it too.

Inside the interactive panel, `↩` sends a line, `⇧↩` adds one, and `⌃D` closes the program's input the way it would in a terminal.

`↩` and `⌘⌫` apply only while an Explorer row has focus, so the editor keeps them for inserting a line and deleting to the start of one. The File menu lists Rename, Reveal in Finder, and Delete without accelerators for the same reason. Windows and Linux keep `F2` for renaming.

Renaming happens in the row itself: the name turns into a text field with everything selected, `↩` commits, `Esc` cancels, and a name typed without an extension takes the default language's. Folders rename the same way and carry their files along.

The Edit menu restores the standard macOS text-editing shortcuts, and the editor defaults to SF Mono with Menlo and Monaco also offered in **Settings → appearance**. Windows and Linux keep their existing custom title bar and `Ctrl`-based shortcuts.

## Problem panel (embedded Chromium)

The problem panel is a real Chromium (CEF) hosted inside the editor window, so Chrome extensions run against the problem page. It is pinned to CEF 151.3.24: 152.0.5 hangs every network request on macOS 26, verified against CEF's own sample.

The panel's `import` button turns the page you are reading into a file with its sample tests, and a contest page imports every problem at once. It asks Competitive Companion to parse the page, so every judge the extension supports works; without it the built-in importer handles AtCoder, Codeforces and doj.kr. The panel is a native view layered over the window, so it is hidden automatically while a dialog or menu is open.

Development needs the CEF binaries and a build tool the `cef` crate expects:

```bash
brew install ninja                                   # cef-dll-sys builds libcef_dll_wrapper with Ninja
git clone https://github.com/tauri-apps/cef-rs && cd cef-rs && git checkout cef-v151.8.1+151.3.24
cargo run -p export-cef-dir -- --force ~/.local/share/cef   # add --target <triple> to cross-build
export CEF_PATH=~/.local/share/cef                   # read by the cef crate's build script; prepare-cef.sh defaults to this path

npm run dev:cef      # tauri dev with the CEF layer (runs scripts/prepare-cef.sh debug first)
npm run build:cef    # tauri build with the CEF layer (framework + helpers bundled)
```

The sub-process helper is its own package, `src-tauri/cef-helper`, rather than a second binary of the app: the macOS bundler copies every binary of a package into `Contents/MacOS`, where a second helper is useless and, cross-compiled to Intel, unsigned — the linker ad-hoc signs arm64 binaries but not cross-built x86_64 ones, and `codesign` refuses to sign a bundle whose nested code is unsigned. It is a workspace member, so it shares the target directory and CEF is compiled once.

The CEF layer lives in `src-tauri/tauri.cef.conf.json` and is opt-in: the Tauri build script validates every bundled framework and resource path at compile time, so listing CEF in the always-on config would break builds that do not have it. Plain `npm run dev` / `npm run tauri:build` still work and ship an app whose problem panel reports itself unavailable. The panel is macOS-only for now; the Windows code path exists but the installer does not yet ship CEF next to the executable.

Three extensions come with the app. Competitive Companion is bundled in `src-tauri/extensions` (a build that also parses doj.kr) and unpacked into the profile at start-up; Carrot and Tampermonkey are downloaded from the Web Store the first time the app runs. **Settings → problem browser** installs AtCoder Better! into Tampermonkey with one click, and takes a Chrome Web Store link or extension id for anything else: the app downloads the `.crx`, unpacks it into its profile and loads it on the next start (the page offers a restart).

Two Chromium behaviours needed work to run extensions in a hosted view. The bundled Competitive Companion is patched at install with a small bridge (`mild-bridge-*`), because an embedded view has no toolbar for its button; the editor's `import` button fires the extension's own click handler through it. And `chrome.tabs.create`, which Tampermonkey uses for its install dialog, needs a Chrome window, so the app keeps a hidden one: tabs opened there are cancelled and their page is loaded in the panel instead. Chrome 138+ also gates `chrome.userScripts` behind a per-extension preference, which the app writes for Tampermonkey at start-up.

The framework is single-architecture, so a cross-build needs CEF for the target it is bundling: `export-cef-dir --target x86_64-apple-darwin` and `scripts/prepare-cef.sh release x86_64-apple-darwin`, which also builds the helper for that target. Passing a target whose architecture does not match `CEF_PATH` stops with an explanation rather than producing an app that cannot run.

Useful switches while developing: `MILD_CEF_DEBUG_PORT=9336` opens the DevTools protocol on the panel, `MILD_CEF_EXTENSIONS=/path/a,/path/b` loads unpacked extensions, and `VITE_PROBLEM_PANEL_OPEN=1` / `VITE_PROBLEM_PANEL_URL=…` open and seed the panel on first run.

## Build locally

```bash
npm run tauri:build
```

Native bundles are generated under `src-tauri/target/release/bundle`. GitHub Actions builds Windows, macOS, and Linux packages on their native runners and attaches them to the matching release.

> The local runner is intended for personal use with trusted code. Use an isolated sandbox before exposing code execution to untrusted users.
