# Changelog

## Unreleased

- Language marks. The `C++` and `Py` badges beside a filename are now the official C++ and Python logos, from [Simple Icons](https://simpleicons.org) under CC0, in the theme's own language colours.
- Arrange files by hand. Dropping a row between two others in the explorer puts it there and switches the sort to **my order**, which is saved with the workspace. Dropping it on a folder still just moves it.
- Files added, renamed or deleted outside the editor are picked up. `.mild-editor.json` was only reconciled with the folder when the workspace opened, so anything another program put there stayed invisible until a restart; the explorer now rescans when the window comes back into focus, and its header has a button for it.
- `Ctrl+Shift+T` (`⌘⇧T`) reopens the tab closed last. `Del` deletes the selected explorer row on Windows and Linux, as `⌘⌫` already did on macOS.
- After an update installs, the new build opens with the release notes of the version it just became.
- **Find a counterexample.** Beside *Add test*: a generator and a reference solution run against the open file on random inputs until their answers differ, and the case that separated them can be kept as a test. Both helpers are files named after the problem — `B_Exit_Order_generator.cpp`, `B_Exit_Order_bruteforce.cpp`. Each dropdown starts on the one already written, in either language, or on **Create**, which makes it when the search is started and not before. Outputs are compared by the same rule the test cases use.
- `Ctrl+P` (`⌘P`) opens a file by name, which beats scrolling an explorer with hundreds of problems in it.
- **Settings → updates → backup** exports snippets, templates, themes, judge handles and compile flags to one file, and imports them back. They lived only in the app's own storage, which no backup reached and a reinstall could empty.
- Every verdict a judge reports is kept with the problem, not just the latest. The contest board marks rejected tries on each problem and the footer totals the ICPC penalty.

## 1.12.0

- Move files and folders. Drag a row of the explorer onto a folder (or onto the empty space, for the workspace root), or use **Move to…** in its context menu. Open tabs, saved tests, folded folders and a running contest's solve times follow the move.
- A contest no longer needs a workspace of its own. **Start a contest** now asks which folder the problems come from and shows them; click one to leave it out. Problems imported into the folder later still join.
- Submission results are announced. When the judge's verdict on a new submission arrives, a notice appears in the editor whichever file is open; clicking it opens that problem. Results already there when a problem is first seen are not announced.
- The contest board stays inside its popover: a long folder name in the footer used to stretch the board past it. Problems already accepted before the clock started are no longer marked solved at 0:00:00; only a newer submission counts.
- On Windows the close button answers from the very corner of the screen. A window that started maximised kept a resize border along the top edge, which took the pointer before the title bar could.
- The delete button on explorer rows is gone; **Delete** stays in the context menu and on the keyboard.

## 1.11.1

- DOJ's submit dialog is filled again: the site moved to a CodeMirror build that hangs the editor off the content element as `cmTile` instead of `cmView`, so the source was not placed and a real submit stopped at the *source* check.
- The panel's import button tells Competitive Companion which port this copy of the editor listens on, and the extension posts there and nowhere else. Before, the extension only posted to its built-in ports, so a port set in **Settings → online judges** was ignored, and with two copies of the editor open the other one could receive the problem.
- A rewritten Competitive Companion bridge takes effect on the next start. Chromium kept serving the previously registered worker, so an updated bridge kept running the old code until the profile was cleared.

## 1.11.0

- `Ctrl+Shift+Enter` (`⌘⇧↵` on macOS) submits the file to its judge, the same as **Submit** in the title bar; *Run → Submit* on the macOS menu. Starting an interactive run moved to `Ctrl+Alt+Enter` (`⌘⌥↵`).
- **Really submit** in **Settings → online judges**, off by default. On, a submission does not stop at the filled form: the editor checks that the form holds this problem, a language of the file's family and the file's exact source, then presses the judge's own submit button and reports the result in the status bar. A check that fails presses nothing and says which one. AtCoder, Codeforces and DOJ.
- Submitting to DOJ opens its submit dialog and fills the editor and language there, instead of expecting the dialog to be open already.

## 1.10.0

- A redesigned interface. One set of design tokens drives every surface, so the seven themes reach all of it; text is no smaller than 11px and monospace is kept for code and test data; glyph buttons are replaced by one icon set. The title bar shows the workspace and file as a breadcrumb and gains **Run** and **Submit**; tabs size to their names and carry a language badge; test cases are cards with the status on the left and the verdict on the right; the Explorer's new-file and new-folder buttons moved into its header; Settings has a sidebar instead of a row of tabs.
- Per-problem limits. The time and memory limits Competitive Companion reports are stored with the file and used by the runner, and both can be edited above the test cases. Each test shows its peak memory beside its time, and a run past the memory limit is an `MLE`.
- Floating-point tolerance. When the expected output holds a decimal, an answer within an absolute or relative error of 1e-6 is accepted; integers, words and spacing are compared exactly as before. **Settings → build & judging** changes the tolerance or turns it off.
- Compile profiles. **Release** (`-O2`) and **Debug** (checked containers, warnings, `-DLOCAL`, and the sanitizers where the toolchain has them) are one click apart in the status bar, and their flags are editable in **Settings → build & judging**. A Debug run gets three times the time limit.
- `bits/stdc++.h` is precompiled once per compiler and profile and reused, which takes a typical compile from seconds to a fraction of one. GCC only.
- Compiler warnings from a successful build are marked in the editor, and a sanitizer report or a Python exception marks the line it names without hiding the test's output.
- **Submit** opens the judge's own submit page in the problem browser with the problem, language and source filled in (AtCoder and Codeforces); you review it and press the judge's button. For other judges the solution is copied to the clipboard and the problem page opens.
- A DOJ contest URL (`doj.kr/ko/contests/<slug>`) imports the whole contest, lettered `A`, `B`, … in the contest's own order and filed under the contest's name, like AtCoder and Codeforces. DOJ shows a running contest's problems only to a logged-in participant, so this covers contests whose problems are public.
- **Submit** also fills DOJ's form, which sits on the problem page itself, and works with the problem browser in its own window.
- Contest mode. The timer in the status bar starts a countdown and opens a board of the problems in the current folder; a problem is marked solved, with its time, when the judge reports AC.

## 1.9.1

- In window mode, switching to another file changes the page in the problem window without bringing the window forward or taking the keyboard from the editor. A page that finishes loading no longer takes focus either, in the panel or the window.
- Browser shortcuts work with the problem page focused: `Ctrl`/`Alt` with the left and right arrows go back and forward, `F5` and `Ctrl+R` reload, and `Ctrl+F5`, `Shift+F5` or `Ctrl+Shift+R` reload past the cache. (`⌘` in place of `Ctrl` on macOS.)

## 1.9.0

- The problem browser can be a window of its own. **Settings → problem browser → placement** switches between the panel in the workspace and a separate window with the app's own title bar, which can go on another screen; the status-bar chip, *View → Problem Browser* and `Ctrl+W` show and hide it either way, and the window carries the same toolbar and import button.
- `Ctrl+W` closes what has the keyboard: the problem browser when its page or URL field is focused, otherwise the file in the editor, and typing resumes in the file that takes its place.
- Panel dividers are twice as wide to grab, and the strip over the problem page, which the native view used to cover, can be grabbed too.
- Dragging a divider moves it as far as the pointer moves. It used to run ahead by the number of panels' worth of weight, so the problem panel shot across the window from a small drag.
- **Settings → problem browser** scrolls, so a long extension list no longer runs off the page.
- Windows: `npm run build:cef:win` runs its staging script through Windows PowerShell rather than `pwsh`, which not every machine has.

## 1.8.1

- macOS: open in full screen instead of a window sized to part of the display. The `maximized` setting in the window config has no effect on an undecorated macOS window, so it opened at 1280×800 in the middle of the screen every time.

## 1.8.0

- Panels can be stacked as well as placed side by side. The workspace is now a set of columns, each holding one or more panels top to bottom, so the problem page can sit under the code rather than beside it.
- Drag a panel by the grip in its top-left corner, or by its chip in the status bar, and drop it against the edge of another panel: the left or right half puts it in a column of its own, the top or bottom half stacks it in that panel's column.
- Resize in both directions. The divider between two columns still sets their widths, and a new divider between stacked panels sets their heights. A pair keeps its combined size, so the rest of the workspace does not move.
- The layout popover is gone: dragging covers every move it offered. The status-bar chips are now only for showing and hiding panels, and **Settings → appearance** (or *View → Reset Panel Layout* on macOS) restores the default arrangement.
- Panel sizes are now shares of the window rather than pixel widths, so a layout keeps its proportions when the window is resized. Widths set in an earlier version are carried over once.
- The problem panel comes to Windows. The installer ships the embedded Chromium next to the executable, so the panel, its import button and the extensions work as on macOS; the portable build becomes a zip with the runtime beside the exe. Chromium derives an unpacked extension's id from the UTF-16 form of its path on Windows, and the editor now does the same, so Tampermonkey's user-script switch lands on the right extension there.
- Closing a tab with `Ctrl+W` now returns to the tab that was active before it, and to the left neighbour when there is none, instead of jumping right except at the end of the strip.
- The problem panel and the panel chips follow the selected theme. They had shipped with their own fixed greys, so a light theme left a dark toolbar.

## 1.7.1

- Add **file imports into folders** in **Settings → online judges**, off by default. With it on, an imported problem is filed under its judge — `AtCoder/C_Remove_and_Append.py` — and a contest gets a folder of its own inside it, so a whole contest arrives as `Codeforces/Codeforces Round 1117 (Div. 2)/A_Watermelon.py`. Problems from the import dialog, from a contest URL and from Competitive Companion all follow the setting. Files already saved stay where they are.
- Show only the file name on a tab, with the full path in its tooltip, so a file inside a folder does not stretch the tab strip.
- The development build now works in its own scratch folder instead of whatever workspace was last opened, so trying an import while developing cannot write into real work.

## 1.7.0

- Add a problem panel: a real Chromium window inside the editor that opens the problem page next to the code, with back, forward, reload and an address field. It follows the file you are on, so opening an imported problem shows its page.
- Ship the judge extensions with the app. Competitive Companion (a build that also parses doj.kr) is built in, and Carrot and Tampermonkey are installed on the first start. **Settings → problem browser** installs AtCoder Better! into Tampermonkey with one click, and any other Chrome Web Store extension by link or id.
- Import from the panel with its `import` button: the page you are reading becomes a file with its sample tests, and a contest page imports every problem at once. Without the extension the built-in importer still handles AtCoder, Codeforces and doj.kr.
- Arrange the workspace panels in any order and fold each of them away, from the `⇄` button in the status bar or `Alt`+`←`/`→` on a panel chip. The order is remembered.
- Set the code font size in pixels in **Settings → appearance**, independently of the interface scale.
- macOS: the problem panel is bundled with the app, so it works in the installed release with no extra setup. Windows and Linux show the panel as unavailable for now.

## 1.6.2

- Fix update checks that failed with a network error on some connections: GitHub hands out four addresses for its release host and the check gave up after 15 seconds, while an unreachable address alone costs 21 seconds to abandon. Each connection attempt is now capped, so the next address is tried and the check finishes in about a second.
- Apply the same cap to problem imports and judge-status refreshes, which could stall the same way when a judge's hostname has an unreachable address.

## 1.6.1

- Stamp new files with local time: `[[timestamp]]`, `[[createdAt]]`, and `[[date]]` were written in UTC while `[[time]]` was local, so in Korea a header ran nine hours behind and, between midnight and 09:00, dated the file to the previous day.

## 1.6.0

- Update from inside the app: Mild Editor checks the latest release when it starts, and one click downloads, verifies, installs, and restarts into the new version. Settings → updates has a manual check and the release notes.
- Run the development build as "Mild Editor Dev" with its own settings store and a dev badge, so it is never confused with an installed release.
- Show the version the running binary carries in the status bar and the updates page.
- Sign release artifacts and publish latest.json so installed copies can find and verify updates; macOS builds now produce the updater bundle alongside the dmg.

## 1.5.0

- Add a default language for imported problems, including Competitive Companion, and for new files created without an extension; the status-bar language menu edits it while no file is open.
- Rename files and folders in place in the Explorer: Return (macOS) or F2 turns the row into a text field with the name selected, and a bare name takes the default language's extension.
- Run whatever panel is showing with Cmd/Ctrl+Return — the test cases or the interactive runner — including from inside the editor.
- Keep the Explorer context menu on screen when it opens near the right or bottom edge.
- Add an interface scale from 50% to 200% in Settings → appearance and on Cmd/Ctrl+= / − / 0, with matching macOS View menu items.
- macOS: keep the title bar at its native height under interface zoom and centre the traffic lights in it.
- macOS: Explorer rows take focus on click, so Return, F2, Cmd+Backspace, and Reveal in Finder act on the clicked row.

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
