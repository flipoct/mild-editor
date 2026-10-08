//! A precompiled `bits/stdc++.h`, which takes most of the compile time out of a typical
//! contest solution.
//!
//! GCC looks for `<name>.gch` in every include directory before the header itself, so a
//! directory holding nothing but `bits/stdc++.h.gch`, put first on the include path, is all
//! it takes. A header compiled with other flags is rejected by GCC and the real one is used,
//! so a stale cache costs time, never correctness. One directory is kept per compiler,
//! standard and flag set.
//!
//! The one header GCC does not quietly skip is one it cannot map back into memory: it has to
//! land at the address it was built at, and when that address is taken — 32-bit MinGW on a
//! current Windows, most of all — the compiler stops with an internal error instead. The
//! address is chosen when the header is built, so the caller builds it afresh and only goes
//! without when that does not help either ([`failed_to_load`], [`rebuild`], [`give_up`]).

use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use crate::runner::execute;
use crate::tools::{tool_search_path, CommandExtHidden};

const HEADER: &str = "bits/stdc++.h";
/// Left behind when the header could not be built (Clang, a missing header, an unknown
/// flag), so the attempt is not repeated on every run.
const UNSUPPORTED_MARKER: &str = "unsupported";

/// The include directory to put first on the command line, building the header on first use.
/// `None` means compile without one.
pub(crate) fn ensure(compiler: &Path, standard: &str, flags: &[String]) -> Option<PathBuf> {
    let directory = cache_directory(compiler, standard, flags);
    let header = directory.join(format!("{HEADER}.gch"));
    if header.is_file() {
        return Some(directory);
    }
    if directory.join(UNSUPPORTED_MARKER).exists() {
        return None;
    }
    fs::create_dir_all(header.parent()?).ok()?;
    if is_gcc(compiler) && build(compiler, standard, flags, &directory, &header) {
        return Some(directory);
    }
    let _ = fs::remove_file(&header);
    let _ = fs::write(directory.join(UNSUPPORTED_MARKER), "");
    None
}

/// Whether a failed compile was GCC failing to load the precompiled header, not the program.
pub(crate) fn failed_to_load(stderr: &str) -> bool {
    stderr.contains("gt_pch_use_address") || stderr.contains("had to relocate PCH")
}

/// Throws the header away and builds it again.
pub(crate) fn rebuild(compiler: &Path, standard: &str, flags: &[String]) -> Option<PathBuf> {
    let _ = fs::remove_file(cache_directory(compiler, standard, flags).join(format!("{HEADER}.gch")));
    ensure(compiler, standard, flags)
}

/// Drops a header that could not be loaded and marks its directory, so later runs compile
/// without one instead of failing the same way first.
pub(crate) fn give_up(directory: &Path) {
    let _ = fs::remove_file(directory.join(format!("{HEADER}.gch")));
    let _ = fs::write(directory.join(UNSUPPORTED_MARKER), "");
}

fn build(compiler: &Path, standard: &str, flags: &[String], directory: &Path, header: &Path) -> bool {
    let source = directory.join("pch.h");
    if fs::write(&source, format!("#include <{HEADER}>\n")).is_err() {
        return false;
    }
    // Written under another name and renamed, so a run that is compiling at the same moment
    // never picks up half a header.
    let partial = directory.join("pch.partial");
    let mut args = vec![format!("-std={standard}")];
    args.extend(flags.iter().cloned());
    args.extend(["-x".into(), "c++-header".into(), source.to_string_lossy().into_owned(), "-o".into(), partial.to_string_lossy().into_owned()]);
    let result = execute(compiler, &args, directory, "", Duration::from_secs(60));
    result.ok && fs::rename(&partial, header).is_ok()
}

/// `g++` on macOS is Clang, whose precompiled headers work differently and which has no
/// `bits/stdc++.h` of its own.
pub(crate) fn is_gcc(compiler: &Path) -> bool {
    Command::new(compiler)
        .arg("--version")
        .env("PATH", tool_search_path())
        .creation_flags(0x08000000)
        .output()
        .map(|output| !String::from_utf8_lossy(&output.stdout).to_lowercase().contains("clang"))
        .unwrap_or(false)
}

fn cache_directory(compiler: &Path, standard: &str, flags: &[String]) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    compiler.hash(&mut hasher);
    // A compiler upgrade replaces the binary, and the old header with it.
    if let Ok(modified) = fs::metadata(compiler).and_then(|metadata| metadata.modified()) {
        modified.hash(&mut hasher);
    }
    standard.hash(&mut hasher);
    flags.hash(&mut hasher);
    std::env::temp_dir().join("mild-editor-pch").join(format!("{:016x}", hasher.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_header_that_cannot_be_mapped_back_is_told_from_a_compile_error() {
        assert!(failed_to_load("internal error in mingw32_gt_pch_use_address, at config/i386/host-mingw32.c:190: MapViewOfFileEx: ..."));
        assert!(failed_to_load("fatal error: had to relocate PCH"));
        assert!(!failed_to_load("main.cpp:3:5: error: 'x' was not declared in this scope"));
    }

    #[test]
    fn every_flag_set_gets_a_directory_of_its_own() {
        let compiler = Path::new("g++");
        let release = cache_directory(compiler, "c++20", &["-O2".into()]);
        assert_eq!(release, cache_directory(compiler, "c++20", &["-O2".into()]));
        assert_ne!(release, cache_directory(compiler, "c++20", &["-O0".into(), "-g".into()]));
        assert_ne!(release, cache_directory(compiler, "c++17", &["-O2".into()]));
    }
}
