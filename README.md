# Mild Editor

A focused competitive-programming editor for C++ and Python 3. Import problems and sample test cases directly from **AtCoder**, **Codeforces**, and **doj.kr**, then code, run tests, and organize an entire contest in one workspace.

## Download

[Download the latest Mild Editor release](https://github.com/flipoct/mild-editor/releases/latest) for Windows, macOS, or Linux.

On macOS, Mild Editor is ad-hoc signed for direct distribution. On first launch, you may need to approve it in **System Settings → Privacy & Security** because the release is not notarized with a paid Apple Developer account.

## Quick development preview

Run `dev.cmd` or `npm run quick` to open the development app without building an installer. Frontend changes reload automatically. Rust/Tauri changes trigger a backend rebuild and app restart.

```bash
npm install
npm run quick
```

Install `g++` and Python 3 and make both commands available on PATH to execute local tests.

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

## Snippets

Open **Settings → Snippets**, create a snippet name, select C++ or Python, write the snippet body in Monaco, and press **Save snippet**. Snippets are stored locally on the current device.

There are two ways to insert a snippet into a file:

- Select it from the snippet menu in the title bar, then press **Insert**.
- Type `snippet::name` in an editor using the same language, then accept the completion with Tab or Enter.

Snippet bodies support Monaco placeholder syntax. `${1:value}` creates the first editable field, repeated placeholder numbers stay synchronized, and `${0}` marks the final cursor position after tabbing through the fields.

## IntelliSense

Mild Editor includes lightweight C++ and Python completions. If `clangd` is installed, the app connects it to Monaco for C++ semantic completion, diagnostics, hover information, and signature help. The compiler path is passed as a query driver when available. Open the language-server settings from the status bar to configure a custom clangd path.

## Build locally

```bash
npm run tauri:build
```

Native bundles are generated under `src-tauri/target/release/bundle`. GitHub Actions builds Windows, macOS, and Linux packages on their native runners and attaches them to the matching release.

> The local runner is intended for personal use with trusted code. Use an isolated sandbox before exposing code execution to untrusted users.
