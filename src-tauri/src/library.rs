//! The user's templates and snippets as files, in a folder of their choosing (src/library.ts).
//!
//!     <folder>/templates/default.cpp    what a new C++ file starts as
//!     <folder>/templates/atcoder.py     …and a Python file imported from AtCoder
//!     <folder>/snippets/segtree.cpp     a snippet named "segtree", for C++
//!     <folder>/snippets/order.json      the order snippets are offered in
//!
//! Being files, they can be edited in any editor, kept in git or a synced folder, and moved
//! to another computer by moving the folder. The editor reads the folder again whenever it
//! changes (`library_stamp`) and writes it when a template or snippet is saved in Settings.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const TEMPLATES: &str = "templates";
const SNIPPETS: &str = "snippets";
const ORDER: &str = "order.json";
/// The template names: one for files of no judge, one per judge.
const TEMPLATE_STEMS: [&str; 5] = ["default", "atcoder", "codeforces", "doj", "boj"];
/// A file larger than this is not a template or a snippet.
const MOST_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LibrarySnippet {
    pub name: String,
    /// `cpp` or `python`.
    pub language: String,
    pub code: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub folder: String,
    /// By file name: `default.cpp`, `atcoder.py`…
    pub templates: BTreeMap<String, String>,
    pub snippets: Vec<LibrarySnippet>,
    /// Nothing of a library in the folder yet.
    pub empty: bool,
    pub stamp: String,
}

fn extension(language: &str) -> Option<&'static str> {
    match language { "cpp" => Some("cpp"), "python" => Some("py"), _ => None }
}

fn language_of(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() { "cpp" => Some("cpp"), "py" => Some("python"), _ => None }
}

fn template_name_ok(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| TEMPLATE_STEMS.contains(&stem) && language_of(ext).is_some())
}

/// A snippet's name as a file name may hold it: a single part, no characters a file system
/// refuses, not hidden.
pub(crate) fn snippet_name_ok(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= 60 && name == name.trim() && !name.starts_with('.')
        && !name.chars().any(|character| character.is_control() || r#"<>:"/\|?*"#.contains(character))
}

fn read_small(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MOST_BYTES { return None; }
    fs::read_to_string(path).ok()
}

/// What changes when any file of the library does: names, sizes and modification times.
fn stamp(folder: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for directory in [TEMPLATES, SNIPPETS] {
        let mut entries: Vec<_> = fs::read_dir(folder.join(directory)).into_iter().flatten().flatten()
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                let modified = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
                Some((entry.file_name().to_string_lossy().into_owned(), metadata.len(), modified))
            })
            .collect();
        entries.sort();
        entries.hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

pub(crate) fn read(folder: &Path) -> Result<Library, String> {
    fs::create_dir_all(folder.join(TEMPLATES)).map_err(|error| format!("Could not use the folder: {error}"))?;
    fs::create_dir_all(folder.join(SNIPPETS)).map_err(|error| format!("Could not use the folder: {error}"))?;
    let mut templates = BTreeMap::new();
    for entry in fs::read_dir(folder.join(TEMPLATES)).map_err(|error| error.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if template_name_ok(&name) {
            if let Some(text) = read_small(&entry.path()) { templates.insert(name, text); }
        }
    }
    let mut found: BTreeMap<String, LibrarySnippet> = BTreeMap::new();
    for entry in fs::read_dir(folder.join(SNIPPETS)).map_err(|error| error.to_string())?.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some((name, ext)) = file.rsplit_once('.') else { continue };
        let (Some(language), true) = (language_of(ext), snippet_name_ok(name)) else { continue };
        if let Some(code) = read_small(&entry.path()) {
            found.insert(file.clone(), LibrarySnippet { name: name.to_string(), language: language.to_string(), code });
        }
    }
    // The order file first, then whatever it does not list, by name.
    let order: Vec<String> = read_small(&folder.join(SNIPPETS).join(ORDER)).and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let mut snippets: Vec<LibrarySnippet> = order.iter().filter_map(|file| found.remove(file)).collect();
    snippets.extend(found.into_values());
    let empty = templates.is_empty() && snippets.is_empty();
    Ok(Library { folder: folder.to_string_lossy().into_owned(), templates, snippets, empty, stamp: stamp(folder) })
}

/// Writes beside the file and moves it over, so an editor reading it never sees half of it.
fn write_whole(path: &Path, text: &str) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, text).and_then(|_| fs::rename(&temporary, path)).or_else(|_| {
        let _ = fs::remove_file(&temporary);
        fs::write(path, text)
    }).map_err(|error| format!("Could not save {}: {error}", path.display()))
}

pub(crate) fn write_template(folder: &Path, name: &str, text: Option<&str>) -> Result<(), String> {
    if !template_name_ok(name) { return Err("Not a template name.".into()); }
    fs::create_dir_all(folder.join(TEMPLATES)).map_err(|error| error.to_string())?;
    let path = folder.join(TEMPLATES).join(name);
    match text {
        Some(text) => write_whole(&path, text),
        // Gone: the template falls back to the default one, then the editor's own.
        None => match fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        },
    }
}

/// The name a file of `directory` has when it is `file` spelled in another case, if one is.
fn same_file_other_case(directory: &Path, file: &str) -> Option<String> {
    let wanted = file.to_lowercase();
    fs::read_dir(directory).ok()?.flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .find(|name| name != file && name.to_lowercase() == wanted)
}

/// Makes the snippets folder hold exactly `snippets`, in that order. Files of a name it does
/// not use are removed, and only those: anything else in the folder is left alone.
pub(crate) fn write_snippets(folder: &Path, snippets: &[LibrarySnippet]) -> Result<(), String> {
    let directory = folder.join(SNIPPETS);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    for snippet in snippets {
        let ext = extension(&snippet.language).ok_or("A snippet is C++ or Python.")?;
        if !snippet_name_ok(&snippet.name) { return Err(format!("\"{}\" cannot be a file name.", snippet.name)); }
        let file = format!("{}.{ext}", snippet.name);
        if files.iter().any(|known: &String| known.eq_ignore_ascii_case(&file)) { return Err(format!("Two snippets are called \"{}\".", snippet.name)); }
        let path = directory.join(&file);
        // Windows and macOS keep a file's old spelling when it is written under another case,
        // so a snippet renamed from `Segtree` to `segtree` is renamed on disk first; otherwise
        // the clean-up below took `Segtree.cpp` for a leftover and deleted the snippet.
        if let Some(existing) = same_file_other_case(&directory, &file) {
            fs::rename(directory.join(&existing), &path).map_err(|error| error.to_string())?;
        }
        if read_small(&path).as_deref() != Some(snippet.code.as_str()) { write_whole(&path, &snippet.code)?; }
        files.push(file);
    }
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())?.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let is_snippet = file.rsplit_once('.').is_some_and(|(name, ext)| language_of(ext).is_some() && snippet_name_ok(name));
        let kept = files.iter().any(|known| known.to_lowercase() == file.to_lowercase());
        if is_snippet && !kept { let _ = fs::remove_file(entry.path()); }
    }
    let order = serde_json::to_string_pretty(&files).map_err(|error| error.to_string())?;
    write_whole(&directory.join(ORDER), &format!("{order}\n"))
}

// ── Commands ──

#[tauri::command(async)]
pub fn library_default_folder(app: tauri::AppHandle) -> Result<String, String> {
    let folder = app.path().app_data_dir().map_err(|error| error.to_string())?.join("library");
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    Ok(folder.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn library_read(folder: String) -> Result<Library, String> {
    read(&PathBuf::from(folder))
}

#[tauri::command(async)]
pub fn library_stamp(folder: String) -> String {
    stamp(&PathBuf::from(folder))
}

#[tauri::command(async)]
pub fn library_write_template(folder: String, name: String, text: Option<String>) -> Result<String, String> {
    let folder = PathBuf::from(folder);
    write_template(&folder, &name, text.as_deref())?;
    Ok(stamp(&folder))
}

#[tauri::command(async)]
pub fn library_write_snippets(folder: String, snippets: Vec<LibrarySnippet>) -> Result<String, String> {
    let folder = PathBuf::from(folder);
    write_snippets(&folder, &snippets)?;
    Ok(stamp(&folder))
}

#[tauri::command(async)]
pub fn library_reveal(folder: String) -> Result<(), String> {
    let folder = PathBuf::from(folder);
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    crate::workspace::reveal_in_file_manager(&folder, &folder, "folder")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("mild-library-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        folder
    }

    fn snippet(name: &str, language: &str, code: &str) -> LibrarySnippet {
        LibrarySnippet { name: name.into(), language: language.into(), code: code.into() }
    }

    #[test]
    fn a_library_is_written_and_read_back_in_order() {
        let folder = scratch("cycle");
        assert!(read(&folder).unwrap().empty);
        write_template(&folder, "default.cpp", Some("int main() {}\n")).unwrap();
        write_template(&folder, "atcoder.py", Some("print()\n")).unwrap();
        let snippets = vec![snippet("str", "python", "s = input()"), snippet("segtree", "cpp", "// seg"), snippet("str", "cpp", "string s;")];
        write_snippets(&folder, &snippets).unwrap();
        let library = read(&folder).unwrap();
        assert!(!library.empty);
        assert_eq!(library.templates.keys().collect::<Vec<_>>(), vec!["atcoder.py", "default.cpp"]);
        assert_eq!(library.snippets, snippets);
        // Reordered and one removed: the folder follows, and nothing else in it is touched.
        fs::write(folder.join(SNIPPETS).join("notes.txt"), "mine").unwrap();
        write_snippets(&folder, &[snippets[2].clone(), snippets[0].clone()]).unwrap();
        assert_eq!(read(&folder).unwrap().snippets, vec![snippets[2].clone(), snippets[0].clone()]);
        assert!(!folder.join(SNIPPETS).join("segtree.cpp").exists());
        assert!(folder.join(SNIPPETS).join("notes.txt").exists());
        write_template(&folder, "atcoder.py", None).unwrap();
        assert_eq!(read(&folder).unwrap().templates.len(), 1);
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_snippet_added_by_hand_is_offered_after_the_ordered_ones() {
        let folder = scratch("by-hand");
        write_snippets(&folder, &[snippet("b", "cpp", "b")]).unwrap();
        fs::write(folder.join(SNIPPETS).join("a.py"), "a").unwrap();
        fs::write(folder.join(SNIPPETS).join("ignored.txt"), "x").unwrap();
        let names: Vec<String> = read(&folder).unwrap().snippets.into_iter().map(|snippet| snippet.name).collect();
        assert_eq!(names, vec!["b", "a"]);
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn the_stamp_moves_when_a_file_does() {
        let folder = scratch("stamp");
        read(&folder).unwrap();
        let before = stamp(&folder);
        fs::write(folder.join(TEMPLATES).join("default.py"), "x").unwrap();
        assert_ne!(stamp(&folder), before);
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn renaming_a_snippet_to_another_case_keeps_it() {
        let folder = scratch("case");
        write_snippets(&folder, &[snippet("Segtree", "cpp", "// seg")]).unwrap();
        // Same code, new case: nothing to write, and the old spelling must not be cleaned up.
        write_snippets(&folder, &[snippet("segtree", "cpp", "// seg")]).unwrap();
        assert_eq!(read(&folder).unwrap().snippets, vec![snippet("segtree", "cpp", "// seg")]);
        // New code under a new case too.
        write_snippets(&folder, &[snippet("SegTree", "cpp", "// seg v2")]).unwrap();
        assert_eq!(read(&folder).unwrap().snippets, vec![snippet("SegTree", "cpp", "// seg v2")]);
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn names_that_are_not_files_are_refused() {
        let folder = scratch("names");
        assert!(write_template(&folder, "../evil.cpp", Some("x")).is_err());
        assert!(write_template(&folder, "other.cpp", Some("x")).is_err());
        assert!(write_snippets(&folder, &[snippet("a/b", "cpp", "x")]).is_err());
        assert!(write_snippets(&folder, &[snippet(".hidden", "cpp", "x")]).is_err());
        assert!(write_snippets(&folder, &[snippet("x", "rust", "x")]).is_err());
        assert!(write_snippets(&folder, &[snippet("Dup", "cpp", "1"), snippet("dup", "cpp", "2")]).is_err());
        assert!(snippet_name_ok("세그트리") && snippet_name_ok("seg tree") && !snippet_name_ok("a:b"));
        let _ = fs::remove_dir_all(&folder);
    }
}
