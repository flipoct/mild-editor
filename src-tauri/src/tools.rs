//! Finding the developer tools the editor drives: the compiler, the interpreter, clangd.

use std::process::Command;

/// Extra directories searched for developer tools.
///
/// launchd hands a GUI-launched `.app` the bare `/usr/bin:/bin:/usr/sbin:/sbin`,
/// so a toolchain installed by Homebrew or MacPorts is invisible to the editor
/// even though the same command works in the user's terminal. Windows and Linux
/// inherit a usable `PATH` from the desktop session and need no extras.
#[cfg(target_os = "macos")]
const EXTRA_TOOL_DIRECTORIES: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];

#[cfg(not(target_os = "macos"))]
const EXTRA_TOOL_DIRECTORIES: &[&str] = &[];

/// The inherited `PATH` with [`EXTRA_TOOL_DIRECTORIES`] appended.
///
/// Entries already present keep their original priority, so a tool the session
/// exposes still wins over the same tool in a fallback directory.
pub(crate) fn tool_search_path() -> std::ffi::OsString {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let mut entries: Vec<std::path::PathBuf> = std::env::split_paths(&inherited).collect();
    for extra in EXTRA_TOOL_DIRECTORIES {
        let extra = std::path::PathBuf::from(extra);
        if !entries.contains(&extra) {
            entries.push(extra);
        }
    }
    std::env::join_paths(entries).unwrap_or(inherited)
}

/// Resolves `name` against [`tool_search_path`], falling back to the active
/// Xcode toolchain where `clangd` and friends ship inside the developer
/// directory rather than on `PATH`.
pub(crate) fn find_tool(name: &str) -> Option<std::path::PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
    if let Ok(path) = which::which_in(name, Some(tool_search_path()), cwd) {
        return Some(path);
    }
    toolchain_tool(name)
}

/// Asks `xcrun` for a tool inside the selected Xcode or Command Line Tools
/// installation. Returns `None` when neither is installed.
#[cfg(target_os = "macos")]
fn toolchain_tool(name: &str) -> Option<std::path::PathBuf> {
    let output = Command::new("/usr/bin/xcrun").arg("--find").arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = std::path::PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    path.is_file().then_some(path)
}

/// Only macOS hides tools behind a developer directory; elsewhere `PATH` is the
/// whole story.
#[cfg(not(target_os = "macos"))]
fn toolchain_tool(_name: &str) -> Option<std::path::PathBuf> {
    None
}

#[cfg(windows)]
pub(crate) trait CommandExtHidden {
    fn creation_flags(&mut self, flags: u32) -> &mut Self;
}

#[cfg(windows)]
impl CommandExtHidden for Command {
    fn creation_flags(&mut self, flags: u32) -> &mut Self {
        use std::os::windows::process::CommandExt;
        CommandExt::creation_flags(self, flags)
    }
}

#[cfg(not(windows))]
pub(crate) trait CommandExtHidden {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self;
}

#[cfg(not(windows))]
impl CommandExtHidden for Command {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self {
        self
    }
}

/// What a tool wrote, as text. Compilers and interpreters write UTF-8, but a message Windows
/// itself hands them — why a system call failed — arrives in the system code page, and read
/// as UTF-8 it is a row of replacement characters. Lines that are not UTF-8 are read in that
/// code page instead; everything else passes through untouched.
pub(crate) fn decode_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => bytes
            .split_inclusive(|byte| *byte == b'\n')
            .map(|line| match std::str::from_utf8(line) {
                Ok(text) => text.to_owned(),
                Err(_) => from_system_code_page(line).unwrap_or_else(|| String::from_utf8_lossy(line).into_owned()),
            })
            .collect(),
    }
}

#[cfg(windows)]
fn from_system_code_page(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_ACP, MB_ERR_INVALID_CHARS};
    let length = i32::try_from(bytes.len()).ok().filter(|length| *length > 0)?;
    let mut wide = vec![0u16; bytes.len()];
    // SAFETY: both buffers are live for the call and their lengths are the ones passed.
    let written = unsafe { MultiByteToWideChar(CP_ACP, MB_ERR_INVALID_CHARS, bytes.as_ptr(), length, wide.as_mut_ptr(), length) };
    (written > 0).then(|| String::from_utf16_lossy(&wide[..written as usize]))
}

#[cfg(not(windows))]
fn from_system_code_page(_bytes: &[u8]) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_search_path_appends_fallbacks_after_the_inherited_path() {
        let entries: Vec<std::path::PathBuf> = std::env::split_paths(&tool_search_path()).collect();
        let inherited: Vec<std::path::PathBuf> = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();
        assert!(entries.starts_with(&inherited), "inherited PATH must keep its priority");
        for extra in EXTRA_TOOL_DIRECTORIES {
            assert!(entries.iter().any(|entry| entry == std::path::Path::new(extra)), "{extra} is missing from the search path");
        }
    }

    #[test]
    #[cfg_attr(windows, ignore = "requires a POSIX shell")]
    fn find_tool_resolves_an_executable_on_the_search_path() {
        assert!(find_tool("sh").is_some());
    }

    #[test]
    fn output_that_is_utf8_is_left_as_it_is() {
        assert_eq!(decode_output("main.cpp:1: 오류\n".as_bytes()), "main.cpp:1: 오류\n");
        assert_eq!(decode_output(b""), "");
    }

    #[test]
    fn only_the_lines_that_are_not_utf8_are_read_in_the_system_code_page() {
        // 0xFF is no character in UTF-8, nor a lead byte in any Windows code page worth
        // the name: the line still comes back as text, and its neighbours are untouched.
        let decoded = decode_output(b"first \xec\x98\xa4\nbroken \xff here\nlast\n");
        assert!(decoded.starts_with("first 오\nbroken "));
        assert!(decoded.ends_with(" here\nlast\n"));
    }

    #[cfg(windows)]
    #[test]
    fn a_message_in_the_system_code_page_is_read_back() {
        use windows_sys::Win32::Globalization::GetACP;
        // CP949 only: the bytes below are "주소" in it.
        if unsafe { GetACP() } != 949 { return; }
        assert_eq!(decode_output(b"MapViewOfFileEx: \xc1\xd6\xbc\xd2.\n"), "MapViewOfFileEx: 주소.\n");
    }

    #[test]
    fn find_tool_reports_a_missing_executable() {
        assert!(find_tool("mild-editor-nonexistent-tool").is_none());
    }
}
