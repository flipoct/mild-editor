//! The workspace folder: its source files and the `.mild-editor.json` that remembers each
//! problem's tests, source and submissions.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, MutexGuard};
use std::{fs, path::Path, process::Command};

use crate::tools::decode_output;

const WORKSPACE_METADATA_FILENAME: &str = ".mild-editor.json";
const LEGACY_WORKSPACE_METADATA_FILENAME: &str = "mild-editor.json";

pub(crate) fn workspace_metadata_path(folder: &Path) -> std::path::PathBuf {
    let hidden = folder.join(WORKSPACE_METADATA_FILENAME);
    if hidden.exists() { hidden } else {
        let legacy = folder.join(LEGACY_WORKSPACE_METADATA_FILENAME);
        if legacy.exists() { legacy } else { hidden }
    }
}

/// One read-modify-write of `.mild-editor.json` at a time. Commands run on different threads
/// (the main one, the async pool, the verdict poll), and two that read the file before either
/// wrote it back lost one of the two changes: a test saved as a verdict arrived, say. Every
/// command here takes it first; none of them calls another, so it is never taken twice.
static METADATA_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn metadata_lock() -> MutexGuard<'static, ()> {
    METADATA_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How many problems whose files vanished are remembered (see `WorkspaceMetadata::detached`).
const MAX_DETACHED: usize = 200;

fn read_workspace_metadata(path: &Path) -> Result<WorkspaceMetadata, String> {
    fs::read_to_string(path)
        .map_err(|error| format!("Could not read workspace metadata: {error}"))
        .and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
}

/// `action` finishes the sentence "Could not …" for the error a failed write reports.
///
/// Written beside the file and moved over it, so a crash or a full disk midway leaves the old
/// file whole instead of a truncated one that no longer parses. When the move is refused (the
/// file held open without delete sharing, as some sync tools and scanners do), it is written
/// in place as before.
pub(crate) fn write_workspace_metadata(path: &Path, metadata: &WorkspaceMetadata, action: &str) -> Result<(), String> {
    let json = serde_json::to_string_pretty(metadata).map_err(|error| error.to_string())?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| WORKSPACE_METADATA_FILENAME.into());
    let temporary = path.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    let moved = fs::write(&temporary, &json).and_then(|_| fs::rename(&temporary, path));
    if moved.is_ok() { return Ok(()); }
    let _ = fs::remove_file(&temporary);
    fs::write(path, json).map_err(|error| format!("Could not {action}: {error}"))
}

/// The metadata a save builds on, which has to go ahead whatever state the file is in.
/// - Missing: a new workspace.
/// - Unreadable just now (an antivirus scan holding it, say): an error, not "empty". Taken as
///   empty, the save would write back a file without every other problem's tests.
/// - Not parseable: kept beside it as `.mild-editor.json.broken-<seconds>` before the save
///   replaces it, so whatever it held can still be recovered by hand.
fn metadata_to_update(path: &Path) -> Result<WorkspaceMetadata, String> {
    match fs::read_to_string(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(WorkspaceMetadata::empty()),
        Err(error) => Err(format!("Could not read workspace metadata: {error}")),
        Ok(json) => match serde_json::from_str(&json) {
            Ok(metadata) => Ok(metadata),
            Err(_) => {
                let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0);
                let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                fs::copy(path, path.with_file_name(format!("{name}.broken-{seconds}")))
                    .map_err(|error| format!("The workspace metadata is damaged and could not be backed up: {error}"))?;
                Ok(WorkspaceMetadata::empty())
            }
        },
    }
}

// --- What the editor last saw of each source file -------------------------------------------

/// The text each source file had when the editor last read or wrote it, as a hash. A save
/// sends every open tab, and a tab nobody touched still holds that text; if the file changed
/// on disk meanwhile (another editor, a `git checkout`), writing the tab back would undo that
/// change without anyone having asked. Kept in memory only: after a restart the editor has
/// read every file afresh anyway.
static KNOWN_TEXT: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

fn text_hash(text: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

fn known_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn remember_text(path: &Path, text: &str) {
    let mut known = KNOWN_TEXT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    known.get_or_insert_with(HashMap::new).insert(known_key(path), text_hash(text));
}

fn known_text(path: &Path) -> Option<u64> {
    let known = KNOWN_TEXT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    known.as_ref().and_then(|known| known.get(&known_key(path)).copied())
}

/// A source file's text, in UTF-8 or, failing that, the system code page (a file with CP949
/// comments, say), so one such file cannot keep the whole workspace from loading.
fn read_source_text(path: &Path) -> std::io::Result<String> {
    fs::read(path).map(|bytes| decode_output(&bytes))
}

/// What saving `code` to `path` should do, given what is on disk and what the editor last saw.
#[derive(Debug, PartialEq)]
enum SourceWrite {
    /// The file already says this.
    Unchanged,
    /// The file changed behind the editor while the tab still holds what the editor last
    /// saw: the tab is stale, not edited, so the file wins and its text goes back.
    KeepDisk(String),
    Write,
}

fn plan_source_write(path: &Path, code: &str) -> SourceWrite {
    let Ok(disk) = read_source_text(path) else { return SourceWrite::Write };
    if disk == code { return SourceWrite::Unchanged; }
    match known_text(path) {
        Some(known) if known == text_hash(code) && known != text_hash(&disk) => SourceWrite::KeepDisk(disk),
        _ => SourceWrite::Write,
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedTestCase {
    pub(crate) name: String,
    pub(crate) input: String,
    pub(crate) expected: String,
}

/// What `.mild-editor.json` held when a folder was a single problem; `load_workspace`
/// still reads it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProblemMetadata {
    version: u8,
    title: String,
    language: String,
    tests: Vec<SavedTestCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceProblemInput {
    filename: String,
    title: String,
    language: String,
    code: String,
    tests: Vec<SavedTestCase>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    judge_status: Option<String>,
    #[serde(default)]
    limits: Option<ProblemLimits>,
    #[serde(default)]
    modified_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveWorkspaceRequest {
    folder_path: String,
    problems: Vec<WorkspaceProblemInput>,
}

/// A command that needs nothing but the workspace.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceRequest {
    folder_path: String,
}

/// A command about one source file of the workspace.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileRequest {
    folder_path: String,
    filename: String,
}

/// A rename, or a duplicate: both name the file and where it (or its copy) should go.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameWorkspaceFileRequest {
    folder_path: String,
    filename: String,
    new_filename: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateWorkspaceFolderRequest {
    folder_path: String,
    name: String,
    #[serde(default)]
    parent_directory: String,
}

/// A command about one folder inside the workspace.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFolderRequest {
    folder_path: String,
    directory: String,
}

#[tauri::command]
pub(crate) fn list_workspace_source_filenames(request: WorkspaceRequest) -> Result<Vec<String>, String> {
    let _metadata = metadata_lock();
    workspace_source_filenames(Path::new(&request.folder_path))
}

#[tauri::command]
pub(crate) fn list_workspace_directories(request: WorkspaceRequest) -> Result<Vec<String>, String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(request.folder_path);
    let mut directories = Vec::new();
    walk_workspace(&folder, &folder, &mut |relative, is_directory| {
        if is_directory { directories.push(relative); }
    })?;
    directories.sort_by_key(|name| filename_key(name));
    Ok(directories)
}

fn valid_folder_name(name: &str) -> bool {
    !name.is_empty() && Path::new(name).file_name().and_then(|value| value.to_str()) == Some(name) && !matches!(name, "." | "..")
}

#[tauri::command]
pub(crate) fn create_workspace_folder(request: CreateWorkspaceFolderRequest) -> Result<String, String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(request.folder_path);
    let parent = workspace_directory_path(&request.parent_directory)?;
    let parent_path = folder.join(&parent);
    if !parent_path.is_dir() { return Err("The parent folder does not exist.".into()); }
    let requested = request.name.trim();
    if !valid_folder_name(requested) { return Err("Enter a valid folder name.".into()); }
    let mut name = requested.to_string();
    for number in 1.. {
        if !parent_path.join(&name).exists() { break; }
        name = format!("{requested} ({number})");
    }
    fs::create_dir(parent_path.join(&name)).map_err(|error| format!("Could not create folder: {error}"))?;
    Ok(if parent.as_os_str().is_empty() { name } else { parent.join(name).to_string_lossy().replace('\\', "/") })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameWorkspaceFolderRequest {
    folder_path: String,
    directory: String,
    new_name: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenamedWorkspaceFolder {
    directory: String,
    /// `[old, new]` for every source file the move carried along, so the frontend
    /// can repoint open tabs without reloading the workspace.
    renamed: Vec<[String; 2]>,
}

#[tauri::command]
pub(crate) fn rename_workspace_folder(request: RenameWorkspaceFolderRequest) -> Result<RenamedWorkspaceFolder, String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    let directory = workspace_directory_path(&request.directory)?;
    if directory.as_os_str().is_empty() { return Err("The workspace root cannot be renamed.".into()); }
    let source = folder.join(&directory);
    if !source.is_dir() { return Err("Workspace folder does not exist.".into()); }
    let new_name = request.new_name.trim();
    if !valid_folder_name(new_name) { return Err("Enter a valid folder name.".into()); }
    let destination_relative = directory.parent().filter(|parent| !parent.as_os_str().is_empty()).map(|parent| parent.join(new_name)).unwrap_or_else(|| std::path::PathBuf::from(new_name));
    relocate_workspace_folder(&folder, &directory, &destination_relative)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveWorkspaceFolderRequest {
    folder_path: String,
    directory: String,
    /// Folder that receives `directory`; empty for the workspace root.
    target_directory: String,
}

#[tauri::command]
pub(crate) fn move_workspace_folder(request: MoveWorkspaceFolderRequest) -> Result<RenamedWorkspaceFolder, String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    let directory = workspace_directory_path(&request.directory)?;
    if directory.as_os_str().is_empty() { return Err("The workspace root cannot be moved.".into()); }
    if !folder.join(&directory).is_dir() { return Err("Workspace folder does not exist.".into()); }
    let target = workspace_directory_path(&request.target_directory)?;
    if !folder.join(&target).is_dir() { return Err("The destination folder does not exist.".into()); }
    let directory_key = filename_key(&directory.to_string_lossy());
    let target_key = filename_key(&target.to_string_lossy());
    if target_key == directory_key || target_key.starts_with(&format!("{directory_key}/")) {
        return Err("A folder cannot be moved into itself.".into());
    }
    let name = directory.file_name().ok_or("Invalid workspace folder path.")?;
    relocate_workspace_folder(&folder, &directory, &target.join(name))
}

/// Renames or moves a folder inside the workspace and repoints the metadata of every
/// source file it carries along.
fn relocate_workspace_folder(folder: &Path, directory: &Path, destination_relative: &Path) -> Result<RenamedWorkspaceFolder, String> {
    let source = folder.join(directory);
    let old_directory = directory.to_string_lossy().replace('\\', "/");
    let new_directory = destination_relative.to_string_lossy().replace('\\', "/");
    if old_directory == new_directory { return Ok(RenamedWorkspaceFolder { directory: new_directory, renamed: Vec::new() }); }
    let destination = folder.join(destination_relative);
    let metadata_path = workspace_metadata_path(folder);
    let mut metadata = read_workspace_metadata(&metadata_path)?;
    if filename_key(&old_directory) == filename_key(&new_directory) {
        // A case-only rename on a case-insensitive disk has to go through a temporary
        // name; moving away first also reveals whether a genuinely different folder
        // already owns the destination.
        let temporary = folder.join(format!(".mild-rename-{}", std::process::id()));
        fs::rename(&source, &temporary).map_err(|error| format!("Could not rename folder: {error}"))?;
        if destination.exists() {
            let _ = fs::rename(&temporary, &source);
            return Err("A folder with that name already exists.".into());
        }
        fs::rename(&temporary, &destination).map_err(|error| format!("Could not rename folder: {error}"))?;
    } else {
        if destination.exists() { return Err("A folder with that name already exists.".into()); }
        fs::rename(&source, &destination).map_err(|error| format!("Could not rename folder: {error}"))?;
    }
    let old_prefix = format!("{old_directory}/");
    let old_prefix_key = filename_key(&old_prefix);
    let mut renamed = Vec::new();
    for problem in &mut metadata.problems {
        if !filename_key(&problem.filename).starts_with(&old_prefix_key) { continue; }
        let rest: String = problem.filename.chars().skip(old_prefix.chars().count()).collect();
        let next = format!("{new_directory}/{rest}");
        renamed.push([problem.filename.clone(), next.clone()]);
        problem.filename = next;
    }
    write_workspace_metadata(&metadata_path, &metadata, "update workspace metadata")?;
    Ok(RenamedWorkspaceFolder { directory: new_directory, renamed })
}

/// Makes sure a folder is there, with every folder above it. For a shared room
/// (src/collab), where a teammate made the folder and this copy of it follows.
#[tauri::command]
pub(crate) fn ensure_workspace_folder(request: WorkspaceFolderRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    let directory = workspace_directory_path(&request.directory)?;
    fs::create_dir_all(std::path::PathBuf::from(&request.folder_path).join(directory)).map_err(|error| format!("Could not create folder: {error}"))
}

/// Removes a folder a teammate removed, and only if nothing is left in it: whatever this
/// user keeps there that the room never knew of stays, and the folder with it.
#[tauri::command]
pub(crate) fn remove_empty_workspace_folder(request: WorkspaceFolderRequest) -> Result<bool, String> {
    let _metadata = metadata_lock();
    let directory = workspace_directory_path(&request.directory)?;
    if directory.as_os_str().is_empty() { return Ok(false); }
    Ok(fs::remove_dir(std::path::PathBuf::from(&request.folder_path).join(directory)).is_ok())
}

#[tauri::command]
pub(crate) fn delete_workspace_folder(request: WorkspaceFolderRequest) -> Result<Vec<String>, String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    let directory = workspace_directory_path(&request.directory)?;
    if directory.as_os_str().is_empty() { return Err("The workspace root cannot be deleted.".into()); }
    let target = folder.join(&directory);
    if !target.is_dir() { return Err("Workspace folder does not exist.".into()); }
    let prefix = format!("{}/", directory.to_string_lossy().replace('\\', "/"));
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata = read_workspace_metadata(&metadata_path)?;
    let removed = metadata.problems.iter().filter(|problem| filename_key(&problem.filename).starts_with(&filename_key(&prefix))).map(|problem| problem.filename.clone()).collect::<Vec<_>>();
    fs::remove_dir_all(&target).map_err(|error| format!("Could not delete folder: {error}"))?;
    metadata.problems.retain(|problem| !filename_key(&problem.filename).starts_with(&filename_key(&prefix)));
    write_workspace_metadata(&metadata_path, &metadata, "update workspace metadata")?;
    Ok(removed)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveWorkspaceTestsRequest {
    folder_path: String,
    filename: String,
    tests: Vec<SavedTestCase>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    /// Present when the limits were edited; both fields empty clears them.
    #[serde(default)]
    limits: Option<ProblemLimits>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateWorkspaceSourceRequest {
    folder_path: String,
    filename: String,
    source: String,
    #[serde(default)]
    source_url: Option<String>,
}

/// A problem's own limits, as the judge states them. Either may be unknown.
#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProblemLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    time_limit_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    memory_limit_mb: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceProblemMetadata {
    pub(crate) filename: String,
    title: String,
    language: String,
    tests: Vec<SavedTestCase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) judge_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    limits: Option<ProblemLimits>,
    #[serde(default)]
    modified_at: u64,
    /// Position inside its folder when the explorer is sorted by hand. Absent until the
    /// file is dragged into place, and then the files without one follow those with one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    order: Option<u32>,
    /// Every verdict seen for this problem, oldest first. The judges only report the
    /// latest submission, so this is built up one poll at a time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) submissions: Vec<SubmissionRecord>,
}

/// One submission as a judge reported it. `at` is the judge's own submission time in
/// seconds where it gives one, which is what a contest has to count against the clock.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubmissionRecord {
    pub(crate) status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMetadata {
    version: u8,
    /// "tests" or "interactive"; absent in workspaces saved before the interactive panel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    panel_mode: Option<String>,
    pub(crate) problems: Vec<WorkspaceProblemMetadata>,
    /// Problems whose files were missing at a scan, newest first, with their tests and
    /// submissions. A file is often gone only for a moment — a `git checkout`, an editor that
    /// saves by replacing the file, a sync tool — and dropping its entry outright lost its
    /// tests for good. When a file of that name comes back, it takes its entry back.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    detached: Vec<WorkspaceProblemMetadata>,
}

impl WorkspaceMetadata {
    fn empty() -> Self {
        Self { version: 2, panel_mode: None, problems: Vec::new(), detached: Vec::new() }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceProblemOutput {
    filename: String,
    title: String,
    language: String,
    code: String,
    tests: Vec<SavedTestCase>,
    source: Option<String>,
    source_url: Option<String>,
    judge_status: Option<String>,
    limits: Option<ProblemLimits>,
    modified_at: u64,
    order: Option<u32>,
    submissions: Vec<SubmissionRecord>,
}

impl WorkspaceProblemOutput {
    /// What the frontend gets for a problem: its metadata together with its source code.
    fn new(problem: WorkspaceProblemMetadata, code: String) -> Self {
        Self {
            filename: problem.filename,
            title: problem.title,
            language: problem.language,
            code,
            tests: problem.tests,
            source: problem.source,
            source_url: problem.source_url,
            judge_status: problem.judge_status,
            limits: problem.limits,
            modified_at: problem.modified_at,
            order: problem.order,
            submissions: problem.submissions,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadedWorkspace {
    folder_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    panel_mode: Option<String>,
    problems: Vec<WorkspaceProblemOutput>,
}

fn file_modified_at(path: &std::path::Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub(crate) fn save_workspace_tests(request: SaveWorkspaceTestsRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(request.folder_path);
    let metadata_path = workspace_metadata_path(&folder);
    let json = fs::read_to_string(&metadata_path).map_err(|error| format!("Could not read workspace metadata: {error}"))?;
    let mut metadata: WorkspaceMetadata = serde_json::from_str(&json).map_err(|error| format!("Invalid workspace metadata: {error}"))?;
    let problem = metadata.problems.iter_mut().find(|problem| problem.filename.eq_ignore_ascii_case(&request.filename)).ok_or("Workspace file metadata was not found.")?;
    problem.tests = request.tests;
    if request.source.is_some() {
        problem.source = request.source;
    }
    if request.source_url.is_some() {
        problem.source_url = request.source_url;
    }
    if let Some(limits) = request.limits {
        problem.limits = (limits != ProblemLimits::default()).then_some(limits);
    }
    write_workspace_metadata(&metadata_path, &metadata, "save test cases")
}

#[tauri::command]
pub(crate) fn update_workspace_source(request: UpdateWorkspaceSourceRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    if !matches!(request.source.as_str(), "atcoder" | "codeforces" | "doj" | "other") {
        return Err("Unknown problem source.".into());
    }
    let folder = std::path::PathBuf::from(request.folder_path);
    let metadata_path = workspace_metadata_path(&folder);
    let json = fs::read_to_string(&metadata_path).map_err(|error| format!("Could not read workspace metadata: {error}"))?;
    let mut metadata: WorkspaceMetadata = serde_json::from_str(&json).map_err(|error| format!("Invalid workspace metadata: {error}"))?;
    let problem = metadata.problems.iter_mut().find(|problem| problem.filename.eq_ignore_ascii_case(&request.filename)).ok_or("Workspace file metadata was not found.")?;
    problem.source = Some(request.source.clone());
    problem.source_url = if request.source == "other" { None } else { request.source_url.map(|url| url.trim().to_string()).filter(|url| !url.is_empty()) };
    problem.judge_status = None;
    write_workspace_metadata(&metadata_path, &metadata, "update problem source")
}

fn safe_filename(filename: &str, language: &str) -> Result<String, String> {
    let (filename, detected_language) = workspace_source_filename(filename)?;
    let path = Path::new(&filename);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let valid_extension = match language {
        "cpp" => ["cpp", "cc", "cxx"].contains(&extension.as_str()),
        "python" => extension == "py",
        _ => false,
    };
    if !valid_extension {
        return Err(format!("The language does not match the file extension: {filename}"));
    }
    if detected_language != language { return Err(format!("The language does not match the file extension: {filename}")); }
    Ok(filename.to_string())
}

fn workspace_source_filename(filename: &str) -> Result<(String, String), String> {
    let normalized = workspace_relative_filename(filename)?;
    let path = Path::new(&normalized);
    let language = match path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()).as_deref() {
        Some("cpp") | Some("cc") | Some("cxx") => "cpp",
        Some("py") => "python",
        _ => return Err("Workspace files must use .cpp, .cc, .cxx, or .py.".into()),
    };
    Ok((normalized, language.to_string()))
}

fn workspace_relative_filename(filename: &str) -> Result<String, String> {
    let normalized = filename.trim().replace('\\', "/");
    let path = Path::new(&normalized);
    if normalized.is_empty() || path.is_absolute() || path.components().any(|component| !matches!(component, std::path::Component::Normal(_))) {
        return Err("Invalid workspace filename.".into());
    }
    Ok(normalized)
}

fn workspace_directory_path(directory: &str) -> Result<std::path::PathBuf, String> {
    let normalized = directory.trim().replace('\\', "/");
    if normalized.is_empty() { return Ok(std::path::PathBuf::new()); }
    let path = Path::new(&normalized);
    if path.is_absolute() || path.components().any(|component| !matches!(component, std::path::Component::Normal(_))) {
        return Err("Invalid workspace folder path.".into());
    }
    Ok(path.to_path_buf())
}

fn ignored_workspace_directory(name: &str) -> bool {
    name.starts_with('.') || matches!(name.to_ascii_lowercase().as_str(), "node_modules" | "target" | "dist" | "build" | "venv" | "__pycache__")
}

fn workspace_relative_path(folder: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(folder).ok().map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

/// Calls `visit` with the workspace-relative path of everything below `current`, and
/// whether it is a folder. Ignored folders are neither reported nor entered.
fn walk_workspace(folder: &Path, current: &Path, visit: &mut dyn FnMut(String, bool)) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| format!("Could not read workspace folder: {error}"))?.flatten() {
        let path = entry.path();
        let is_directory = path.is_dir();
        if is_directory && ignored_workspace_directory(&entry.file_name().to_string_lossy()) { continue; }
        if let Some(relative) = workspace_relative_path(folder, &path) { visit(relative, is_directory); }
        if is_directory { walk_workspace(folder, &path, visit)?; }
    }
    Ok(())
}

/// Every source file in the workspace, sorted the way the metadata lists them.
fn workspace_source_filenames(folder: &Path) -> Result<Vec<String>, String> {
    let mut filenames = Vec::new();
    walk_workspace(folder, folder, &mut |relative, is_directory| {
        if !is_directory && workspace_source_filename(&relative).is_ok() { filenames.push(relative); }
    })?;
    filenames.sort_by_key(|filename| filename_key(filename));
    Ok(filenames)
}

fn sync_workspace_source_files(folder: &Path, metadata: &mut WorkspaceMetadata) -> Result<(), String> {
    let disk_files = workspace_source_filenames(folder)?.into_iter().filter_map(|filename| {
        let (_, language) = workspace_source_filename(&filename).ok()?;
        let path = folder.join(&filename);
        Some((filename, language, path))
    }).collect::<Vec<_>>();
    let disk_keys = disk_files.iter().map(|(filename, _, _)| filename_key(filename)).collect::<std::collections::HashSet<_>>();
    let (kept, gone): (Vec<_>, Vec<_>) = metadata.problems.drain(..).partition(|problem| disk_keys.contains(&filename_key(&problem.filename)));
    metadata.problems = kept;
    for problem in gone {
        metadata.detached.retain(|item| filename_key(&item.filename) != filename_key(&problem.filename));
        metadata.detached.insert(0, problem);
    }
    metadata.detached.truncate(MAX_DETACHED);
    for (filename, language, source_path) in disk_files {
        if let Some(problem) = metadata.problems.iter_mut().find(|problem| filename_key(&problem.filename) == filename_key(&filename)) {
            problem.filename = filename;
            problem.language = language;
            problem.modified_at = file_modified_at(&source_path);
        } else if let Some(index) = metadata.detached.iter().position(|item| filename_key(&item.filename) == filename_key(&filename)) {
            let mut problem = metadata.detached.remove(index);
            problem.filename = filename;
            problem.language = language;
            problem.modified_at = file_modified_at(&source_path);
            metadata.problems.push(problem);
        } else {
            metadata.problems.push(WorkspaceProblemMetadata {
                title: Path::new(&filename).file_stem().and_then(|value| value.to_str()).unwrap_or(&filename).to_string(),
                filename,
                language,
                tests: Vec::new(),
                source: Some("other".into()),
                source_url: None,
                judge_status: None, limits: None,
                modified_at: file_modified_at(&source_path),
                order: None,
                submissions: Vec::new(),
            });
        }
    }
    metadata.problems.sort_by_key(|problem| filename_key(&problem.filename));
    Ok(())
}

fn filename_key(filename: &str) -> String {
    filename.trim().replace('\\', "/").to_lowercase()
}

fn strip_copy_suffix(stem: &str) -> &str {
    let Some(prefix) = stem.strip_suffix(')') else { return stem };
    let Some(open) = prefix.rfind(" (") else { return stem };
    let number = &prefix[open + 2..];
    if !number.is_empty() && !number.starts_with('0') && number.chars().all(|character| character.is_ascii_digit()) {
        &prefix[..open]
    } else {
        stem
    }
}

fn unique_workspace_filename(folder: &Path, requested: &str, metadata: &WorkspaceMetadata, exclude: Option<&str>) -> String {
    let excluded = exclude.map(filename_key);
    let mut occupied = metadata.problems.iter().map(|problem| problem.filename.clone()).collect::<Vec<_>>();
    if let Ok(files) = workspace_source_filenames(folder) { occupied.extend(files); }
    let occupied = occupied.into_iter()
        .filter(|filename| excluded.as_ref().map_or(true, |excluded| filename_key(filename) != *excluded))
        .map(|filename| filename_key(&filename))
        .collect::<std::collections::HashSet<_>>();
    if !occupied.contains(&filename_key(requested)) { return requested.to_string(); }

    let path = Path::new(requested);
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty());
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or(requested);
    let base = strip_copy_suffix(stem);
    let extension = path.extension().and_then(|value| value.to_str()).map(|value| format!(".{value}")).unwrap_or_default();
    for number in 1.. {
        let leaf = format!("{base} ({number}){extension}");
        let candidate = parent.map(|parent| parent.join(&leaf).to_string_lossy().replace('\\', "/")).unwrap_or(leaf);
        if !occupied.contains(&filename_key(&candidate)) { return candidate; }
    }
    unreachable!()
}

#[tauri::command]
pub(crate) fn save_workspace(request: SaveWorkspaceRequest) -> Result<LoadedWorkspace, String> {
    let _metadata = metadata_lock();
    if request.problems.is_empty() {
        return Err("There are no problems to save.".into());
    }
    let folder = std::path::PathBuf::from(&request.folder_path);
    fs::create_dir_all(&folder)
        .map_err(|error| format!("Could not create the workspace folder: {error}"))?;
    let mut new_filenames = std::collections::HashSet::new();
    let mut supported_problems = Vec::new();
    for problem in request.problems {
        let normalized = workspace_relative_filename(&problem.filename)?;
        if workspace_source_filename(&normalized).is_err() { continue; }
        let filename = safe_filename(&normalized, &problem.language)?;
        if !new_filenames.insert(filename_key(&filename)) {
            return Err(format!("Duplicate filename: {filename}"));
        }
        supported_problems.push((problem, filename));
    }
    let previous_metadata = metadata_to_update(&workspace_metadata_path(&folder))?;
    let panel_mode = previous_metadata.panel_mode;
    let detached = previous_metadata.detached;
    let mut metadata_problems = previous_metadata.problems;
    let mut outputs = Vec::new();
    for (problem, filename) in supported_problems {
        if let Some(parent) = folder.join(&filename).parent() { fs::create_dir_all(parent).map_err(|error| format!("Could not create source folder: {error}"))?; }
        let source_path = folder.join(&filename);
        let mut code = problem.code;
        match plan_source_write(&source_path, &code) {
            SourceWrite::Unchanged => remember_text(&source_path, &code),
            SourceWrite::KeepDisk(disk) => code = disk,
            SourceWrite::Write => {
                fs::write(&source_path, &code).map_err(|error| format!("Could not save {filename}: {error}"))?;
                remember_text(&source_path, &code);
            }
        }
        let modified_at = file_modified_at(&folder.join(&filename));
        let logical_modified_at = problem.modified_at.unwrap_or(modified_at);
        // The arranged position and the submission history are not the frontend's to
        // send, so a problem saved again keeps the ones it had.
        let existing = metadata_problems.iter().position(|item| item.filename == filename);
        let metadata_problem = WorkspaceProblemMetadata {
            filename,
            title: problem.title,
            language: problem.language,
            tests: problem.tests,
            source: problem.source,
            source_url: problem.source_url,
            judge_status: problem.judge_status, limits: problem.limits,
            modified_at: logical_modified_at,
            order: existing.and_then(|index| metadata_problems[index].order),
            submissions: existing.map(|index| metadata_problems[index].submissions.clone()).unwrap_or_default(),
        };
        outputs.push(WorkspaceProblemOutput::new(metadata_problem.clone(), code));
        match existing {
            Some(index) => metadata_problems[index] = metadata_problem,
            None => metadata_problems.push(metadata_problem),
        }
    }
    let metadata = WorkspaceMetadata {
        version: 2,
        panel_mode: panel_mode.clone(),
        problems: metadata_problems,
        detached,
    };
    write_workspace_metadata(&workspace_metadata_path(&folder), &metadata, "save workspace metadata")?;
    Ok(LoadedWorkspace {
        folder_path: folder.to_string_lossy().into_owned(),
        panel_mode,
        problems: outputs,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavePanelModeRequest {
    folder_path: String,
    panel_mode: String,
}

#[tauri::command]
pub(crate) fn save_workspace_panel_mode(request: SavePanelModeRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    if !matches!(request.panel_mode.as_str(), "tests" | "interactive") {
        return Err("Unknown panel mode.".into());
    }
    let folder = std::path::PathBuf::from(&request.folder_path);
    let metadata_path = workspace_metadata_path(&folder);
    let json = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("Could not read workspace metadata: {error}"))?;
    let mut metadata: WorkspaceMetadata = serde_json::from_str(&json)
        .map_err(|error| format!("Invalid workspace metadata: {error}"))?;
    if metadata.panel_mode.as_deref() == Some(request.panel_mode.as_str()) {
        return Ok(());
    }
    metadata.panel_mode = Some(request.panel_mode);
    write_workspace_metadata(&metadata_path, &metadata, "save workspace metadata")
}

#[tauri::command]
pub(crate) fn create_workspace(request: WorkspaceRequest) -> Result<LoadedWorkspace, String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    fs::create_dir_all(&folder).map_err(|error| format!("Could not create project folder: {error}"))?;
    let metadata_path = workspace_metadata_path(&folder);
    if metadata_path.exists() {
        return Err(".mild-editor.json already exists in this folder. Use Open instead.".into());
    }
    write_workspace_metadata(&metadata_path, &WorkspaceMetadata::empty(), "create project metadata")?;
    Ok(LoadedWorkspace { folder_path: folder.to_string_lossy().into_owned(), panel_mode: None, problems: Vec::new() })
}

#[tauri::command]
pub(crate) fn delete_workspace_file(request: WorkspaceFileRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata = read_workspace_metadata(&metadata_path)?;
    metadata.problems.retain(|problem| problem.filename != filename);
    let source = folder.join(&filename);
    if source.exists() { fs::remove_file(&source).map_err(|error| format!("Could not delete source file: {error}"))?; }
    write_workspace_metadata(&metadata_path, &metadata, "update workspace metadata")
}

#[tauri::command]
pub(crate) fn open_workspace_file_location(request: WorkspaceFileRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let source = folder.join(filename);
    if !source.exists() { return Err("Workspace source file does not exist.".into()); }
    reveal_in_file_manager(&source, &folder, "file")
}

#[tauri::command]
pub(crate) fn open_workspace_folder_location(request: WorkspaceFolderRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    let directory = workspace_directory_path(&request.directory)?;
    if directory.as_os_str().is_empty() { return Err("Select a workspace folder.".into()); }
    let target = folder.join(directory);
    if !target.is_dir() { return Err("Workspace folder does not exist.".into()); }
    reveal_in_file_manager(&target, target.parent().unwrap_or(&folder), "folder")
}

/// Shows `target` selected in Explorer or Finder. `xdg-open` cannot select anything, so
/// on Linux `linux_directory` is opened instead.
fn reveal_in_file_manager(target: &Path, linux_directory: &Path, kind: &str) -> Result<(), String> {
    let shown = if cfg!(any(windows, target_os = "macos")) { target } else { linux_directory };
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        // Explorer requires the switch outside the quotes: /select,"C:\\path with spaces\\file.cpp".
        // Command::arg quotes the whole argument when it contains spaces, which makes Explorer
        // ignore /select. raw_arg preserves the syntax expected by Explorer.
        std::os::windows::process::CommandExt::raw_arg(&mut command, windows_explorer_select_argument(shown));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(shown);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(shown);
        command
    };
    command.spawn().map_err(|error| format!("Could not open {kind} location: {error}"))?;
    Ok(())
}

#[cfg(windows)]
fn windows_explorer_select_argument(source: &Path) -> String {
    format!("/select,\"{}\"", source.to_string_lossy().replace('/', "\\"))
}

#[tauri::command]
pub(crate) fn duplicate_workspace_file(request: RenameWorkspaceFileRequest) -> Result<WorkspaceProblemOutput, String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let (requested_filename, _) = workspace_source_filename(&request.new_filename)?;
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata = read_workspace_metadata(&metadata_path)?;
    let new_filename = unique_workspace_filename(&folder, &requested_filename, &metadata, None);
    let (_, new_language) = workspace_source_filename(&new_filename)?;
    let source_problem = metadata.problems.iter().find(|problem| problem.filename == filename).cloned().ok_or("Workspace file metadata was not found.")?;
    let source = folder.join(&filename);
    let destination = folder.join(&new_filename);
    fs::copy(&source, &destination).map_err(|error| format!("Could not duplicate source file: {error}"))?;
    let code = read_source_text(&destination).map_err(|error| format!("Could not read duplicated source file: {error}"))?;
    remember_text(&destination, &code);
    // The copy starts with everything the original has except its submissions.
    let duplicated = WorkspaceProblemMetadata { filename: new_filename, language: new_language, modified_at: file_modified_at(&destination), submissions: Vec::new(), ..source_problem };
    metadata.problems.push(duplicated.clone());
    write_workspace_metadata(&metadata_path, &metadata, "update workspace metadata")?;
    Ok(WorkspaceProblemOutput::new(duplicated, code))
}

#[tauri::command]
pub(crate) fn rename_workspace_file(request: RenameWorkspaceFileRequest) -> Result<WorkspaceProblemOutput, String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let (requested_filename, _) = workspace_source_filename(&request.new_filename)?;
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata = read_workspace_metadata(&metadata_path)?;
    let new_filename = unique_workspace_filename(&folder, &requested_filename, &metadata, Some(&filename));
    let (_, new_language) = workspace_source_filename(&new_filename)?;
    let problem = metadata.problems.iter_mut().find(|problem| problem.filename == filename).ok_or("Workspace file metadata was not found.")?;
    let source_path = folder.join(&filename);
    let destination_path = folder.join(&new_filename);
    // A rename that carries the file into another folder is how the explorer moves it, and
    // the target may be a folder the workspace knows only from metadata.
    if let Some(parent) = destination_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create the destination folder: {error}"))?;
    }
    if filename != new_filename && filename.eq_ignore_ascii_case(&new_filename) {
        let temporary_path = folder.join(format!(".mild-rename-{}", std::process::id()));
        fs::rename(&source_path, &temporary_path).map_err(|error| format!("Could not rename source file: {error}"))?;
        fs::rename(&temporary_path, &destination_path).map_err(|error| format!("Could not rename source file: {error}"))?;
    } else {
        fs::rename(&source_path, &destination_path).map_err(|error| format!("Could not rename source file: {error}"))?;
    }
    problem.filename = new_filename;
    problem.language = new_language;
    let code = read_source_text(&destination_path).map_err(|error| format!("Could not read renamed source file: {error}"))?;
    remember_text(&destination_path, &code);
    let result = WorkspaceProblemOutput::new(problem.clone(), code);
    write_workspace_metadata(&metadata_path, &metadata, "update workspace metadata")?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn load_workspace(path: String) -> Result<LoadedWorkspace, String> {
    let _metadata = metadata_lock();
    let selected = std::path::PathBuf::from(path);
    let folder = if selected.is_dir() {
        selected.clone()
    } else {
        selected
            .parent()
            .ok_or("Could not find the selected file's parent folder.")?
            .to_path_buf()
    };
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata: WorkspaceMetadata = if metadata_path.exists() {
        let json = fs::read_to_string(&metadata_path)
            .map_err(|error| format!("Could not read workspace metadata: {error}"))?;
        match serde_json::from_str(&json) {
            Ok(metadata) => metadata,
            Err(_) => {
                let old: ProblemMetadata = serde_json::from_str(&json)
                    .map_err(|error| format!("Invalid .mild-editor.json format: {error}"))?;
                WorkspaceMetadata {
                    version: 2,
                    panel_mode: None,
                    detached: Vec::new(),
                    problems: vec![WorkspaceProblemMetadata {
                        filename: if old.language == "python" { "main.py".into() } else { "main.cpp".into() },
                        title: old.title,
                        language: old.language,
                        tests: old.tests,
                        source: None,
                        source_url: None,
                        judge_status: None, limits: None,
                        modified_at: 0,
                        order: None,
                        submissions: Vec::new(),
                    }],
                }
            }
        }
    } else {
        WorkspaceMetadata::empty()
    };
    let panel_mode = metadata.panel_mode.clone();
    sync_workspace_source_files(&folder, &mut metadata)?;
    write_workspace_metadata(&metadata_path, &metadata, "update workspace metadata")?;
    Ok(LoadedWorkspace {
        problems: read_workspace_problems(&folder, metadata)?,
        folder_path: folder.to_string_lossy().into_owned(),
        panel_mode,
    })
}

fn read_workspace_problems(folder: &Path, metadata: WorkspaceMetadata) -> Result<Vec<WorkspaceProblemOutput>, String> {
    let mut problems = Vec::new();
    for mut problem in metadata.problems {
        let source_path = folder.join(&problem.filename);
        // A file that cannot be read right now is left out of this list rather than failing
        // the load of every other one; its metadata stays, and the next scan brings it back.
        let Ok(code) = read_source_text(&source_path) else { continue };
        remember_text(&source_path, &code);
        if problem.modified_at == 0 { problem.modified_at = file_modified_at(&source_path); }
        problems.push(WorkspaceProblemOutput::new(problem, code));
    }
    Ok(problems)
}

/// Rescans the folder and returns every source file in it. Files created, deleted or
/// renamed outside the editor only reach `.mild-editor.json` through a scan, and the one
/// in `load_workspace` runs at start-up, so without this the explorer would not show them
/// until the workspace was opened again.
#[tauri::command]
pub(crate) fn reload_workspace_files(request: WorkspaceRequest) -> Result<Vec<WorkspaceProblemOutput>, String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    if !folder.is_dir() { return Err("The workspace folder is gone.".into()); }
    let metadata_path = workspace_metadata_path(&folder);
    // Only a missing file is an empty workspace. One that could not be read just now would
    // otherwise be rewritten below from the scan alone, without anyone's tests.
    let mut metadata: WorkspaceMetadata = match fs::read_to_string(&metadata_path) {
        Ok(json) => serde_json::from_str(&json).map_err(|error| format!("Invalid .mild-editor.json format: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => WorkspaceMetadata::empty(),
        Err(error) => return Err(format!("Could not read workspace metadata: {error}")),
    };
    let before = serde_json::to_string(&metadata).unwrap_or_default();
    sync_workspace_source_files(&folder, &mut metadata)?;
    // Only written when the scan found something, so an idle editor does not keep
    // rewriting the file and changing its timestamp.
    if serde_json::to_string(&metadata).unwrap_or_default() != before {
        write_workspace_metadata(&metadata_path, &metadata, "update workspace metadata")?;
    }
    read_workspace_problems(&folder, metadata)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReorderWorkspaceFilesRequest {
    folder_path: String,
    /// The folder whose files are being arranged; empty for the workspace root.
    directory: String,
    /// Every source file of that folder, in the order the explorer should show them.
    filenames: Vec<String>,
}

/// Records the order the explorer shows a folder's files in, so a drag between two rows
/// survives a restart. Files of other folders keep the order they had.
#[tauri::command]
pub(crate) fn reorder_workspace_files(request: ReorderWorkspaceFilesRequest) -> Result<(), String> {
    let _metadata = metadata_lock();
    let folder = std::path::PathBuf::from(&request.folder_path);
    let directory = workspace_directory_path(&request.directory)?.to_string_lossy().replace('\\', "/");
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata = read_workspace_metadata(&metadata_path)?;
    let wanted: Vec<String> = request.filenames.iter()
        .map(|filename| workspace_relative_filename(filename))
        .collect::<Result<Vec<_>, _>>()?
        .iter().map(|filename| filename_key(filename)).collect();
    for problem in &mut metadata.problems {
        let parent = Path::new(&problem.filename).parent().map(|parent| parent.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        if !parent.eq_ignore_ascii_case(&directory) { continue; }
        // A file of this folder that the caller did not list keeps no position, so it
        // falls in with the ones that were never arranged.
        problem.order = wanted.iter().position(|key| *key == filename_key(&problem.filename)).map(|index| index as u32);
    }
    write_workspace_metadata(&metadata_path, &metadata, "update workspace metadata")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn explorer_select_argument_keeps_switch_outside_quoted_path() {
        let path = Path::new(r"C:\contest folder\A.cpp");
        assert_eq!(windows_explorer_select_argument(path), r#"/select,"C:\contest folder\A.cpp""#);
        let nested = Path::new("C:/contest folder/round/A.cpp");
        assert_eq!(windows_explorer_select_argument(nested), r#"/select,"C:\contest folder\round\A.cpp""#);
    }

    #[test]
    fn filename_allocator_uses_smallest_free_suffix_per_extension() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        fs::write(directory.path().join("A.cpp"), "").unwrap();
        fs::write(directory.path().join("A (2).CPP"), "").unwrap();
        fs::write(directory.path().join("A.py"), "").unwrap();
        let metadata = WorkspaceMetadata::empty();

        assert_eq!(unique_workspace_filename(directory.path(), "A.cpp", &metadata, None), "A (1).cpp");
        assert_eq!(unique_workspace_filename(directory.path(), "A (2).cpp", &metadata, None), "A (1).cpp");
        assert_eq!(unique_workspace_filename(directory.path(), "A.py", &metadata, None), "A (1).py");
        assert_eq!(unique_workspace_filename(directory.path(), "A.cpp", &metadata, Some("A.cpp")), "A.cpp");
        assert_eq!(safe_filename("346.CPP", "cpp").unwrap(), "346.CPP");
        assert_eq!(safe_filename("script.PY", "python").unwrap(), "script.PY");
    }

    #[test]
    fn problem_limits_survive_a_save_an_edit_and_a_load() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).expect("create workspace");
        let imported = ProblemLimits { time_limit_ms: Some(1000), memory_limit_mb: Some(256) };
        let saved = save_workspace(SaveWorkspaceRequest {
            folder_path: folder_path.clone(),
            problems: vec![WorkspaceProblemInput {
                filename: "A.cpp".into(), title: "A".into(), language: "cpp".into(), code: "int main() {}".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, limits: Some(imported), modified_at: None,
            }],
        }).expect("save source");
        assert_eq!(saved.problems[0].limits, Some(imported));

        let edit = |limits: Option<ProblemLimits>| save_workspace_tests(SaveWorkspaceTestsRequest {
            folder_path: folder_path.clone(), filename: "A.cpp".into(), tests: Vec::new(), source: None, source_url: None, limits,
        }).expect("save tests");
        let loaded = || load_workspace(folder_path.clone()).expect("load workspace").problems[0].limits;

        // Saving test cases alone leaves the limits as they were.
        edit(None);
        assert_eq!(loaded(), Some(imported));
        let edited = ProblemLimits { time_limit_ms: Some(3000), memory_limit_mb: None };
        edit(Some(edited));
        assert_eq!(loaded(), Some(edited));
        // Both fields emptied: back to the defaults, and nothing left in the file.
        edit(Some(ProblemLimits::default()));
        assert_eq!(loaded(), None);
    }

    #[test]
    fn a_rescan_picks_up_files_added_outside_the_editor_and_keeps_the_arranged_order() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).expect("create workspace");
        save_workspace(SaveWorkspaceRequest {
            folder_path: folder_path.clone(),
            problems: vec![WorkspaceProblemInput {
                filename: "B.cpp".into(), title: "B".into(), language: "cpp".into(), code: "int main() {}".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, limits: None, modified_at: None,
            }],
        }).expect("save source");

        // Something outside the editor drops two files into the folder.
        fs::write(directory.path().join("A.py"), "print(1)").expect("write A");
        fs::create_dir(directory.path().join("day2")).expect("subfolder");
        fs::write(directory.path().join("day2").join("C.cpp"), "int main() {}").expect("write C");

        let files = reload_workspace_files(WorkspaceRequest { folder_path: folder_path.clone() }).expect("rescan");
        let names: Vec<&str> = files.iter().map(|problem| problem.filename.as_str()).collect();
        assert_eq!(names, vec!["A.py", "B.cpp", "day2/C.cpp"]);
        assert_eq!(files.iter().find(|problem| problem.filename == "A.py").expect("A").language, "python");
        // The rescan does not disturb what was already known.
        assert_eq!(files.iter().find(|problem| problem.filename == "B.cpp").expect("B").title, "B");

        reorder_workspace_files(ReorderWorkspaceFilesRequest {
            folder_path: folder_path.clone(), directory: String::new(), filenames: vec!["B.cpp".into(), "A.py".into()],
        }).expect("reorder the root");
        let arranged = reload_workspace_files(WorkspaceRequest { folder_path: folder_path.clone() }).expect("rescan again");
        let order = |name: &str| arranged.iter().find(|problem| problem.filename == name).expect("problem").order;
        assert_eq!((order("B.cpp"), order("A.py")), (Some(0), Some(1)));
        // A file of another folder is not touched by that folder's arrangement.
        assert_eq!(order("day2/C.cpp"), None);

        // Saving a file again keeps the place it was dragged to.
        save_workspace(SaveWorkspaceRequest {
            folder_path: folder_path.clone(),
            problems: vec![WorkspaceProblemInput {
                filename: "A.py".into(), title: "A".into(), language: "python".into(), code: "print(2)".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, limits: None, modified_at: None,
            }],
        }).expect("save again");
        let after = reload_workspace_files(WorkspaceRequest { folder_path: folder_path.clone() }).expect("rescan once more");
        assert_eq!(after.iter().find(|problem| problem.filename == "A.py").expect("A").order, Some(1));
        // Saving one file alone is how the counterexample dialog creates a problem's helpers,
        // so it has to leave every other problem in the workspace exactly as it was.
        assert_eq!(after.iter().find(|problem| problem.filename == "B.cpp").expect("B").title, "B");
        assert_eq!(after.iter().find(|problem| problem.filename == "day2/C.cpp").expect("C").filename, "day2/C.cpp");
        assert_eq!(after.len(), 3);

        // Deleting outside the editor drops the file from the metadata too.
        fs::remove_file(directory.path().join("B.cpp")).expect("delete B");
        let pruned = reload_workspace_files(WorkspaceRequest { folder_path }).expect("final rescan");
        assert!(!pruned.iter().any(|problem| problem.filename == "B.cpp"));
    }

    #[test]
    fn moving_files_and_folders_keeps_metadata_in_sync() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).expect("create workspace");
        save_workspace(SaveWorkspaceRequest {
            folder_path: folder_path.clone(),
            problems: vec![WorkspaceProblemInput {
                filename: "A.cpp".into(), title: "A".into(), language: "cpp".into(), code: "int main() {}".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, limits: None, modified_at: None,
            }],
        }).expect("save source");

        // A file moves by a rename into a folder, which is created when it is not there yet.
        let moved = rename_workspace_file(RenameWorkspaceFileRequest { folder_path: folder_path.clone(), filename: "A.cpp".into(), new_filename: "abc400/A.cpp".into() }).expect("move file");
        assert_eq!(moved.filename, "abc400/A.cpp");
        assert!(directory.path().join("abc400").join("A.cpp").exists());

        fs::create_dir(directory.path().join("AtCoder")).expect("target folder");
        let relocated = move_workspace_folder(MoveWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "abc400".into(), target_directory: "AtCoder".into() }).expect("move folder");
        assert_eq!(relocated.directory, "AtCoder/abc400");
        assert_eq!(relocated.renamed, vec![["abc400/A.cpp".to_string(), "AtCoder/abc400/A.cpp".to_string()]]);
        assert!(directory.path().join("AtCoder").join("abc400").join("A.cpp").exists());
        let loaded = load_workspace(folder_path.clone()).expect("load workspace");
        assert_eq!(loaded.problems.iter().map(|problem| problem.filename.as_str()).collect::<Vec<_>>(), vec!["AtCoder/abc400/A.cpp"]);

        assert!(move_workspace_folder(MoveWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "AtCoder".into(), target_directory: "AtCoder/abc400".into() }).is_err());
        let back = move_workspace_folder(MoveWorkspaceFolderRequest { folder_path, directory: "AtCoder/abc400".into(), target_directory: "".into() }).expect("move to the root");
        assert_eq!(back.directory, "abc400");
    }

    #[test]
    fn rename_duplicate_and_delete_keep_files_and_metadata_in_sync() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).expect("create workspace");
        save_workspace(SaveWorkspaceRequest {
            folder_path: folder_path.clone(),
            problems: vec![WorkspaceProblemInput {
                filename: "A.cpp".into(), title: "A".into(), language: "cpp".into(), code: "int main() {}".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, limits: None, modified_at: None,
            }],
        }).expect("save source");

        let renamed = rename_workspace_file(RenameWorkspaceFileRequest { folder_path: folder_path.clone(), filename: "A.cpp".into(), new_filename: "B.cpp".into() }).expect("rename source");
        assert_eq!(renamed.filename, "B.cpp");
        assert!(!directory.path().join("A.cpp").exists());
        assert!(directory.path().join("B.cpp").exists());

        update_workspace_source(UpdateWorkspaceSourceRequest {
            folder_path: folder_path.clone(), filename: "B.cpp".into(), source: "codeforces".into(), source_url: Some("https://codeforces.com/contest/2231/problem/C".into()),
        }).expect("classify source");

        let duplicated = duplicate_workspace_file(RenameWorkspaceFileRequest { folder_path: folder_path.clone(), filename: "B.cpp".into(), new_filename: "B copy.cpp".into() }).expect("duplicate source");
        assert_eq!(duplicated.filename, "B copy.cpp");
        assert!(directory.path().join("B copy.cpp").exists());

        delete_workspace_file(WorkspaceFileRequest { folder_path, filename: "B.cpp".into() }).expect("delete source");
        assert!(!directory.path().join("B.cpp").exists());
        let metadata: WorkspaceMetadata = serde_json::from_str(&fs::read_to_string(directory.path().join(WORKSPACE_METADATA_FILENAME)).expect("read metadata")).expect("parse metadata");
        assert_eq!(metadata.problems.len(), 1);
        assert_eq!(metadata.problems[0].filename, "B copy.cpp");
        assert_eq!(metadata.problems[0].source.as_deref(), Some("codeforces"));
        assert_eq!(metadata.problems[0].source_url.as_deref(), Some("https://codeforces.com/contest/2231/problem/C"));
    }

    #[test]
    fn workspace_load_registers_external_sources_and_removes_missing_ones() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).expect("create workspace");
        fs::write(directory.path().join("external.cpp"), "int main() { return 0; }").unwrap();
        fs::write(directory.path().join("script.py"), "print(1)").unwrap();
        fs::create_dir(directory.path().join("round-1")).unwrap();
        fs::write(directory.path().join("round-1").join("B.cpp"), "int main() {}").unwrap();
        fs::write(directory.path().join("notes.txt"), "ignore me").unwrap();

        let loaded = load_workspace(folder_path.clone()).expect("load workspace");
        assert_eq!(loaded.problems.iter().map(|problem| problem.filename.as_str()).collect::<Vec<_>>(), vec!["external.cpp", "round-1/B.cpp", "script.py"]);
        let metadata: WorkspaceMetadata = serde_json::from_str(&fs::read_to_string(directory.path().join(WORKSPACE_METADATA_FILENAME)).unwrap()).unwrap();
        assert_eq!(metadata.problems.len(), 3);

        fs::remove_file(directory.path().join("external.cpp")).unwrap();
        let loaded = load_workspace(folder_path).expect("reload workspace");
        assert_eq!(loaded.problems.len(), 2);
        assert_eq!(loaded.problems[0].filename, "round-1/B.cpp");
    }

    #[test]
    fn workspace_folder_creation_uses_first_free_suffix() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        fs::create_dir(directory.path().join("solutions")).unwrap();
        let created = create_workspace_folder(CreateWorkspaceFolderRequest { folder_path: folder_path.clone(), name: "solutions".into(), parent_directory: String::new() }).unwrap();
        assert_eq!(created, "solutions (1)");
        let nested = create_workspace_folder(CreateWorkspaceFolderRequest { folder_path: folder_path.clone(), name: "round".into(), parent_directory: "solutions".into() }).unwrap();
        assert_eq!(nested, "solutions/round");
        assert_eq!(list_workspace_directories(WorkspaceRequest { folder_path }).unwrap(), vec!["solutions", "solutions (1)", "solutions/round"]);
    }

    #[test]
    fn deleting_workspace_folder_removes_nested_sources_and_metadata() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).unwrap();
        create_workspace_folder(CreateWorkspaceFolderRequest { folder_path: folder_path.clone(), name: "round".into(), parent_directory: String::new() }).unwrap();
        save_workspace(SaveWorkspaceRequest { folder_path: folder_path.clone(), problems: vec![WorkspaceProblemInput {
            filename: "round/A.cpp".into(), title: "A".into(), language: "cpp".into(), code: "int main() {}".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, limits: None, modified_at: None,
        }] }).unwrap();

        let removed = delete_workspace_folder(WorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "round".into() }).unwrap();
        assert_eq!(removed, vec!["round/A.cpp"]);
        assert!(!directory.path().join("round").exists());
        let metadata: WorkspaceMetadata = serde_json::from_str(&fs::read_to_string(directory.path().join(WORKSPACE_METADATA_FILENAME)).unwrap()).unwrap();
        assert!(metadata.problems.is_empty());
    }

    #[test]
    fn renaming_workspace_folder_moves_nested_sources_and_metadata() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).unwrap();
        create_workspace_folder(CreateWorkspaceFolderRequest { folder_path: folder_path.clone(), name: "round".into(), parent_directory: String::new() }).unwrap();
        create_workspace_folder(CreateWorkspaceFolderRequest { folder_path: folder_path.clone(), name: "div2".into(), parent_directory: "round".into() }).unwrap();
        let problem = |filename: &str, language: &str| WorkspaceProblemInput {
            filename: filename.into(), title: filename.into(), language: language.into(), code: "x".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, limits: None, modified_at: None,
        };
        save_workspace(SaveWorkspaceRequest { folder_path: folder_path.clone(), problems: vec![problem("round/A.cpp", "cpp"), problem("round/div2/B.py", "python"), problem("C.cpp", "cpp")] }).unwrap();
        let metadata_filenames = || {
            let metadata: WorkspaceMetadata = serde_json::from_str(&fs::read_to_string(directory.path().join(WORKSPACE_METADATA_FILENAME)).unwrap()).unwrap();
            let mut names: Vec<String> = metadata.problems.iter().map(|problem| problem.filename.clone()).collect();
            names.sort();
            names
        };

        let result = rename_workspace_folder(RenameWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "round".into(), new_name: "contest".into() }).unwrap();
        assert_eq!(result.directory, "contest");
        let mut moved = result.renamed.clone();
        moved.sort();
        assert_eq!(moved, vec![["round/A.cpp".to_string(), "contest/A.cpp".to_string()], ["round/div2/B.py".to_string(), "contest/div2/B.py".to_string()]]);
        assert!(!directory.path().join("round").exists());
        assert!(directory.path().join("contest/A.cpp").is_file());
        assert!(directory.path().join("contest/div2/B.py").is_file());
        assert_eq!(metadata_filenames(), vec!["C.cpp", "contest/A.cpp", "contest/div2/B.py"]);

        // A nested folder keeps its parent path.
        let nested = rename_workspace_folder(RenameWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "contest/div2".into(), new_name: "hard".into() }).unwrap();
        assert_eq!(nested.directory, "contest/hard");
        assert_eq!(nested.renamed, vec![["contest/div2/B.py".to_string(), "contest/hard/B.py".to_string()]]);
        assert_eq!(metadata_filenames(), vec!["C.cpp", "contest/A.cpp", "contest/hard/B.py"]);

        // Changing only the case works on case-insensitive disks too.
        let cased = rename_workspace_folder(RenameWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "contest".into(), new_name: "Contest".into() }).unwrap();
        assert_eq!(cased.directory, "Contest");
        assert!(directory.path().join("Contest").join("A.cpp").is_file());
        assert_eq!(metadata_filenames(), vec!["C.cpp", "Contest/A.cpp", "Contest/hard/B.py"]);

        // Same name is a no-op, and invalid targets are refused.
        let unchanged = rename_workspace_folder(RenameWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "Contest".into(), new_name: "Contest".into() }).unwrap();
        assert!(unchanged.renamed.is_empty());
        assert!(rename_workspace_folder(RenameWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: String::new(), new_name: "x".into() }).is_err());
        assert!(rename_workspace_folder(RenameWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "Contest".into(), new_name: "a/b".into() }).is_err());
        assert!(rename_workspace_folder(RenameWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "Contest".into(), new_name: "..".into() }).is_err());
        create_workspace_folder(CreateWorkspaceFolderRequest { folder_path: folder_path.clone(), name: "taken".into(), parent_directory: String::new() }).unwrap();
        assert!(rename_workspace_folder(RenameWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "Contest".into(), new_name: "taken".into() }).is_err());
        assert!(directory.path().join("Contest").join("A.cpp").is_file(), "a refused rename must leave the folder in place");
    }

    #[test]
    fn workspace_save_skips_unsupported_extensions() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).unwrap();
        let saved = save_workspace(SaveWorkspaceRequest { folder_path: folder_path.clone(), problems: vec![WorkspaceProblemInput {
            filename: "notes.txt".into(), title: "notes".into(), language: "cpp".into(), code: "ignored".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, limits: None, modified_at: None,
        }] }).unwrap();
        assert!(saved.problems.is_empty());
        assert!(!directory.path().join("notes.txt").exists());
    }

    fn input(filename: &str, code: &str, tests: Vec<SavedTestCase>) -> WorkspaceProblemInput {
        let language = if filename.ends_with(".py") { "python" } else { "cpp" };
        WorkspaceProblemInput {
            filename: filename.into(), title: filename.into(), language: language.into(), code: code.into(), tests,
            source: None, source_url: None, judge_status: None, limits: None, modified_at: None,
        }
    }

    fn one_test(name: &str) -> Vec<SavedTestCase> {
        vec![SavedTestCase { name: name.into(), input: "1".into(), expected: "1".into() }]
    }

    #[test]
    fn damaged_metadata_is_backed_up_before_a_save_replaces_it() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        fs::write(directory.path().join(WORKSPACE_METADATA_FILENAME), "{ \"version\": 2, \"problems\": [ { truncated").expect("damaged file");
        save_workspace(SaveWorkspaceRequest { folder_path: folder_path.clone(), problems: vec![input("A.cpp", "int main() {}", Vec::new())] }).expect("the save still goes ahead");
        let backups: Vec<_> = fs::read_dir(directory.path()).expect("list").filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".mild-editor.json.broken-")).collect();
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert!(fs::read_to_string(directory.path().join(&backups[0])).expect("backup").contains("truncated"));
        // And what replaced it is whole.
        let _: WorkspaceMetadata = serde_json::from_str(&fs::read_to_string(directory.path().join(WORKSPACE_METADATA_FILENAME)).expect("metadata")).expect("parses");
    }

    #[test]
    fn metadata_is_written_whole_with_nothing_left_beside_it() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).expect("create");
        save_workspace(SaveWorkspaceRequest { folder_path, problems: vec![input("A.cpp", "int main() {}", one_test("t"))] }).expect("save");
        let names: Vec<String> = fs::read_dir(directory.path()).expect("list").filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|name| !name.ends_with(".tmp")), "{names:?}");
    }

    #[test]
    fn a_file_gone_for_a_moment_gets_its_tests_back() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).expect("create");
        save_workspace(SaveWorkspaceRequest { folder_path: folder_path.clone(), problems: vec![input("A.cpp", "int main() {}", one_test("sample"))] }).expect("save");
        // A checkout of another branch takes the file away; a scan runs meanwhile.
        fs::remove_file(directory.path().join("A.cpp")).expect("remove");
        let without = reload_workspace_files(WorkspaceRequest { folder_path: folder_path.clone() }).expect("scan");
        assert!(without.iter().all(|problem| problem.filename != "A.cpp"));
        // Back on the first branch.
        fs::write(directory.path().join("A.cpp"), "int main() {}").expect("restore");
        let back = reload_workspace_files(WorkspaceRequest { folder_path }).expect("scan again");
        let problem = back.iter().find(|problem| problem.filename == "A.cpp").expect("A is back");
        assert_eq!(problem.tests.len(), 1);
        assert_eq!(problem.tests[0].name, "sample");
    }

    #[test]
    fn a_stale_tab_does_not_undo_a_change_made_elsewhere() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(WorkspaceRequest { folder_path: folder_path.clone() }).expect("create");
        save_workspace(SaveWorkspaceRequest { folder_path: folder_path.clone(), problems: vec![input("A.cpp", "// v1", Vec::new()), input("B.cpp", "// b1", Vec::new())] }).expect("save");
        // Another editor changes A; the tab still holds v1 and is saved along with B's edit.
        fs::write(directory.path().join("A.cpp"), "// v2 from elsewhere").expect("external edit");
        let saved = save_workspace(SaveWorkspaceRequest { folder_path: folder_path.clone(), problems: vec![input("A.cpp", "// v1", Vec::new()), input("B.cpp", "// b2", Vec::new())] }).expect("save all tabs");
        assert_eq!(fs::read_to_string(directory.path().join("A.cpp")).expect("A"), "// v2 from elsewhere");
        assert_eq!(saved.problems.iter().find(|problem| problem.filename == "A.cpp").expect("A").code, "// v2 from elsewhere");
        assert_eq!(fs::read_to_string(directory.path().join("B.cpp")).expect("B"), "// b2");
        // A tab edited in the editor is the user's latest word, and is written.
        save_workspace(SaveWorkspaceRequest { folder_path, problems: vec![input("A.cpp", "// v3 typed here", Vec::new())] }).expect("save the edit");
        assert_eq!(fs::read_to_string(directory.path().join("A.cpp")).expect("A"), "// v3 typed here");
    }

    #[test]
    fn a_source_that_is_not_utf8_does_not_stop_the_workspace_loading() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        fs::write(directory.path().join("A.cpp"), "int main() {}").expect("A");
        // "// 한글" in CP949.
        fs::write(directory.path().join("B.cpp"), [b'/', b'/', b' ', 0xC7, 0xD1, 0xB1, 0xDB, b'\n']).expect("B");
        let loaded = load_workspace(folder_path).expect("loads");
        let names: Vec<&str> = loaded.problems.iter().map(|problem| problem.filename.as_str()).collect();
        assert_eq!(names, vec!["A.cpp", "B.cpp"]);
        if cfg!(windows) {
            // On a Korean system the code page reads it back as written; elsewhere it is only
            // required not to fail.
            let b = loaded.problems.iter().find(|problem| problem.filename == "B.cpp").expect("B");
            assert!(b.code.starts_with("// "), "{}", b.code);
        }
    }

    #[test]
    fn an_unreadable_metadata_file_is_an_error_not_an_empty_workspace() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        // A directory where the file should be cannot be read, the way a locked file cannot.
        fs::create_dir(directory.path().join(WORKSPACE_METADATA_FILENAME)).expect("blocker");
        fs::write(directory.path().join("A.cpp"), "int main() {}").expect("A");
        assert!(reload_workspace_files(WorkspaceRequest { folder_path: folder_path.clone() }).is_err());
        assert!(save_workspace(SaveWorkspaceRequest { folder_path, problems: vec![input("A.cpp", "int main() {}", Vec::new())] }).is_err());
    }
}
