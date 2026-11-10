//! Which Python runs a solution, and which C++ compiler builds one.
//!
//! The editor used to take whatever `python3` and `g++` came first on `PATH`, which on a Mac
//! is often Apple's Python 3.9 and Apple's clang: no `match`, no `bits/stdc++.h`. Here every
//! interpreter and compiler the computer has is found and described, so one can be chosen per
//! language (the frontend sends the choice with each run, `BuildOptions`), and a Python can be
//! installed into the editor itself — a python-build-standalone build, the one `uv` uses,
//! checked against the release's own SHA-256 sums.
//!
//! An interpreter is run by its real executable (what `sys.executable` says), never through
//! a launcher — pyenv's shims, `/usr/bin/python3` on a Mac — which costs time on every run and,
//! the first time after a while, enough of it to turn a fast solution into a TLE.

use crate::runner::execute;
use crate::tools::{find_tool, tool_search_path};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Toolchain {
    /// What runs: the interpreter's real executable, or the compiler.
    pub path: String,
    /// `3.12.7`, or the compiler's version line.
    pub version: String,
    /// Where it came from, for the list: Homebrew, pyenv, uv, python.org, Xcode, the editor…
    pub origin: String,
    /// Installed by the editor, so the editor may remove it.
    pub managed: bool,
    /// A compiler that is GCC, and so has `bits/stdc++.h`.
    pub gcc: bool,
    /// The one a run uses when none is chosen.
    pub is_default: bool,
}

/// What a probe asks an interpreter: its version and where it really lives.
const PROBE: &str = "import platform, sys\nprint(platform.python_version())\nprint(sys.executable)\nprint(platform.python_implementation())";

/// The version and real executable of the Python at `path`, or None for anything that is
/// not one that runs.
fn probe_python(path: &Path) -> Option<(String, PathBuf)> {
    let result = execute(path, &["-I".into(), "-c".into(), PROBE.into()], &std::env::temp_dir(), "", Duration::from_secs(10));
    if !result.ok { return None; }
    let mut lines = result.stdout.lines();
    let version = lines.next()?.trim().to_string();
    let real = PathBuf::from(lines.next()?.trim());
    // PyPy says the version of Python it implements; the name tells it from CPython.
    let implementation = lines.next().unwrap_or("CPython").trim();
    let version = if implementation == "CPython" { version } else { format!("{implementation} {version}") };
    (version.chars().any(|character| character.is_ascii_digit()) && real.is_file()).then_some((version, real))
}

fn origin_of(path: &Path, managed: bool) -> String {
    if managed { return "editor".into(); }
    let text = path.to_string_lossy().replace('\\', "/").to_lowercase();
    let known = [
        ("/homebrew/", "Homebrew"), ("/cellar/", "Homebrew"), ("/.pyenv/", "pyenv"), ("/uv/python/", "uv"), ("/commandlinetools/", "Xcode"),
        ("/xcode.app/", "Xcode"), ("python.framework", "python.org"), ("/programs/python/", "python.org"), ("conda", "conda"), ("/opt/local/", "MacPorts"),
    ];
    known.iter().find(|(part, _)| text.contains(part)).map(|(_, name)| (*name).to_string()).unwrap_or_else(|| "system".into())
}

/// Where the editor keeps the Pythons it installed.
fn managed_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|directory| directory.join("pythons"))
}

/// The interpreter inside an unpacked python-build-standalone archive.
fn standalone_executable(directory: &Path) -> PathBuf {
    if cfg!(windows) { directory.join("python").join("python.exe") } else { directory.join("python").join("bin").join("python3") }
}

/// Apple's `/usr/bin/python3` is a launcher for the developer tools; without them it opens a
/// dialog offering to install them instead of running anything.
#[cfg(target_os = "macos")]
fn is_apple_launcher(path: &Path) -> bool {
    path == Path::new("/usr/bin/python3") || path == Path::new("/usr/bin/python")
}
#[cfg(not(target_os = "macos"))]
fn is_apple_launcher(_path: &Path) -> bool { false }

/// Every place a Python may be, most likely first. Not checked yet.
fn python_candidates(app: Option<&tauri::AppHandle>) -> Vec<(PathBuf, bool)> {
    let mut found: Vec<(PathBuf, bool)> = Vec::new();
    if let Some(root) = app.and_then(managed_root) {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                found.push((standalone_executable(&entry.path()), true));
            }
        }
    }
    let cwd = std::env::temp_dir();
    let mut names = vec!["python3".to_string(), "python".to_string()];
    names.extend((8..=16).map(|minor| format!("python3.{minor}")));
    for name in &names {
        if let Ok(paths) = which::which_in_all(name, Some(tool_search_path()), &cwd) {
            found.extend(paths.map(|path| (path, false)));
        }
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default();
    // uv keeps its Pythons under the XDG data directory, ~/.local/share unless moved.
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local").join("share"));
    let mut globs: Vec<(PathBuf, &str)> = vec![
        (home.join(".pyenv").join("versions"), "bin/python3"),
        // pyenv-win
        (home.join(".pyenv").join("pyenv-win").join("versions"), "python.exe"),
        (data.join("uv").join("python"), "bin/python3"),
    ];
    if cfg!(target_os = "macos") {
        globs.push((PathBuf::from("/Library/Frameworks/Python.framework/Versions"), "bin/python3"));
        found.push((PathBuf::from("/Library/Developer/CommandLineTools/usr/bin/python3"), false));
        found.push((PathBuf::from("/Applications/Xcode.app/Contents/Developer/usr/bin/python3"), false));
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            globs.push((local.join("Programs").join("Python"), "python.exe"));
        }
        if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
            globs.push((roaming.join("uv").join("python"), "python.exe"));
        }
        // The launcher knows every python.org install, including ones for all users.
        if let Some(launcher) = find_tool("py") {
            let listed = execute(&launcher, &["-0p".into()], &cwd, "", Duration::from_secs(10));
            for line in listed.stdout.lines() {
                // ` -V:3.12 *        C:\Users\…\python.exe`: the path starts at its drive letter.
                if let Some(start) = line.find(":\\").and_then(|colon| colon.checked_sub(1)) {
                    found.push((PathBuf::from(line[start..].trim()), false));
                }
            }
        }
    }
    for (directory, executable) in globs {
        if let Ok(entries) = std::fs::read_dir(&directory) {
            for entry in entries.flatten() {
                found.push((entry.path().join(executable), false));
            }
        }
    }
    found.retain(|(path, _)| {
        let text = path.to_string_lossy();
        // Windows' `python` alias opens the Store; Apple's launcher may open an installer.
        !text.contains("WindowsApps") && !is_apple_launcher(path) && path.is_file()
    });
    found
}

/// Runs `work` on every item at once: each probe starts an interpreter or a compiler.
fn in_parallel<T: Send, R: Send>(items: Vec<T>, work: impl Fn(T) -> Option<R> + Sync) -> Vec<R> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = items.into_iter().map(|item| scope.spawn(|| work(item))).collect();
        handles.into_iter().filter_map(|handle| handle.join().ok().flatten()).collect()
    })
}

fn version_key(version: &str) -> Vec<u32> {
    version.split(|character: char| !character.is_ascii_digit()).filter_map(|part| part.parse().ok()).collect()
}

/// Every Python on this computer that runs, once each, newest first.
pub fn pythons(app: Option<&tauri::AppHandle>) -> Vec<Toolchain> {
    let mut candidates = python_candidates(app);
    let mut seen = HashSet::new();
    candidates.retain(|(path, _)| seen.insert(path.clone()));
    let probed = in_parallel(candidates, |(path, managed)| probe_python(&path).map(|(version, real)| (version, real, managed)));
    let mut real_seen = HashSet::new();
    let mut found: Vec<Toolchain> = probed.into_iter()
        .filter(|(_, real, _)| real_seen.insert(real.canonicalize().unwrap_or_else(|_| real.clone())))
        // Named for where it really is: uv links its Pythons into ~/.local/bin.
        .map(|(version, real, managed)| Toolchain { origin: origin_of(&real.canonicalize().unwrap_or_else(|_| real.clone()), managed), path: real.to_string_lossy().into_owned(), version, managed, gcc: false, is_default: false })
        .collect();
    found.sort_by(|left, right| version_key(&right.version).cmp(&version_key(&left.version)).then(left.path.cmp(&right.path)));
    found
}

/// The compiler's first line of `--version`, shortened to what tells compilers apart.
fn probe_compiler(path: &Path) -> Option<(String, bool)> {
    let result = execute(path, &["--version".into()], &std::env::temp_dir(), "", Duration::from_secs(10));
    let line = result.stdout.lines().next()?.trim().to_string();
    if !result.ok || line.is_empty() { return None; }
    let gcc = !line.to_lowercase().contains("clang");
    Some((line, gcc))
}

/// Every C++ compiler on this computer, once each: GCC first, the newest first among them.
pub fn compilers() -> Vec<Toolchain> {
    let cwd = std::env::temp_dir();
    let mut names = vec!["g++".to_string()];
    names.extend((9..=16).rev().map(|major| format!("g++-{major}")));
    names.extend(["clang++".to_string(), "c++".to_string()]);
    let mut candidates: Vec<PathBuf> = Vec::new();
    for name in &names {
        if let Ok(paths) = which::which_in_all(name, Some(tool_search_path()), &cwd) {
            candidates.extend(paths);
        }
    }
    let mut seen = HashSet::new();
    candidates.retain(|path| seen.insert(path.canonicalize().unwrap_or_else(|_| path.clone())));
    let probed = in_parallel(candidates, |path| probe_compiler(&path).map(|(version, gcc)| (path, version, gcc)));
    // `c++` and `g++` are often one compiler under two names; its version line says so.
    let mut versions = HashSet::new();
    let mut found: Vec<Toolchain> = probed.into_iter()
        .filter(|(_, version, _)| versions.insert(version.clone()))
        .map(|(path, version, gcc)| Toolchain { origin: origin_of(&path, false), path: path.to_string_lossy().into_owned(), version, managed: false, gcc, is_default: false })
        .collect();
    found.sort_by_key(|compiler| !compiler.gcc);
    found
}

// ── What runs when nothing was chosen ──

static DEFAULT_PYTHON: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The Python a run uses when none was chosen: the first on `PATH`, as before, but by its
/// real executable. Remembered once found; looked for again while there is none.
pub fn default_python() -> Option<PathBuf> {
    if let Some(known) = DEFAULT_PYTHON.lock().ok().and_then(|known| known.clone()) {
        return Some(known);
    }
    // Windows keeps `python` first because its `python3` is usually the Store alias.
    let names = if cfg!(windows) { ["python", "python3"] } else { ["python3", "python"] };
    let first = names.iter().filter_map(|name| find_tool(name)).find(|path| !path.to_string_lossy().contains("WindowsApps"));
    // A Mac app is started with `/usr/bin` before Homebrew on its PATH, the other way round
    // from a terminal, so Apple's old Python would win where `python3` in a terminal is
    // Homebrew's. The terminal's choice is taken: the first other Python, then Apple's.
    #[cfg(target_os = "macos")]
    let first = if first.as_deref().is_some_and(is_apple_launcher) {
        let others: Vec<PathBuf> = python_candidates(None).into_iter().map(|(path, _)| path).collect();
        others.iter().find(|path| origin_of(path, false) != "Xcode").or(others.first()).cloned()
    } else {
        first
    };
    let first = first?;
    let real = probe_python(&first).map(|(_, real)| real).unwrap_or(first);
    if let Ok(mut known) = DEFAULT_PYTHON.lock() { *known = Some(real.clone()); }
    Some(real)
}

/// The Python a run uses: the chosen one, or the default.
pub fn python_for(chosen: Option<&str>) -> Result<PathBuf, String> {
    match chosen.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) if Path::new(path).is_file() => Ok(PathBuf::from(path)),
        Some(path) => Err(format!("The Python chosen in Settings → Languages is not there any more: {path}")),
        None => default_python().ok_or_else(|| crate::runner::MISSING_PYTHON.to_string()),
    }
}

/// The C++ compiler a run uses: the chosen one, or the first `g++`.
pub fn compiler_for(chosen: Option<&str>) -> Result<PathBuf, String> {
    match chosen.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) if Path::new(path).is_file() => Ok(PathBuf::from(path)),
        Some(path) => Err(format!("The C++ compiler chosen in Settings → Languages is not there any more: {path}")),
        None => find_tool("g++").ok_or_else(|| crate::runner::MISSING_COMPILER.to_string()),
    }
}

/// Starts the interpreter once, off the run's clock: the first start after a while reads it
/// back from disk, and that should not happen during a timed test.
pub fn warm(python: Option<String>) {
    std::thread::spawn(move || {
        if let Ok(path) = python_for(python.as_deref()) {
            let _ = execute(&path, &["-I".into(), "-c".into(), "import sys".into()], &std::env::temp_dir(), "", Duration::from_secs(20));
        }
    });
}

// ── Installing a Python ──

const RELEASES: &str = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest";
/// An archive larger than this is not one of these builds.
const MOST_BYTES: u64 = 400 * 1024 * 1024;

fn target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        _ => None,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PythonDownload {
    pub version: String,
    pub name: String,
    pub url: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct Release { assets: Vec<Asset> }

#[derive(Deserialize)]
struct Asset { name: String, browser_download_url: String, size: u64 }

/// The newest build of each Python minor version a release has for `triple`: the plain
/// `install_only` archives, not the debug or free-threaded ones. Newest minor first.
fn downloads_in(assets: &[(String, String, u64)], triple: &str) -> Vec<PythonDownload> {
    let suffix = format!("-{triple}-install_only.tar.gz");
    let mut newest: std::collections::BTreeMap<Vec<u32>, PythonDownload> = std::collections::BTreeMap::new();
    for (name, url, size) in assets {
        let Some(rest) = name.strip_prefix("cpython-") else { continue };
        if !name.ends_with(&suffix) || name.contains("freethreaded") || name.contains("debug") { continue; }
        let Some(version) = rest.split('+').next().filter(|version| version.chars().all(|character| character.is_ascii_digit() || character == '.')) else { continue };
        let key = version_key(version);
        if key.len() != 3 || key[0] != 3 || key[1] < 9 { continue; }
        let minor = key[..2].to_vec();
        let better = newest.get(&minor).is_none_or(|known| version_key(&known.version) < key);
        if better {
            newest.insert(minor, PythonDownload { version: version.to_string(), name: name.clone(), url: url.clone(), size: *size });
        }
    }
    newest.into_values().rev().collect()
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("mild-editor")
        .connect_timeout(crate::HTTP_CONNECT_TIMEOUT)
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())
}

fn release_assets() -> Result<Vec<(String, String, u64)>, String> {
    let release: Release = client()?.get(RELEASES).send().and_then(|response| response.error_for_status())
        .map_err(|error| format!("Could not ask GitHub for Python builds: {error}"))?
        .json().map_err(|error| format!("GitHub's answer was not understood: {error}"))?;
    Ok(release.assets.into_iter().map(|asset| (asset.name, asset.browser_download_url, asset.size)).collect())
}

/// The SHA-256 the release lists for `name`, from its `SHA256SUMS`.
fn listed_sum(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let sum = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        (file == name && sum.len() == 64).then(|| sum.to_lowercase())
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InstallProgress { version: String, received: u64, total: u64 }

fn install(app: &tauri::AppHandle, version: &str) -> Result<Toolchain, String> {
    use sha2::{Digest, Sha256};
    let triple = target_triple().ok_or("No Python build is made for this kind of computer.")?;
    let assets = release_assets()?;
    let download = downloads_in(&assets, triple).into_iter().find(|download| download.version == version)
        .ok_or_else(|| format!("Python {version} is not in the latest builds."))?;
    if download.size > MOST_BYTES { return Err("That build is unexpectedly large.".into()); }
    let sums_url = assets.iter().find(|(name, _, _)| name == "SHA256SUMS").map(|(_, url, _)| url.clone())
        .ok_or("The release lists no checksums, so the build cannot be checked.")?;
    let client = client()?;
    let sums = client.get(&sums_url).send().and_then(|response| response.error_for_status()).and_then(|response| response.text())
        .map_err(|error| format!("Could not read the checksums: {error}"))?;
    let expected = listed_sum(&sums, &download.name).ok_or("The build is not in the release's checksums.")?;

    let root = managed_root(app).ok_or("No folder for the editor's own files.")?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut response = client.get(&download.url).send().and_then(|response| response.error_for_status())
        .map_err(|error| format!("Could not download Python {version}: {error}"))?;
    let mut archive = Vec::with_capacity(download.size as usize);
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; 256 * 1024];
    let mut reported = 0;
    loop {
        let read = response.read(&mut chunk).map_err(|error| format!("The download broke off: {error}"))?;
        if read == 0 { break; }
        hasher.update(&chunk[..read]);
        archive.extend_from_slice(&chunk[..read]);
        if archive.len() as u64 > MOST_BYTES { return Err("That build is unexpectedly large.".into()); }
        if archive.len() - reported >= 1024 * 1024 {
            reported = archive.len();
            let _ = app.emit("python-install-progress", InstallProgress { version: version.into(), received: reported as u64, total: download.size });
        }
    }
    if hex::encode(hasher.finalize()) != expected {
        return Err("The download does not match its checksum, so it was not installed.".into());
    }

    // Unpacked beside its final place and moved there whole, so a half-unpacked Python is never listed.
    let unpacking = root.join(format!(".unpacking-{version}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&unpacking);
    tar::Archive::new(flate2::read::GzDecoder::new(archive.as_slice())).unpack(&unpacking)
        .map_err(|error| format!("Could not unpack Python {version}: {error}"))?;
    let destination = root.join(format!("cpython-{version}"));
    let _ = std::fs::remove_dir_all(&destination);
    std::fs::rename(&unpacking, &destination).map_err(|error| format!("Could not put Python {version} in place: {error}"))?;
    let executable = standalone_executable(&destination);
    let (found, real) = probe_python(&executable).ok_or_else(|| format!("Python {version} was unpacked but does not run."))?;
    Ok(Toolchain { origin: origin_of(&real, true), path: real.to_string_lossy().into_owned(), version: found, managed: true, gcc: false, is_default: false })
}

// ── Commands ──

/// Marks the one at `default` (by its real file) as the one used when none is chosen.
fn mark_default(mut list: Vec<Toolchain>, default: Option<PathBuf>) -> Vec<Toolchain> {
    let default = default.map(|path| path.canonicalize().unwrap_or(path));
    for item in &mut list {
        let path = PathBuf::from(&item.path);
        item.is_default = default.as_ref().is_some_and(|default| path.canonicalize().unwrap_or(path) == *default);
    }
    list
}

#[tauri::command]
pub async fn list_pythons(app: tauri::AppHandle) -> Vec<Toolchain> {
    tauri::async_runtime::spawn_blocking(move || mark_default(pythons(Some(&app)), default_python())).await.unwrap_or_default()
}

#[tauri::command]
pub async fn list_compilers() -> Vec<Toolchain> {
    tauri::async_runtime::spawn_blocking(|| mark_default(compilers(), find_tool("g++"))).await.unwrap_or_default()
}

/// The Pythons the editor can install on this computer.
#[tauri::command]
pub async fn python_downloads() -> Result<Vec<PythonDownload>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let triple = target_triple().ok_or("No Python build is made for this kind of computer.")?;
        Ok(downloads_in(&release_assets()?, triple))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn install_python(app: tauri::AppHandle, version: String) -> Result<Toolchain, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app, &version)).await.map_err(|error| error.to_string())?
}

/// Removes a Python the editor installed; any other is the computer's, and left alone.
#[tauri::command]
pub fn remove_python(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = managed_root(&app).ok_or("No folder for the editor's own files.")?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let path = PathBuf::from(path).canonicalize().map_err(|error| error.to_string())?;
    let relative = path.strip_prefix(&root).map_err(|_| "Only a Python the editor installed can be removed here.")?;
    let installation = relative.components().next().ok_or("Not an installation.")?;
    std::fs::remove_dir_all(root.join(installation)).map_err(|error| format!("Could not remove it: {error}"))
}

#[tauri::command]
pub fn warm_python(python: Option<String>) {
    warm(python);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> (String, String, u64) {
        (name.into(), format!("https://example.org/{name}"), 30_000_000)
    }

    #[test]
    fn the_newest_plain_build_of_each_minor_version() {
        let assets = vec![
            asset("cpython-3.12.6+20241016-aarch64-apple-darwin-install_only.tar.gz"),
            asset("cpython-3.12.7+20241016-aarch64-apple-darwin-install_only.tar.gz"),
            asset("cpython-3.12.7+20241016-aarch64-apple-darwin-install_only_stripped.tar.gz"),
            asset("cpython-3.13.0+20241016-aarch64-apple-darwin-freethreaded-install_only.tar.gz"),
            asset("cpython-3.13.0+20241016-aarch64-apple-darwin-install_only.tar.gz"),
            asset("cpython-3.13.0+20241016-x86_64-apple-darwin-install_only.tar.gz"),
            asset("cpython-3.8.20+20241016-aarch64-apple-darwin-install_only.tar.gz"),
            asset("cpython-3.12.7+20241016-aarch64-apple-darwin-debug-full.tar.zst"),
            asset("SHA256SUMS"),
        ];
        let versions: Vec<String> = downloads_in(&assets, "aarch64-apple-darwin").into_iter().map(|download| download.version).collect();
        assert_eq!(versions, vec!["3.13.0", "3.12.7"]);
    }

    #[test]
    fn checksums_are_found_by_file_name() {
        let sums = format!("{}  cpython-a.tar.gz\n{} *cpython-b.tar.gz\n", "A".repeat(64), "b".repeat(64));
        assert_eq!(listed_sum(&sums, "cpython-a.tar.gz"), Some("a".repeat(64)));
        assert_eq!(listed_sum(&sums, "cpython-b.tar.gz"), Some("b".repeat(64)));
        assert_eq!(listed_sum(&sums, "cpython-c.tar.gz"), None);
    }

    #[test]
    fn versions_sort_as_numbers() {
        assert!(version_key("3.10.1") > version_key("3.9.20"));
        assert_eq!(version_key("PyPy 3.11.15"), vec![3, 11, 15]);
        assert_eq!(version_key("3.12.7"), vec![3, 12, 7]);
    }

    #[test]
    fn origins_are_named_from_the_path() {
        assert_eq!(origin_of(Path::new("/opt/homebrew/Cellar/python@3.12/3.12.7/bin/python3.12"), false), "Homebrew");
        assert_eq!(origin_of(Path::new("/Users/a/.pyenv/versions/3.11.9/bin/python3.11"), false), "pyenv");
        assert_eq!(origin_of(Path::new("C:\\Users\\a\\AppData\\Local\\Programs\\Python\\Python312\\python.exe"), false), "python.org");
        assert_eq!(origin_of(Path::new("/x/pythons/cpython-3.13.0/python/bin/python3"), true), "editor");
        assert_eq!(origin_of(Path::new("/usr/bin/python3"), false), "system");
    }

    /// Whatever this machine has: every compiler listed answers to --version.
    #[test]
    fn compilers_found_here_are_real() {
        for compiler in compilers() {
            eprintln!("compiler: {} · gcc {} · {}", compiler.version, compiler.gcc, compiler.path);
            assert!(Path::new(&compiler.path).is_file(), "{compiler:?}");
        }
        eprintln!("default python: {:?}", default_python());
    }

    /// Whatever this machine has: every Python listed runs and says its version.
    #[test]
    fn pythons_found_here_are_real() {
        for python in pythons(None) {
            eprintln!("python: {} · {} · {}", python.version, python.origin, python.path);
            assert!(Path::new(&python.path).is_file(), "{python:?}");
            assert!(python.version.contains('3'), "{python:?}");
        }
    }
}
