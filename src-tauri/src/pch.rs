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
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::runner::execute;
use crate::tools::{tool_search_path, CommandExtHidden};

const HEADER: &str = "bits/stdc++.h";
/// Left behind when the header could not be built or used, so the attempt is not repeated on
/// every run. It holds the time to try again at, or `never` for a compiler that cannot use one
/// at all (Clang). Every failure used to mark the compiler for good, so one build cut short —
/// a timeout on a busy machine, an antivirus holding the file — turned the cache off forever.
const UNSUPPORTED_MARKER: &str = "unsupported";
/// How long after a failed build the next run tries again.
const RETRY_AFTER_FAILED_BUILD: Duration = Duration::from_secs(60 * 60);
/// A header GCC could not map back into memory is likely to fail the same way for a while.
const RETRY_AFTER_FAILED_LOAD: Duration = Duration::from_secs(24 * 60 * 60);
/// Building takes a while under `-D_GLIBCXX_DEBUG` and sanitizers, longer on a slow machine.
const BUILD_TIME_LIMIT: Duration = Duration::from_secs(120);

/// One header built at a time: a run and a stress test starting together would otherwise
/// both build it, over the same files.
static BUILDING: Mutex<()> = Mutex::new(());

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0)
}

/// Marks the directory as not to be tried until `retry` has passed; `None` means never.
fn mark_unsupported(directory: &Path, retry: Option<Duration>) {
    let content = match retry {
        Some(wait) => (now_secs() + wait.as_secs()).to_string(),
        None => "never".into(),
    };
    let _ = fs::write(directory.join(UNSUPPORTED_MARKER), content);
}

/// Whether a marker still holds. An empty one was left by a version that marked every failure
/// for good; it gets one more try.
fn still_unsupported(marker: &str, now: u64) -> bool {
    match marker.trim() {
        "never" => true,
        until => until.parse::<u64>().is_ok_and(|until| now < until),
    }
}

/// The include directory to put first on the command line, building the header on first use.
/// `None` means compile without one.
pub(crate) fn ensure(compiler: &Path, standard: &str, flags: &[String]) -> Option<PathBuf> {
    let directory = cache_directory(compiler, standard, flags);
    let header = directory.join(format!("{HEADER}.gch"));
    if header.is_file() {
        return Some(directory);
    }
    let marker = directory.join(UNSUPPORTED_MARKER);
    if fs::read_to_string(&marker).is_ok_and(|text| still_unsupported(&text, now_secs())) {
        return None;
    }
    let _building = BUILDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Another run may have built it while this one waited.
    if header.is_file() {
        return Some(directory);
    }
    fs::create_dir_all(header.parent()?).ok()?;
    if !is_gcc(compiler) {
        mark_unsupported(&directory, None);
        return None;
    }
    if build(compiler, standard, flags, &directory, &header) {
        let _ = fs::remove_file(&marker);
        return Some(directory);
    }
    let _ = fs::remove_file(&header);
    mark_unsupported(&directory, Some(RETRY_AFTER_FAILED_BUILD));
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
    mark_unsupported(directory, Some(RETRY_AFTER_FAILED_LOAD));
}

fn build(compiler: &Path, standard: &str, flags: &[String], directory: &Path, header: &Path) -> bool {
    // Names of this build's own, so another process of the editor building at the same
    // moment (a second window) never writes over files this one is reading.
    let stamp = format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0));
    let source = directory.join(format!("pch-{stamp}.h"));
    if fs::write(&source, format!("#include <{HEADER}>\n")).is_err() {
        return false;
    }
    // Written under another name and renamed, so a run that is compiling at the same moment
    // never picks up half a header.
    let partial = directory.join(format!("pch-{stamp}.partial"));
    let mut args = vec![format!("-std={standard}")];
    args.extend(flags.iter().cloned());
    args.extend(["-x".into(), "c++-header".into(), source.to_string_lossy().into_owned(), "-o".into(), partial.to_string_lossy().into_owned()]);
    let result = execute(compiler, &args, directory, "", BUILD_TIME_LIMIT);
    let built = result.ok && fs::rename(&partial, header).is_ok();
    let _ = fs::remove_file(&source);
    let _ = fs::remove_file(&partial);
    built
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

/// FNV-1a: the same number for the same input in every build of the editor. The standard
/// library's hasher may change between Rust releases, and every update of the editor then
/// moved the cache to a new directory, rebuilt it, and left the old one behind.
fn stable_hash(parts: &[&[u8]]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for part in parts {
        for byte in part.iter().chain(std::iter::once(&0u8)) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

fn cache_directory(compiler: &Path, standard: &str, flags: &[String]) -> PathBuf {
    // A compiler upgrade replaces the binary, and the old header with it.
    let modified = fs::metadata(compiler)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_nanos().to_string())
        .unwrap_or_default();
    let compiler = compiler.to_string_lossy();
    let flags = flags.join("\u{1}");
    let hash = stable_hash(&[compiler.as_bytes(), modified.as_bytes(), standard.as_bytes(), flags.as_bytes()]);
    std::env::temp_dir().join("mild-editor-pch").join(format!("{hash:016x}"))
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
    fn a_failure_is_retried_later_unless_the_compiler_cannot_do_it() {
        assert!(still_unsupported("never", 1_000));
        assert!(still_unsupported("2000", 1_000));
        assert!(!still_unsupported("2000", 3_000));
        // Left by a version that marked every failure for good: tried once more.
        assert!(!still_unsupported("", 1_000));
    }

    #[test]
    fn the_cache_key_is_the_same_in_every_build() {
        // Fixed values: a change here means existing caches move.
        assert_eq!(stable_hash(&[b"g++", b"c++20"]), stable_hash(&[b"g++", b"c++20"]));
        assert_ne!(stable_hash(&[b"g++", b"c++20"]), stable_hash(&[b"g++c", b"++20"]));
        assert_eq!(stable_hash(&[]), 0xcbf2_9ce4_8422_2325);
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
