mod companion;
#[cfg(target_os = "macos")]
mod macos_menu;

use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use wait_timeout::ChildExt;

const MAX_CODE: usize = 100_000;
const MAX_INPUT: usize = 100_000;
const MAX_OUTPUT: u64 = 1_000_001;
const WORKSPACE_METADATA_FILENAME: &str = ".mild-editor.json";
const LEGACY_WORKSPACE_METADATA_FILENAME: &str = "mild-editor.json";

fn workspace_metadata_path(folder: &Path) -> std::path::PathBuf {
    let hidden = folder.join(WORKSPACE_METADATA_FILENAME);
    if hidden.exists() { hidden } else {
        let legacy = folder.join(LEGACY_WORKSPACE_METADATA_FILENAME);
        if legacy.exists() { legacy } else { hidden }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRequest {
    language: String,
    code: String,
    tests: Vec<TestInput>,
    run_id: String,
    #[serde(default)]
    atcoder_library_path: Option<String>,
}

struct RunState(Arc<AtomicBool>);

impl Default for RunState {
    fn default() -> Self { Self(Arc::new(AtomicBool::new(false))) }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TestResultEvent {
    run_id: String,
    index: usize,
    result: RunResult,
}

#[derive(Deserialize)]
struct TestInput {
    input: String,
    #[allow(dead_code)]
    expected: String,
}

/// Competitive-programming verdict for a single execution, independent of whether
/// the produced output matches the expected one. The frontend turns `Ok` into
/// `AC`/`WA` by comparing the streams; every other value is already final.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Verdict {
    Ok,
    /// Compilation failed before any test could run.
    Ce,
    /// The process exited with a non-zero status or could not be spawned.
    Re,
    /// The process was still alive when the time limit expired.
    Tle,
    /// The process wrote more than `MAX_OUTPUT` bytes.
    Limit,
    /// The user cancelled the run.
    Stopped,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunResult {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    time_ms: u128,
    verdict: Verdict,
}

#[derive(Serialize)]
struct RunResponse {
    results: Vec<RunResult>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SavedTestCase {
    name: String,
    input: String,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProblemRequest {
    folder_path: String,
    title: String,
    language: String,
    code: String,
    tests: Vec<SavedTestCase>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProblemMetadata {
    version: u8,
    title: String,
    language: String,
    tests: Vec<SavedTestCase>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedProblem {
    title: String,
    language: String,
    code: String,
    tests: Vec<SavedTestCase>,
    folder_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceProblemInput {
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
    modified_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveWorkspaceRequest {
    folder_path: String,
    problems: Vec<WorkspaceProblemInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorkspaceRequest {
    folder_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteWorkspaceFileRequest {
    folder_path: String,
    filename: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateWorkspaceFileRequest {
    folder_path: String,
    filename: String,
    new_filename: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameWorkspaceFileRequest {
    folder_path: String,
    filename: String,
    new_filename: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListWorkspaceFilesRequest {
    folder_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorkspaceFolderRequest {
    folder_path: String,
    name: String,
    #[serde(default)]
    parent_directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteWorkspaceFolderRequest {
    folder_path: String,
    directory: String,
}

#[tauri::command]
fn list_workspace_source_filenames(request: ListWorkspaceFilesRequest) -> Result<Vec<String>, String> {
    let folder = std::path::PathBuf::from(request.folder_path);
    let mut filenames = Vec::new();
    collect_workspace_sources(&folder, &folder, &mut filenames)?;
    filenames.sort_by_key(|filename| filename_key(filename));
    Ok(filenames)
}

#[tauri::command]
fn list_workspace_directories(request: ListWorkspaceFilesRequest) -> Result<Vec<String>, String> {
    let folder = std::path::PathBuf::from(request.folder_path);
    let mut directories = Vec::new();
    collect_workspace_directories(&folder, &folder, &mut directories)?;
    directories.sort_by_key(|name| filename_key(name));
    Ok(directories)
}

#[tauri::command]
fn create_workspace_folder(request: CreateWorkspaceFolderRequest) -> Result<String, String> {
    let folder = std::path::PathBuf::from(request.folder_path);
    let parent = workspace_directory_path(&request.parent_directory)?;
    let parent_path = folder.join(&parent);
    if !parent_path.is_dir() { return Err("The parent folder does not exist.".into()); }
    let requested = request.name.trim();
    let requested_path = Path::new(requested);
    if requested.is_empty() || requested_path.file_name().and_then(|value| value.to_str()) != Some(requested) || matches!(requested, "." | "..") {
        return Err("Enter a valid folder name.".into());
    }
    let mut name = requested.to_string();
    for number in 1.. {
        if !parent_path.join(&name).exists() { break; }
        name = format!("{requested} ({number})");
    }
    fs::create_dir(parent_path.join(&name)).map_err(|error| format!("Could not create folder: {error}"))?;
    Ok(if parent.as_os_str().is_empty() { name } else { parent.join(name).to_string_lossy().replace('\\', "/") })
}

#[tauri::command]
fn delete_workspace_folder(request: DeleteWorkspaceFolderRequest) -> Result<Vec<String>, String> {
    let folder = std::path::PathBuf::from(&request.folder_path);
    let directory = workspace_directory_path(&request.directory)?;
    if directory.as_os_str().is_empty() { return Err("The workspace root cannot be deleted.".into()); }
    let target = folder.join(&directory);
    if !target.is_dir() { return Err("Workspace folder does not exist.".into()); }
    let prefix = format!("{}/", directory.to_string_lossy().replace('\\', "/"));
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata: WorkspaceMetadata = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("Could not read workspace metadata: {error}"))
        .and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))?;
    let removed = metadata.problems.iter().filter(|problem| filename_key(&problem.filename).starts_with(&filename_key(&prefix))).map(|problem| problem.filename.clone()).collect::<Vec<_>>();
    fs::remove_dir_all(&target).map_err(|error| format!("Could not delete folder: {error}"))?;
    metadata.problems.retain(|problem| !filename_key(&problem.filename).starts_with(&filename_key(&prefix)));
    fs::write(metadata_path, serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?).map_err(|error| format!("Could not update workspace metadata: {error}"))?;
    Ok(removed)
}

#[derive(Deserialize)]
struct ReadFontFileRequest {
    path: String,
}

#[derive(Deserialize)]
struct ReadImageFileRequest {
    path: String,
}

#[derive(Serialize)]
struct ReadImageFileResponse {
    bytes: Vec<u8>,
    mime: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveWorkspaceTestsRequest {
    folder_path: String,
    filename: String,
    tests: Vec<SavedTestCase>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateWorkspaceSourceRequest {
    folder_path: String,
    filename: String,
    source: String,
    #[serde(default)]
    source_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkspaceProblemMetadata {
    filename: String,
    title: String,
    language: String,
    tests: Vec<SavedTestCase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    judge_status: Option<String>,
    #[serde(default)]
    modified_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMetadata {
    version: u8,
    problems: Vec<WorkspaceProblemMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceProblemOutput {
    filename: String,
    title: String,
    language: String,
    code: String,
    tests: Vec<SavedTestCase>,
    source: Option<String>,
    source_url: Option<String>,
    judge_status: Option<String>,
    modified_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedWorkspace {
    folder_path: String,
    problems: Vec<WorkspaceProblemOutput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedAtCoderProblem {
    title: String,
    suggested_filename: String,
    tests: Vec<SavedTestCase>,
    source: String,
    source_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionStatusRequest {
    #[serde(default)]
    folder_path: Option<String>,
    problems: Vec<SubmissionProblem>,
    atcoder_handle: String,
    codeforces_handle: String,
    doj_handle: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionProblem {
    source: String,
    source_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionStatus {
    source_url: String,
    status: Option<String>,
    submission_url: Option<String>,
}

fn file_modified_at(path: &std::path::Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

struct ClangdProcess {
    child: std::process::Child,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
}

#[derive(Default)]
struct ClangdState(Mutex<Option<ClangdProcess>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClangdInfo {
    available: bool,
    path: Option<String>,
    version: Option<String>,
}

fn read_limited<R: Read>(reader: R) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = reader.take(MAX_OUTPUT).read_to_end(&mut bytes);
    bytes
}

fn execute(
    command: &Path,
    args: &[String],
    cwd: &Path,
    input: &str,
    timeout: Duration,
) -> RunResult {
    execute_with_cancel(command, args, cwd, input, timeout, None)
}

fn execute_with_cancel(
    command: &Path,
    args: &[String],
    cwd: &Path,
    input: &str,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
) -> RunResult {
    let started = Instant::now();
    let mut child = match Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return RunResult {
                ok: false,
                code: None,
                stdout: String::new(),
                stderr: error.to_string(),
                time_ms: started.elapsed().as_millis(),
                verdict: Verdict::Re,
            }
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let input = input.as_bytes().to_vec();
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let stdout_handle = child
        .stdout
        .take()
        .map(|stdout| thread::spawn(move || read_limited(stdout)));
    let stderr_handle = child
        .stderr
        .take()
        .map(|stderr| thread::spawn(move || read_limited(stderr)));

    let mut stopped = false;
    let status = loop {
        if cancelled.is_some_and(|value| value.load(Ordering::Relaxed)) {
            stopped = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        let wait = Duration::from_millis(50).min(timeout - elapsed);
        match child.wait_timeout(wait) {
            Ok(Some(status)) => break Some(status),
            Ok(None) => continue,
            Err(_) => break None,
        }
    };

    let stdout_bytes = stdout_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr_bytes = stderr_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let mut stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
    let mut verdict = match status {
        Some(value) if value.success() => Verdict::Ok,
        Some(_) => Verdict::Re,
        None if stopped => Verdict::Stopped,
        None => Verdict::Tle,
    };
    if status.is_none() {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        if stopped {
            stderr.push_str("Error: stopped");
        } else {
            stderr.push_str(&format!("Error: TLE ({}s)", timeout.as_secs()));
        }
    }
    if stdout_bytes.len() as u64 >= MAX_OUTPUT || stderr_bytes.len() as u64 >= MAX_OUTPUT {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        stderr.push_str("Error: output limit exceeded");
        verdict = Verdict::Limit;
    }

    RunResult {
        ok: status.map(|value| value.success()).unwrap_or(false),
        code: status.and_then(|value| value.code()),
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr,
        time_ms: started.elapsed().as_millis(),
        verdict,
    }
}

#[cfg(windows)]
trait CommandExtHidden {
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
trait CommandExtHidden {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self;
}

#[cfg(not(windows))]
impl CommandExtHidden for Command {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self {
        self
    }
}

fn run_sync(request: RunRequest, app: tauri::AppHandle, cancelled: Arc<AtomicBool>) -> Result<RunResponse, String> {
    if !matches!(request.language.as_str(), "cpp" | "python") {
        return Err("Unsupported language.".into());
    }
    if request.code.len() > MAX_CODE
        || request.tests.len() > 30
        || request
            .tests
            .iter()
            .any(|test| test.input.len() > MAX_INPUT)
    {
        return Err("The source code or test input is too large.".into());
    }

    let directory = tempfile::Builder::new()
        .prefix("mild-editor-")
        .tempdir()
        .map_err(|error| error.to_string())?;
    let cwd = directory.path();

    let (command, args) = if request.language == "cpp" {
        let compiler = which::which("g++").map_err(|_| {
            "g++ was not found. Install MinGW or GCC and add it to PATH.".to_string()
        })?;
        let source = cwd.join("main.cpp");
        let binary = cwd.join(if cfg!(windows) { "main.exe" } else { "main" });
        fs::write(&source, &request.code).map_err(|error| error.to_string())?;

        let mut compile = None;
        for standard in ["c++20", "c++17", "c++1z", "c++14"] {
            let compile_args = vec![
                format!("-std={standard}"),
                "-O2".into(),
                "-pipe".into(),
                request.atcoder_library_path.as_ref().filter(|path| !path.trim().is_empty()).map(|path| format!("-I{path}")).unwrap_or_default(),
                source.to_string_lossy().into_owned(),
                "-o".into(),
                binary.to_string_lossy().into_owned(),
            ].into_iter().filter(|argument| !argument.is_empty()).collect::<Vec<_>>();
            let result = execute(&compiler, &compile_args, cwd, "", Duration::from_secs(10));
            let unsupported = result.stderr.contains("unrecognized command line option");
            compile = Some(result);
            if compile.as_ref().is_some_and(|value| value.ok) || !unsupported {
                break;
            }
        }
        let compile = compile.expect("compile attempt");
        if !compile.ok {
            let result = RunResult {
                stdout: String::new(),
                stderr: format!("Compile error\n{}", compile.stderr),
                verdict: Verdict::Ce,
                ..compile
            };
            let results = request.tests.iter().enumerate().map(|(index, _)| {
                let _ = app.emit("test-result", TestResultEvent { run_id: request.run_id.clone(), index, result: result.clone() });
                result.clone()
            }).collect();
            return Ok(RunResponse { results });
        }
        (binary, Vec::new())
    } else {
        let python = which::which("python")
            .or_else(|_| which::which("python3"))
            .map_err(|_| {
                "Python was not found. Install Python 3 and add it to PATH.".to_string()
            })?;
        let source = cwd.join("main.py");
        fs::write(&source, &request.code).map_err(|error| error.to_string())?;
        (
            python,
            vec!["-I".into(), source.to_string_lossy().into_owned()],
        )
    };

    let mut results = Vec::new();
    for (index, test) in request.tests.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) { break; }
        let result = execute_with_cancel(&command, &args, cwd, &test.input, Duration::from_secs(2), Some(&cancelled));
        let stopped = cancelled.load(Ordering::Relaxed);
        let _ = app.emit("test-result", TestResultEvent { run_id: request.run_id.clone(), index, result: result.clone() });
        results.push(result);
        if stopped { break; }
    }
    Ok(RunResponse { results })
}

#[tauri::command]
async fn run_code(app: tauri::AppHandle, state: tauri::State<'_, RunState>, request: RunRequest) -> Result<RunResponse, String> {
    state.0.store(false, Ordering::Relaxed);
    let cancelled = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || run_sync(request, app, cancelled))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn stop_run(state: tauri::State<'_, RunState>) {
    state.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn close_app(window: tauri::Window) {
    let _ = window.destroy();
}

#[tauri::command]
fn read_font_file(request: ReadFontFileRequest) -> Result<Vec<u8>, String> {
    let path = std::path::PathBuf::from(request.path);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "ttf" | "otf" | "woff" | "woff2") {
        return Err("Select a .ttf, .otf, .woff, or .woff2 font file.".into());
    }
    let metadata = fs::metadata(&path).map_err(|error| format!("Could not read font file: {error}"))?;
    if metadata.len() > 25 * 1024 * 1024 { return Err("Font files must be 25 MB or smaller.".into()); }
    fs::read(path).map_err(|error| format!("Could not read font file: {error}"))
}

#[tauri::command]
fn read_image_file(request: ReadImageFileRequest) -> Result<ReadImageFileResponse, String> {
    let path = std::path::PathBuf::from(request.path);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => return Err("Select a PNG, JPG, WEBP, GIF, or BMP image.".into()),
    };
    let metadata = fs::metadata(&path).map_err(|error| format!("Could not read background image: {error}"))?;
    if metadata.len() > 40 * 1024 * 1024 {
        return Err("Background images must be 40 MB or smaller.".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("Could not read background image: {error}"))?;
    Ok(ReadImageFileResponse { bytes, mime: mime.into() })
}

#[tauri::command]
fn save_workspace_tests(request: SaveWorkspaceTestsRequest) -> Result<(), String> {
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
    fs::write(metadata_path, serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?).map_err(|error| format!("Could not save test cases: {error}"))
}

#[tauri::command]
fn update_workspace_source(request: UpdateWorkspaceSourceRequest) -> Result<(), String> {
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
    fs::write(metadata_path, serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?).map_err(|error| format!("Could not update problem source: {error}"))
}

#[tauri::command]
fn save_problem(request: SaveProblemRequest) -> Result<LoadedProblem, String> {
    if !matches!(request.language.as_str(), "cpp" | "python") {
        return Err("Unsupported language.".into());
    }
    let folder = std::path::PathBuf::from(&request.folder_path);
    fs::create_dir_all(&folder).map_err(|error| format!("Could not create the folder: {error}"))?;
    let source_name = if request.language == "cpp" {
        "main.cpp"
    } else {
        "main.py"
    };
    fs::write(folder.join(source_name), &request.code)
        .map_err(|error| format!("Could not save the source code: {error}"))?;
    let title = folder
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(&request.title)
        .to_string();
    let metadata = ProblemMetadata {
        version: 1,
        title: title.clone(),
        language: request.language.clone(),
        tests: request.tests.clone(),
    };
    let json = serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?;
    fs::write(workspace_metadata_path(&folder), json)
        .map_err(|error| format!("Could not save the test cases: {error}"))?;
    Ok(LoadedProblem {
        title,
        language: request.language,
        code: request.code,
        tests: request.tests,
        folder_path: folder.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn load_problem(path: String) -> Result<LoadedProblem, String> {
    let selected = std::path::PathBuf::from(path);
    let folder = if selected.is_dir() {
        selected.clone()
    } else {
        selected
            .parent()
            .ok_or("Could not find the file's parent folder.")?
            .to_path_buf()
    };
    let metadata_path = workspace_metadata_path(&folder);
    let metadata = if metadata_path.exists() {
        let json = fs::read_to_string(&metadata_path)
            .map_err(|error| format!("Could not read the problem metadata: {error}"))?;
        Some(
            serde_json::from_str::<ProblemMetadata>(&json)
                .map_err(|error| format!("Invalid .mild-editor.json format: {error}"))?,
        )
    } else {
        None
    };

    let selected_extension = selected
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let language = metadata
        .as_ref()
        .map(|value| value.language.clone())
        .unwrap_or_else(|| {
            if selected_extension == "py" {
                "python".into()
            } else {
                "cpp".into()
            }
        });
    let source = if selected.is_file() {
        selected
    } else {
        folder.join(if language == "python" {
            "main.py"
        } else {
            "main.cpp"
        })
    };
    let code = fs::read_to_string(&source)
        .map_err(|error| format!("Could not read the source file: {error}"))?;
    let fallback_title = folder
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("problem")
        .to_string();
    Ok(LoadedProblem {
        title: metadata
            .as_ref()
            .map(|value| value.title.clone())
            .unwrap_or(fallback_title),
        language,
        code,
        tests: metadata.map(|value| value.tests).unwrap_or_default(),
        folder_path: folder.to_string_lossy().into_owned(),
    })
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

fn collect_workspace_sources(folder: &Path, current: &Path, output: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| format!("Could not read workspace folder: {error}"))?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !ignored_workspace_directory(&name) { collect_workspace_sources(folder, &path, output)?; }
        } else if let Some(relative) = workspace_relative_path(folder, &path) {
            if workspace_source_filename(&relative).is_ok() { output.push(relative); }
        }
    }
    Ok(())
}

fn collect_workspace_directories(folder: &Path, current: &Path, output: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| format!("Could not read workspace folder: {error}"))?.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        if ignored_workspace_directory(&name) { continue; }
        if let Some(relative) = workspace_relative_path(folder, &path) { output.push(relative); }
        collect_workspace_directories(folder, &path, output)?;
    }
    Ok(())
}

fn sync_workspace_source_files(folder: &Path, metadata: &mut WorkspaceMetadata) -> Result<(), String> {
    let mut filenames = Vec::new();
    collect_workspace_sources(folder, folder, &mut filenames)?;
    let mut disk_files = filenames.into_iter().filter_map(|filename| {
        let (_, language) = workspace_source_filename(&filename).ok()?;
        let path = folder.join(&filename);
        Some((filename, language, path))
    }).collect::<Vec<_>>();
    disk_files.sort_by_key(|(filename, _, _)| filename_key(filename));
    let disk_keys = disk_files.iter().map(|(filename, _, _)| filename_key(filename)).collect::<std::collections::HashSet<_>>();
    metadata.problems.retain(|problem| disk_keys.contains(&filename_key(&problem.filename)));
    for (filename, language, source_path) in disk_files {
        if let Some(problem) = metadata.problems.iter_mut().find(|problem| filename_key(&problem.filename) == filename_key(&filename)) {
            problem.filename = filename;
            problem.language = language;
            problem.modified_at = file_modified_at(&source_path);
        } else {
            metadata.problems.push(WorkspaceProblemMetadata {
                title: Path::new(&filename).file_stem().and_then(|value| value.to_str()).unwrap_or(&filename).to_string(),
                filename,
                language,
                tests: Vec::new(),
                source: Some("other".into()),
                source_url: None,
                judge_status: None,
                modified_at: file_modified_at(&source_path),
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
    if let Ok(files) = list_workspace_source_filenames(ListWorkspaceFilesRequest { folder_path: folder.to_string_lossy().into_owned() }) { occupied.extend(files); }
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
fn save_workspace(request: SaveWorkspaceRequest) -> Result<LoadedWorkspace, String> {
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
    let previous_metadata = fs::read_to_string(workspace_metadata_path(&folder))
        .ok()
        .and_then(|json| serde_json::from_str::<WorkspaceMetadata>(&json).ok())
        .unwrap_or(WorkspaceMetadata { version: 2, problems: Vec::new() });
    let mut metadata_problems = previous_metadata.problems;
    let mut outputs = Vec::new();
    for (problem, filename) in supported_problems {
        if let Some(parent) = folder.join(&filename).parent() { fs::create_dir_all(parent).map_err(|error| format!("Could not create source folder: {error}"))?; }
        fs::write(folder.join(&filename), &problem.code)
            .map_err(|error| format!("Could not save {filename}: {error}"))?;
        let modified_at = file_modified_at(&folder.join(&filename));
        let logical_modified_at = problem.modified_at.unwrap_or(modified_at);
        let metadata_problem = WorkspaceProblemMetadata {
            filename: filename.clone(),
            title: problem.title.clone(),
            language: problem.language.clone(),
            tests: problem.tests.clone(),
            source: problem.source.clone(),
            source_url: problem.source_url.clone(),
            judge_status: problem.judge_status.clone(),
            modified_at: logical_modified_at,
        };
        if let Some(index) = metadata_problems.iter().position(|item| item.filename == filename) {
            metadata_problems[index] = metadata_problem;
        } else {
            metadata_problems.push(metadata_problem);
        }
        outputs.push(WorkspaceProblemOutput {
            filename,
            title: problem.title,
            language: problem.language,
            code: problem.code,
            tests: problem.tests,
            source: problem.source,
            source_url: problem.source_url,
            judge_status: problem.judge_status,
            modified_at: logical_modified_at,
        });
    }
    let metadata = WorkspaceMetadata {
        version: 2,
        problems: metadata_problems,
    };
    let json = serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?;
    fs::write(workspace_metadata_path(&folder), json)
        .map_err(|error| format!("Could not save workspace metadata: {error}"))?;
    Ok(LoadedWorkspace {
        folder_path: folder.to_string_lossy().into_owned(),
        problems: outputs,
    })
}

#[tauri::command]
fn create_workspace(request: CreateWorkspaceRequest) -> Result<LoadedWorkspace, String> {
    let folder = std::path::PathBuf::from(&request.folder_path);
    fs::create_dir_all(&folder).map_err(|error| format!("Could not create project folder: {error}"))?;
    let metadata_path = workspace_metadata_path(&folder);
    if metadata_path.exists() {
        return Err(".mild-editor.json already exists in this folder. Use Open instead.".into());
    }
    let metadata = WorkspaceMetadata { version: 2, problems: Vec::new() };
    fs::write(&metadata_path, serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?).map_err(|error| format!("Could not create project metadata: {error}"))?;
    Ok(LoadedWorkspace { folder_path: folder.to_string_lossy().into_owned(), problems: Vec::new() })
}

#[tauri::command]
fn delete_workspace_file(request: DeleteWorkspaceFileRequest) -> Result<(), String> {
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata: WorkspaceMetadata = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("Could not read workspace metadata: {error}"))
        .and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))?;
    metadata.problems.retain(|problem| problem.filename != filename);
    let source = folder.join(&filename);
    if source.exists() { fs::remove_file(&source).map_err(|error| format!("Could not delete source file: {error}"))?; }
    let json = serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?;
    fs::write(metadata_path, json).map_err(|error| format!("Could not update workspace metadata: {error}"))
}

#[tauri::command]
fn open_workspace_file_location(request: DeleteWorkspaceFileRequest) -> Result<(), String> {
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let source = folder.join(filename);
    if !source.exists() { return Err("Workspace source file does not exist.".into()); }
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        // Explorer requires the switch outside the quotes: /select,"C:\\path with spaces\\file.cpp".
        // Command::arg quotes the whole argument when it contains spaces, which makes Explorer
        // ignore /select. raw_arg preserves the syntax expected by Explorer.
        std::os::windows::process::CommandExt::raw_arg(&mut command, windows_explorer_select_argument(&source));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(&source);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&folder);
        command
    };
    command.spawn().map_err(|error| format!("Could not open file location: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_workspace_folder_location(request: DeleteWorkspaceFolderRequest) -> Result<(), String> {
    let folder = std::path::PathBuf::from(&request.folder_path);
    let directory = workspace_directory_path(&request.directory)?;
    if directory.as_os_str().is_empty() { return Err("Select a workspace folder.".into()); }
    let target = folder.join(directory);
    if !target.is_dir() { return Err("Workspace folder does not exist.".into()); }
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        std::os::windows::process::CommandExt::raw_arg(&mut command, windows_explorer_select_argument(&target));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(&target);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(target.parent().unwrap_or(&folder));
        command
    };
    command.spawn().map_err(|error| format!("Could not open folder location: {error}"))?;
    Ok(())
}

#[cfg(windows)]
fn windows_explorer_select_argument(source: &Path) -> String {
    format!("/select,\"{}\"", source.to_string_lossy().replace('/', "\\"))
}

#[tauri::command]
fn duplicate_workspace_file(request: DuplicateWorkspaceFileRequest) -> Result<WorkspaceProblemOutput, String> {
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let (requested_filename, _) = workspace_source_filename(&request.new_filename)?;
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata: WorkspaceMetadata = fs::read_to_string(&metadata_path).map_err(|error| format!("Could not read workspace metadata: {error}")).and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))?;
    let new_filename = unique_workspace_filename(&folder, &requested_filename, &metadata, None);
    let (_, new_language) = workspace_source_filename(&new_filename)?;
    let source_problem = metadata.problems.iter().find(|problem| problem.filename == filename).cloned().ok_or("Workspace file metadata was not found.")?;
    let source = folder.join(&filename);
    let destination = folder.join(&new_filename);
    fs::copy(&source, &destination).map_err(|error| format!("Could not duplicate source file: {error}"))?;
    let code = fs::read_to_string(&destination).map_err(|error| format!("Could not read duplicated source file: {error}"))?;
    let duplicated = WorkspaceProblemMetadata { filename: new_filename.clone(), title: source_problem.title.clone(), language: new_language.clone(), tests: source_problem.tests.clone(), source: source_problem.source.clone(), source_url: source_problem.source_url.clone(), judge_status: source_problem.judge_status.clone(), modified_at: file_modified_at(&destination) };
    metadata.problems.push(duplicated.clone());
    fs::write(metadata_path, serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?).map_err(|error| format!("Could not update workspace metadata: {error}"))?;
    Ok(WorkspaceProblemOutput { filename: new_filename, title: duplicated.title, language: new_language, code, tests: duplicated.tests, source: duplicated.source, source_url: duplicated.source_url, judge_status: duplicated.judge_status, modified_at: duplicated.modified_at })
}

#[tauri::command]
fn rename_workspace_file(request: RenameWorkspaceFileRequest) -> Result<WorkspaceProblemOutput, String> {
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let (requested_filename, _) = workspace_source_filename(&request.new_filename)?;
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata: WorkspaceMetadata = fs::read_to_string(&metadata_path).map_err(|error| format!("Could not read workspace metadata: {error}")).and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))?;
    let new_filename = unique_workspace_filename(&folder, &requested_filename, &metadata, Some(&filename));
    let (_, new_language) = workspace_source_filename(&new_filename)?;
    let problem = metadata.problems.iter_mut().find(|problem| problem.filename == filename).ok_or("Workspace file metadata was not found.")?;
    let source_path = folder.join(&filename);
    let destination_path = folder.join(&new_filename);
    if filename != new_filename && filename.eq_ignore_ascii_case(&new_filename) {
        let temporary_path = folder.join(format!(".mild-rename-{}", std::process::id()));
        fs::rename(&source_path, &temporary_path).map_err(|error| format!("Could not rename source file: {error}"))?;
        fs::rename(&temporary_path, &destination_path).map_err(|error| format!("Could not rename source file: {error}"))?;
    } else {
        fs::rename(&source_path, &destination_path).map_err(|error| format!("Could not rename source file: {error}"))?;
    }
    problem.filename = new_filename.clone();
    problem.language = new_language.clone();
    let result = WorkspaceProblemOutput { filename: new_filename, title: problem.title.clone(), language: new_language, code: fs::read_to_string(folder.join(&problem.filename)).map_err(|error| format!("Could not read renamed source file: {error}"))?, tests: problem.tests.clone(), source: problem.source.clone(), source_url: problem.source_url.clone(), judge_status: problem.judge_status.clone(), modified_at: problem.modified_at };
    fs::write(metadata_path, serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?).map_err(|error| format!("Could not update workspace metadata: {error}"))?;
    Ok(result)
}

#[tauri::command]
fn load_workspace(path: String) -> Result<LoadedWorkspace, String> {
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
                    problems: vec![WorkspaceProblemMetadata {
                        filename: if old.language == "python" { "main.py".into() } else { "main.cpp".into() },
                        title: old.title,
                        language: old.language,
                        tests: old.tests,
                        source: None,
                        source_url: None,
                        judge_status: None,
                        modified_at: 0,
                    }],
                }
            }
        }
    } else {
        WorkspaceMetadata { version: 2, problems: Vec::new() }
    };
    sync_workspace_source_files(&folder, &mut metadata)?;
    fs::write(&metadata_path, serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Could not update workspace metadata: {error}"))?;
    let mut problems = Vec::new();
    for problem in metadata.problems {
        let source_path = folder.join(&problem.filename);
        let code = fs::read_to_string(&source_path)
            .map_err(|error| format!("Could not read {}: {error}", problem.filename))?;
        problems.push(WorkspaceProblemOutput {
            filename: problem.filename,
            title: problem.title,
            language: problem.language,
            code,
            tests: problem.tests,
            source: problem.source,
            source_url: problem.source_url,
            judge_status: problem.judge_status,
            modified_at: if problem.modified_at > 0 { problem.modified_at } else { file_modified_at(&source_path) },
        });
    }
    Ok(LoadedWorkspace {
        folder_path: folder.to_string_lossy().into_owned(),
        problems,
    })
}

fn parse_atcoder_samples(html: &str) -> Vec<SavedTestCase> {
    let document = scraper::Html::parse_document(&html);
    let english_heading_selector =
        scraper::Selector::parse("#task-statement .lang-en h3").unwrap();
    let fallback_heading_selector = scraper::Selector::parse("#task-statement h3").unwrap();
    let pre_selector = scraper::Selector::parse("pre").unwrap();
    let mut inputs: Vec<(String, String)> = Vec::new();
    let mut outputs: Vec<(String, String)> = Vec::new();
    // AtCoder sends both the Japanese and English statements even with
    // `?lang=en`. Reading the broad selector as well as `.lang-en` therefore
    // imported every sample twice. Prefer the English block and only fall back
    // to the whole statement for old Japanese-only problems.
    let english_headings = document.select(&english_heading_selector).collect::<Vec<_>>();
    let headings = if english_headings.is_empty() {
        document.select(&fallback_heading_selector).collect::<Vec<_>>()
    } else {
        english_headings
    };
    for heading in headings {
        let heading_text = heading.text().collect::<String>().trim().to_string();
        let is_input = heading_text.contains("Sample Input") || heading_text.contains("入力例");
        let is_output = heading_text.contains("Sample Output") || heading_text.contains("出力例");
        // Unicode escapes keep Japanese-only legacy statements independent of
        // the source file's or Windows console's text encoding.
        let is_input = is_input || heading_text.contains("\u{5165}\u{529b}\u{4f8b}");
        let is_output = is_output || heading_text.contains("\u{51fa}\u{529b}\u{4f8b}");
        if !is_input && !is_output {
            continue;
        }
        let number = heading_text
            .chars()
            .filter(|character| character.is_ascii_digit())
            .collect::<String>();
        let mut sibling = heading.next_sibling();
        while let Some(node) = sibling {
            if let Some(element) = scraper::ElementRef::wrap(node) {
                if element.value().name() == "h3" { break; }
                let sample = if element.value().name() == "pre" {
                    Some(element)
                } else {
                    element.select(&pre_selector).next()
                };
                if let Some(sample) = sample {
                    let value = sample
                        .text()
                        .collect::<String>()
                        .replace("\r\n", "\n")
                        .trim_end()
                        .to_string();
                    if is_input {
                        inputs.push((number.clone(), value));
                    } else {
                        outputs.push((number.clone(), value));
                    }
                    break;
                }
            }
            sibling = node.next_sibling();
        }
    }
    let mut tests = Vec::new();
    let mut seen_tests = std::collections::HashSet::new();
    for (index, (number, input)) in inputs.into_iter().enumerate() {
        if let Some((_, expected)) = outputs
            .iter()
            .find(|(output_number, _)| output_number == &number)
            .or_else(|| outputs.get(index))
        {
            if !seen_tests.insert((input.clone(), expected.clone())) {
                continue;
            }
            tests.push(SavedTestCase {
                name: format!(
                    "test {}",
                    if number.is_empty() {
                        (index + 1).to_string()
                    } else {
                        number
                    }
                ),
                input,
                expected: expected.clone(),
            });
        }
    }
    tests
}

fn fetch_atcoder_problem(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<ImportedAtCoderProblem, String> {
    let mut parsed = reqwest::Url::parse(url)
        .map_err(|_| "Problem not found. Enter a valid AtCoder, Codeforces, or DOJ URL.".to_string())?;
    if parsed.host_str() != Some("atcoder.jp") || !parsed.path().contains("/tasks/") {
        return Err("Problem not found. Enter a valid AtCoder problem URL.".into());
    }
    parsed.query_pairs_mut().append_pair("lang", "en");
    let html = client
        .get(parsed.clone())
        .send()
        .map_err(|error| format!("Could not fetch the problem page: {error}"))?
        .error_for_status()
        .map_err(|error| format!("AtCoder returned an error: {error}"))?
        .text()
        .map_err(|error| error.to_string())?;
    let document = scraper::Html::parse_document(&html);
    let title_selector = scraper::Selector::parse("span.h2, .h2").unwrap();
    let tests = parse_atcoder_samples(&html);
    if tests.is_empty() {
        return Err("No sample test cases were found on this page.".into());
    }
    let title = document
        .select(&title_selector)
        .next()
        .map(|element| {
            element
                .text()
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            parsed
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .unwrap_or("AtCoder problem")
                .to_string()
        });
    let task_id = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or("problem");
    let letter = task_id.rsplit('_').next().unwrap_or(task_id).to_uppercase();
    Ok(ImportedAtCoderProblem {
        title,
        suggested_filename: format!("{letter}.cpp"),
        tests,
        source: "atcoder".into(),
        source_url: parsed.to_string(),
    })
}

fn codeforces_pre_text(pre: scraper::ElementRef<'_>) -> String {
    let line_selector = scraper::Selector::parse(".test-example-line").unwrap();
    let lines = pre.select(&line_selector).map(|line| line.text().collect::<String>().trim().to_string()).filter(|line| !line.is_empty()).collect::<Vec<_>>();
    if !lines.is_empty() {
        lines.join("\n")
    } else {
        pre.text().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
    }
}

fn parse_codeforces_html(html: &str) -> Option<(String, Vec<SavedTestCase>)> {
    let document = scraper::Html::parse_document(html);
    let title_selector = scraper::Selector::parse(".problem-statement .header .title").unwrap();
    let sample_selector = scraper::Selector::parse(".problem-statement .sample-test").unwrap();
    let input_selector = scraper::Selector::parse(".input pre").unwrap();
    let output_selector = scraper::Selector::parse(".output pre").unwrap();
    let title = document.select(&title_selector).next().map(|element| element.text().collect::<String>().trim().to_string()).unwrap_or_else(|| "Codeforces problem".into());
    let mut tests = Vec::new();
    for sample in document.select(&sample_selector) {
        let input = sample.select(&input_selector).next().map(codeforces_pre_text);
        let expected = sample.select(&output_selector).next().map(codeforces_pre_text);
        if let (Some(input), Some(expected)) = (input, expected) {
            if !input.is_empty() && !expected.is_empty() {
                tests.push(SavedTestCase { name: format!("test {}", tests.len() + 1), input, expected });
            }
        }
    }
    (!tests.is_empty()).then_some((title, tests))
}

/// Parse the live contest table first, as Competitive Companion does in the browser.
/// The public problemset API can lag behind while a round is still running.
fn parse_codeforces_contest_urls(html: &str, base_url: &reqwest::Url) -> Vec<String> {
    let document = scraper::Html::parse_document(html);
    let link_selector = scraper::Selector::parse(".problems > tbody > tr > td:first-child > a, ._ProblemsPage_problems > table > tbody > tr > td:first-child > a").unwrap();
    let mut urls = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for link in document.select(&link_selector) {
        let Some(href) = link.value().attr("href") else { continue };
        let Ok(problem_url) = base_url.join(href) else { continue };
        if !problem_url.path().contains("/problem/") { continue; }
        let key = problem_url.path().trim_end_matches('/').to_ascii_lowercase();
        if seen.insert(key) { urls.push(problem_url.to_string()); }
    }
    urls
}

fn parse_codeforces_markdown(markdown: &str) -> Option<(String, Vec<SavedTestCase>)> {
    let title = markdown.lines().find_map(|line| line.strip_prefix("Title: ")).unwrap_or("Codeforces problem").trim().to_string();
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut tests = Vec::new();
    let mut cursor = lines.iter().position(|line| matches!(line.trim(), "Examples" | "Example")).unwrap_or(lines.len());
    while cursor < lines.len() {
        if lines[cursor].trim() != "Input" { cursor += 1; continue; }
        cursor += 1;
        while cursor < lines.len() && (lines[cursor].trim().is_empty() || lines[cursor].trim() == "Copy" || lines[cursor].trim() == "```") { cursor += 1; }
        let mut input = Vec::new();
        while cursor < lines.len() && lines[cursor].trim() != "Output" {
            let line = lines[cursor].trim_end();
            if !line.trim().is_empty() && line.trim() != "```" && line.trim() != "Copy" { input.push(line); }
            cursor += 1;
        }
        if cursor >= lines.len() { break; }
        cursor += 1;
        while cursor < lines.len() && (lines[cursor].trim().is_empty() || lines[cursor].trim() == "Copy" || lines[cursor].trim() == "```") { cursor += 1; }
        let mut output = Vec::new();
        while cursor < lines.len() && !matches!(lines[cursor].trim(), "Input" | "Note" | "Tutorial" | "Codeforces") {
            let line = lines[cursor].trim_end();
            if !line.trim().is_empty() && line.trim() != "```" && line.trim() != "Copy" { output.push(line); }
            cursor += 1;
        }
        if !input.is_empty() && !output.is_empty() {
            tests.push(SavedTestCase { name: format!("test {}", tests.len() + 1), input: input.join("\n"), expected: output.join("\n") });
        }
    }
    (!tests.is_empty()).then_some((title, tests))
}

fn parse_codeforces_targeted_block(markdown: &str, heading: &str) -> Option<String> {
    let content = markdown.split_once("Markdown Content:").map(|(_, content)| content).unwrap_or(markdown);
    let lines = content.lines()
        .map(str::trim_end)
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && trimmed != heading && trimmed != "Copy" && trimmed != "```"
        })
        .collect::<Vec<_>>();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn fetch_codeforces_targeted_block(client: &reqwest::blocking::Client, reader_url: &str, selector: &str, heading: &str) -> Option<String> {
    let body = client.get(reader_url)
        .header("X-Target-Selector", selector)
        .header("X-Wait-For-Selector", ".sample-test")
        .header("X-No-Cache", "true")
        .send().ok()?.error_for_status().ok()?.text().ok()?;
    parse_codeforces_targeted_block(&body, heading)
}

fn fetch_codeforces_problem(client: &reqwest::blocking::Client, url: &str) -> Result<ImportedAtCoderProblem, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid Codeforces problem URL.".to_string())?;
    let segments = parsed.path_segments().map(|values| values.collect::<Vec<_>>()).unwrap_or_default();
    let marker = segments.iter().position(|value| *value == "problem").ok_or("This is not a Codeforces problem URL.")?;
    let (contest, letter) = if segments.get(marker + 2).is_some() {
        (segments[marker + 1], segments[marker + 2])
    } else {
        (segments.get(marker.wrapping_sub(1)).copied().ok_or("Missing contest ID.")?, segments.get(marker + 1).copied().ok_or("Missing problem ID.")?)
    };
    let mut live_url = parsed.clone();
    live_url.query_pairs_mut().append_pair("locale", "en");
    let direct_urls = [
        live_url.to_string(),
        format!("https://codeforces.com/contest/{contest}/problem/{letter}?locale=en"),
        format!("https://codeforces.com/problemset/problem/{contest}/{letter}?locale=en"),
    ];
    let mut seen_direct_urls = std::collections::HashSet::new();
    for direct_url in direct_urls {
        if !seen_direct_urls.insert(direct_url.clone()) { continue; }
        if let Ok(html) = client.get(&direct_url).timeout(Duration::from_secs(8)).send().and_then(|response| response.error_for_status()).and_then(|response| response.text()) {
            if let Some((title, tests)) = parse_codeforces_html(&html) {
                return Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{}.cpp", letter.to_uppercase()), tests, source: "codeforces".into(), source_url: url.to_string() });
            }
        }
    }
    let reader_urls = [
        format!("https://r.jina.ai/https://codeforces.com/contest/{contest}/problem/{letter}?locale=en"),
        format!("https://r.jina.ai/https://codeforces.com/problemset/problem/{contest}/{letter}?locale=en"),
        format!("https://r.jina.ai/http://codeforces.com/problemset/problem/{contest}/{letter}?locale=en"),
        format!("https://r.jina.ai/https://codeforces.com/problemset/problem/{contest}/{letter}"),
    ];
    let mut last_error = "Codeforces did not return a readable problem statement.".to_string();
    let mut fallback_title = "Codeforces problem".to_string();
    for reader_url in &reader_urls {
        match client.get(reader_url).send().and_then(|response| response.error_for_status()).and_then(|response| response.text()) {
            Ok(body) => {
                if let Some(title) = body.lines().find_map(|line| line.strip_prefix("Title: ")) { fallback_title = title.trim().to_string(); }
                if let Some((title, tests)) = parse_codeforces_markdown(&body) {
                    return Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{}.cpp", letter.to_uppercase()), tests, source: "codeforces".into(), source_url: url.to_string() });
                }
                last_error = "Codeforces returned a statement without readable sample test cases.".into();
            }
            Err(error) => last_error = format!("Could not fetch Codeforces: {error}"),
        }
    }
    for reader_url in &reader_urls {
        let input = fetch_codeforces_targeted_block(client, reader_url, ".sample-test .input", "Input");
        let expected = fetch_codeforces_targeted_block(client, reader_url, ".sample-test .output", "Output");
        if let (Some(input), Some(expected)) = (input, expected) {
            let tests = vec![SavedTestCase { name: "test 1".into(), input, expected }];
            return Ok(ImportedAtCoderProblem { title: fallback_title, suggested_filename: format!("{}.cpp", letter.to_uppercase()), tests, source: "codeforces".into(), source_url: url.to_string() });
        }
    }
    Err(last_error)
}

fn fetch_doj_problem(client: &reqwest::blocking::Client, url: &str) -> Result<ImportedAtCoderProblem, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid DOJ problem URL.".to_string())?;
    let problem_id = parsed.path_segments().and_then(|mut values| values.next_back()).filter(|value| !value.is_empty()).ok_or("Missing DOJ problem ID.")?.to_string();
    let html = client.get(parsed).send().map_err(|error| format!("Could not fetch DOJ: {error}"))?
        .error_for_status().map_err(|error| format!("DOJ response error: {error}"))?.text().map_err(|error| error.to_string())?;
    let document = scraper::Html::parse_document(&html);
    let block_selector = scraper::Selector::parse(".sample-block").unwrap();
    let code_selector = scraper::Selector::parse(".code-block").unwrap();
    let title_selector = scraper::Selector::parse("title").unwrap();
    let mut tests = Vec::new();
    for block in document.select(&block_selector) {
        let values = block.select(&code_selector).map(|element| element.text().collect::<String>().replace("\r\n", "\n").trim().to_string()).collect::<Vec<_>>();
        if values.len() >= 2 { tests.push(SavedTestCase { name: format!("test {}", tests.len() + 1), input: values[0].clone(), expected: values[1].clone() }); }
    }
    if tests.is_empty() { return Err("No sample test cases found on DOJ.".into()); }
    let title = document.select(&title_selector).next().map(|element| element.text().collect::<String>().replace(" | DOJ", "")).unwrap_or_else(|| format!("DOJ #{problem_id}"));
    Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{problem_id}.cpp"), tests, source: "doj".into(), source_url: url.to_string() })
}

fn fetch_codeforces_contest(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<ImportedAtCoderProblem>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid Codeforces contest URL.".to_string())?;
    let segments = parsed.path_segments().map(|values| values.collect::<Vec<_>>()).unwrap_or_default();
    let contest_marker = segments.iter().position(|value| *value == "contest").ok_or("This is not a Codeforces contest URL.")?;
    let contest = segments.get(contest_marker + 1).ok_or("Missing Codeforces contest ID.")?;
    let prefix = format!("https://codeforces.com/contest/{contest}/problem/");
    let mut urls = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Prefer the exact contest page. It contains the live problem table before
    // the global problemset API has necessarily published the round.
    let mut live_page = parsed.clone();
    live_page.query_pairs_mut().append_pair("locale", "en");
    let contest_pages = [
        live_page,
        reqwest::Url::parse(&format!("https://codeforces.com/contest/{contest}/problems?locale=en")).unwrap(),
    ];
    for page_url in contest_pages {
        let Ok(html) = client.get(page_url.clone()).timeout(Duration::from_secs(8)).send().and_then(|response| response.error_for_status()).and_then(|response| response.text()) else { continue };
        for problem_url in parse_codeforces_contest_urls(&html, &page_url) {
            let Some((_, index)) = codeforces_problem_key(&problem_url) else { continue };
            if seen.insert(index) { urls.push(problem_url); }
        }
        if !urls.is_empty() { break; }
    }

    let contest_id = contest.parse::<i64>().map_err(|_| "Invalid Codeforces contest ID.")?;
    if urls.is_empty() {
        let mut standings_url = reqwest::Url::parse("https://codeforces.com/api/contest.standings").unwrap();
        // Codeforces rejects pagination parameters for anonymous non-gym
        // standings requests, so only pass the contest id.
        standings_url.query_pairs_mut().append_pair("contestId", contest);
        if let Ok(value) = client.get(standings_url).send().and_then(|response| response.error_for_status()).and_then(|response| response.json::<serde_json::Value>()) {
            if value.get("status").and_then(|status| status.as_str()) == Some("OK") {
                if let Some(problems) = value.pointer("/result/problems").and_then(|problems| problems.as_array()) {
                    for problem in problems {
                        if let Some(index) = problem.get("index").and_then(|index| index.as_str()) {
                            if seen.insert(index.to_ascii_uppercase()) { urls.push(format!("{prefix}{index}")); }
                        }
                    }
                }
            }
        }
    }
    if urls.is_empty() {
        if let Ok(value) = client.get("https://codeforces.com/api/problemset.problems").send().and_then(|response| response.error_for_status()).and_then(|response| response.json::<serde_json::Value>()) {
            if value.get("status").and_then(|status| status.as_str()) == Some("OK") {
                if let Some(problems) = value.pointer("/result/problems").and_then(|problems| problems.as_array()) {
                    for problem in problems {
                        if problem.get("contestId").and_then(|value| value.as_i64()) != Some(contest_id) { continue; }
                        if let Some(index) = problem.get("index").and_then(|index| index.as_str()) {
                            if seen.insert(index.to_ascii_uppercase()) { urls.push(format!("{prefix}{index}")); }
                        }
                    }
                }
            }
        }
    }

    if urls.is_empty() {
        let reader_url = format!("https://r.jina.ai/https://codeforces.com/contest/{contest}?locale=en");
        let markdown = client.get(reader_url).send().map_err(|error| format!("Could not fetch Codeforces contest: {error}"))?
            .error_for_status().map_err(|error| format!("Codeforces response error: {error}"))?.text().map_err(|error| error.to_string())?;
        for part in markdown.split(&prefix).skip(1) {
            let letter = part.chars().take_while(|character| character.is_ascii_alphanumeric()).collect::<String>();
            if !letter.is_empty() && seen.insert(letter.to_ascii_uppercase()) { urls.push(format!("{prefix}{letter}")); }
        }
    }
    if urls.is_empty() { return Err("No problems found in the Codeforces contest.".into()); }
    urls.sort();
    let mut problems = Vec::new();
    let mut errors = Vec::new();
    for problem_url in urls.into_iter().take(30) {
        match fetch_codeforces_problem(client, &problem_url) {
            Ok(problem) => problems.push(problem),
            Err(error) => errors.push(error),
        }
    }
    if problems.is_empty() {
        Err(errors.into_iter().next().unwrap_or_else(|| "No Codeforces samples could be imported.".into()))
    } else {
        Ok(problems)
    }
}

#[tauri::command]
async fn import_problem(url: String) -> Result<Vec<ImportedAtCoderProblem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent(format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 MildEditor/{}", env!("CARGO_PKG_VERSION")))
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(reqwest::header::ACCEPT, reqwest::header::HeaderValue::from_static("text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"));
                headers.insert(reqwest::header::ACCEPT_LANGUAGE, reqwest::header::HeaderValue::from_static("en-US,en;q=0.9"));
                headers
            })
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?;
        let parsed = reqwest::Url::parse(&url)
            .map_err(|_| "Problem not found. Enter a valid AtCoder, Codeforces, or DOJ URL.".to_string())?;
        if matches!(parsed.host_str(), Some("codeforces.com") | Some("www.codeforces.com")) {
            if parsed.path().contains("/problem/") {
                return fetch_codeforces_problem(&client, &url).map(|problem| vec![problem]);
            }
            return fetch_codeforces_contest(&client, &url);
        }
        if matches!(parsed.host_str(), Some("doj.kr") | Some("www.doj.kr")) {
            return fetch_doj_problem(&client, &url).map(|problem| vec![problem]);
        }
        if parsed.host_str() != Some("atcoder.jp") {
            return Err("Problem not found. Enter a valid AtCoder, Codeforces, or DOJ URL.".into());
        }
        if parsed.path().contains("/tasks/") {
            return fetch_atcoder_problem(&client, &url).map(|problem| vec![problem]);
        }

        let segments = parsed
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())
            .unwrap_or_default();
        let contest_index = segments
            .iter()
            .position(|segment| *segment == "contests")
            .ok_or("Contest not found. Enter a valid AtCoder contest URL.")?;
        let contest_id = segments
            .get(contest_index + 1)
            .filter(|value| !value.is_empty())
            .ok_or("Contest not found. The contest ID is missing from the URL.")?;
        let tasks_url = format!("https://atcoder.jp/contests/{contest_id}/tasks?lang=en");
        let html = client
            .get(&tasks_url)
            .send()
            .map_err(|error| format!("Could not fetch the contest problem list: {error}"))?
            .error_for_status()
            .map_err(|error| format!("AtCoder returned an error: {error}"))?
            .text()
            .map_err(|error| error.to_string())?;
        let document = scraper::Html::parse_document(&html);
        let link_selector = scraper::Selector::parse("table tbody tr td a").unwrap();
        let mut task_urls = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for link in document.select(&link_selector) {
            if let Some(href) = link.value().attr("href") {
                if href.contains("/tasks/") && seen.insert(href.to_string()) {
                    task_urls.push(format!("https://atcoder.jp{href}"));
                }
            }
        }
        if task_urls.is_empty() {
            return Err("No problems were found in this contest.".into());
        }
        let mut problems = Vec::new();
        for task_url in task_urls.into_iter().take(30) {
            problems.push(fetch_atcoder_problem(&client, &task_url)?);
        }
        Ok(problems)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn codeforces_problem_key(url: &str) -> Option<(i64, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let parts = parsed.path_segments()?.collect::<Vec<_>>();
    if let Some(index) = parts.iter().position(|part| *part == "contest") {
        return Some((parts.get(index + 1)?.parse().ok()?, parts.get(index + 3)?.to_uppercase()));
    }
    let index = parts.iter().position(|part| *part == "problem")?;
    Some((parts.get(index + 1)?.parse().ok()?, parts.get(index + 2)?.to_uppercase()))
}

fn atcoder_problem_key(url: &str) -> Option<(String, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let parts = parsed.path_segments()?.collect::<Vec<_>>();
    let contest = parts.get(parts.iter().position(|part| *part == "contests")? + 1)?.to_string();
    let task = parts.get(parts.iter().position(|part| *part == "tasks")? + 1)?.to_string();
    Some((contest, task))
}

fn doj_problem_id(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    parsed.path_segments()?.filter(|part| !part.is_empty()).next_back().map(str::to_string)
}

fn fetch_atcoder_submissions(
    client: &reqwest::blocking::Client,
    handle: &str,
    initial_from_second: u64,
) -> Vec<serde_json::Value> {
    let mut submissions = Vec::new();
    let mut from_second = initial_from_second;
    // The AtCoder Problems API returns a bounded page. Advance its timestamp
    // cursor until the newest page is reached; otherwise active users can have
    // a virtual-contest submission omitted from the first response.
    for _ in 0..20 {
        let mut url = reqwest::Url::parse(
            "https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions",
        )
        .unwrap();
        url.query_pairs_mut()
            .append_pair("user", handle)
            .append_pair("from_second", &from_second.to_string());
        let page = client
            .get(url)
            .send()
            .and_then(|response| response.error_for_status())
            .ok()
            .and_then(|response| response.json::<Vec<serde_json::Value>>().ok())
            .unwrap_or_default();
        if page.is_empty() {
            break;
        }
        let Some(latest_second) = page
            .iter()
            .filter_map(|submission| submission.get("epoch_second").and_then(|value| value.as_u64()))
            .max()
        else {
            break;
        };
        submissions.extend(page);
        if latest_second < from_second || latest_second == u64::MAX {
            break;
        }
        from_second = latest_second + 1;
    }
    submissions
}

fn refresh_submission_statuses_sync(request: SubmissionStatusRequest) -> Result<Vec<SubmissionStatus>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("MildEditor/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let mut statuses = Vec::new();
    let folder_path = request.folder_path.clone();

    let codeforces_submissions = if request.codeforces_handle.trim().is_empty() {
        Vec::new()
    } else {
        let mut url = reqwest::Url::parse("https://codeforces.com/api/user.status").unwrap();
        url.query_pairs_mut().append_pair("handle", request.codeforces_handle.trim()).append_pair("from", "1").append_pair("count", "100");
        let value: serde_json::Value = client.get(url).send().and_then(|response| response.error_for_status()).map_err(|error| format!("Could not refresh Codeforces submissions: {error}"))?.json().map_err(|error| error.to_string())?;
        value.get("result").and_then(|result| result.as_array()).cloned().unwrap_or_default()
    };
    let atcoder_recent_submissions = if request.atcoder_handle.trim().is_empty() {
        Vec::new()
    } else {
        // Keep this window narrow so a very active user's newest virtual-contest
        // submissions cannot be pushed out of the API response by older entries.
        let from_second = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs().saturating_sub(7 * 24 * 60 * 60);
        fetch_atcoder_submissions(&client, request.atcoder_handle.trim(), from_second)
    };
    let mut atcoder_extended_submissions: Option<Vec<serde_json::Value>> = None;

    for problem in request.problems {
        let mut status = None;
        let mut submission_url = None;
        match problem.source.as_str() {
            "codeforces" if !request.codeforces_handle.trim().is_empty() => {
                if let Some((contest, index)) = codeforces_problem_key(&problem.source_url) {
                    if let Some(submission) = codeforces_submissions.iter().find(|submission| {
                        submission.pointer("/problem/contestId").and_then(|value| value.as_i64()) == Some(contest)
                            && submission.pointer("/problem/index").and_then(|value| value.as_str()).is_some_and(|value| value.eq_ignore_ascii_case(&index))
                    }) {
                        status = Some(submission.get("verdict").and_then(|value| value.as_str()).unwrap_or("TESTING").replace('_', " "));
                        if let Some(id) = submission.get("id").and_then(|value| value.as_i64()) {
                            submission_url = Some(format!("https://codeforces.com/contest/{contest}/submission/{id}"));
                        }
                    }
                }
            }
            "atcoder" if !request.atcoder_handle.trim().is_empty() => {
                if let Some((contest, task)) = atcoder_problem_key(&problem.source_url) {
                    let mut submission = atcoder_recent_submissions.iter()
                        .filter(|submission| submission.get("problem_id").and_then(|value| value.as_str()) == Some(task.as_str()))
                        .max_by_key(|submission| submission.get("epoch_second").and_then(|value| value.as_i64()).unwrap_or_default());
                    if submission.is_none() {
                        let extended = atcoder_extended_submissions.get_or_insert_with(|| {
                            let from_second = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs()
                                .saturating_sub(90 * 24 * 60 * 60);
                            fetch_atcoder_submissions(&client, request.atcoder_handle.trim(), from_second)
                        });
                        submission = extended.iter()
                            .filter(|submission| submission.get("problem_id").and_then(|value| value.as_str()) == Some(task.as_str()))
                            .max_by_key(|submission| submission.get("epoch_second").and_then(|value| value.as_i64()).unwrap_or_default());
                    }
                    if let Some(submission) = submission {
                        status = submission.get("result").and_then(|value| value.as_str()).map(str::to_string);
                        if let Some(id) = submission.get("id").and_then(|value| value.as_i64()) {
                            submission_url = Some(format!("https://atcoder.jp/contests/{contest}/submissions/{id}"));
                        }
                    }
                }
            }
            "doj" if !request.doj_handle.trim().is_empty() => {
                if let Some(problem_id) = doj_problem_id(&problem.source_url) {
                    let mut url = reqwest::Url::parse("https://doj.kr/ko/status").unwrap();
                    url.query_pairs_mut().append_pair("user", request.doj_handle.trim()).append_pair("problem", &problem_id);
                    if let Ok(html) = client.get(url.clone()).send().and_then(|response| response.error_for_status()).and_then(|response| response.text()) {
                        let document = scraper::Html::parse_document(&html);
                        let row_selector = scraper::Selector::parse("table tbody tr").unwrap();
                        let score_selector = scraper::Selector::parse(".doj-score-bar-label").unwrap();
                        if let Some(score) = document.select(&row_selector).next().and_then(|row| row.select(&score_selector).next()) {
                            let score = score.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join("");
                            let values = score.split('/').collect::<Vec<_>>();
                            status = Some(if values.len() == 2 && values[0] == values[1] { "AC".into() } else if score.is_empty() { "JUDGING".into() } else { format!("SCORE {score}") });
                            submission_url = Some(url.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
        statuses.push(SubmissionStatus { source_url: problem.source_url, status, submission_url });
    }
    if let Some(folder_path) = folder_path {
        let folder = std::path::PathBuf::from(folder_path);
        let metadata_path = workspace_metadata_path(&folder);
        if let Ok(json) = fs::read_to_string(&metadata_path) {
            if let Ok(mut metadata) = serde_json::from_str::<WorkspaceMetadata>(&json) {
                for problem in &mut metadata.problems {
                    let inferred_url = if problem.source.as_deref() == Some("doj") {
                        Path::new(&problem.filename)
                            .file_stem()
                            .and_then(|value| value.to_str())
                            .filter(|value| value.chars().all(|character| character.is_ascii_digit()))
                            .map(|problem_id| format!("https://doj.kr/ko/problems/{problem_id}"))
                    } else {
                        None
                    };
                    let effective_url = problem.source_url.clone().or(inferred_url);
                    if let Some(url) = effective_url {
                        if let Some(result) = statuses.iter().find(|result| result.source_url == url.as_str()) {
                            problem.source_url = Some(url);
                            problem.judge_status = result.status.clone();
                        }
                    }
                }
                let json = serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?;
                fs::write(metadata_path, json).map_err(|error| format!("Could not save submission statuses: {error}"))?;
            }
        }
    }
    Ok(statuses)
}

#[tauri::command]
async fn refresh_submission_statuses(request: SubmissionStatusRequest) -> Result<Vec<SubmissionStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || refresh_submission_statuses_sync(request)).await.map_err(|error| error.to_string())?
}

fn resolve_clangd(configured_path: Option<String>) -> Result<std::path::PathBuf, String> {
    if let Some(path) = configured_path.filter(|path| !path.trim().is_empty()) {
        let path = std::path::PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
        return Err("The configured clangd executable was not found.".into());
    }
    which::which("clangd").map_err(|_| {
        "clangd was not found. Install LLVM clangd or configure its path in Settings.".into()
    })
}

#[tauri::command]
fn clangd_info(configured_path: Option<String>) -> ClangdInfo {
    match resolve_clangd(configured_path) {
        Ok(path) => {
            let version = Command::new(&path)
                .arg("--version")
                .creation_flags(0x08000000)
                .output()
                .ok()
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .and_then(|text| text.lines().next().map(str::to_string));
            ClangdInfo {
                available: true,
                path: Some(path.to_string_lossy().into_owned()),
                version,
            }
        }
        Err(_) => ClangdInfo {
            available: false,
            path: None,
            version: None,
        },
    }
}

fn read_lsp_stream<R: Read>(reader: R, app: tauri::AppHandle) {
    let mut reader = BufReader::new(reader);
    loop {
        let mut content_length = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
        let Some(length) = content_length else {
            continue;
        };
        let mut body = vec![0u8; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        if let Ok(message) = String::from_utf8(body) {
            let _ = app.emit("clangd-message", message);
        }
    }
}

#[tauri::command]
fn start_clangd(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClangdState>,
    configured_path: Option<String>,
    workspace_path: Option<String>,
    atcoder_library_path: Option<String>,
) -> Result<ClangdInfo, String> {
    let path = resolve_clangd(configured_path)?;
    let mut process_guard = state.0.lock().map_err(|_| "Could not lock clangd state.")?;
    if let Some(mut previous) = process_guard.take() {
        let _ = previous.child.kill();
        let _ = previous.child.wait();
    }
    let mut clangd_args = vec![
        "--background-index=false".to_string(),
        "--clang-tidy=false".to_string(),
        "--header-insertion=never".to_string(),
        "--log=error".to_string(),
    ];
    if let Ok(compiler) = which::which("g++") {
        clangd_args.push(format!("--query-driver={}", compiler.to_string_lossy()));
        if let Some(workspace_path) = workspace_path {
            let config_path = Path::new(&workspace_path).join(".clangd");
            if !config_path.exists() {
                let compiler_path = compiler.to_string_lossy().replace('\\', "/");
                let mut flags = vec!["-std=gnu++20".to_string()];
                if let Some(include) = atcoder_library_path.as_ref().filter(|path| !path.trim().is_empty()) {
                    flags.push(format!("-I{}", include.replace('\\', "/")));
                }
                let config = format!("CompileFlags:\n  Compiler: {compiler_path}\n  Add: [{}]\n", flags.join(", "));
                let _ = fs::write(config_path, config);
            }
        }
    }
    let mut child = Command::new(&path)
        .args(&clangd_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|error| format!("Could not start clangd: {error}"))?;
    let stdin = Arc::new(Mutex::new(
        child.stdin.take().ok_or("Could not open clangd stdin.")?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or("Could not open clangd stdout.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Could not open clangd stderr.")?;
    let stdout_app = app.clone();
    thread::spawn(move || read_lsp_stream(stdout, stdout_app));
    thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut sink);
    });
    *process_guard = Some(ClangdProcess { child, stdin });
    let version = Command::new(&path)
        .arg("--version")
        .creation_flags(0x08000000)
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| text.lines().next().map(str::to_string));
    Ok(ClangdInfo {
        available: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
    })
}

#[tauri::command]
fn send_clangd_message(
    state: tauri::State<'_, ClangdState>,
    message: String,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|_| "Could not lock clangd state.")?;
    let process = guard.as_ref().ok_or("clangd is not running.")?;
    let mut stdin = process.stdin.lock().map_err(|_| "Could not lock clangd stdin.")?;
    write!(
        stdin,
        "Content-Length: {}\r\n\r\n{}",
        message.as_bytes().len(),
        message
    )
    .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_companion(
    app: tauri::AppHandle,
    state: tauri::State<'_, companion::CompanionState>,
    port: Option<u16>,
) -> Result<companion::CompanionStatus, String> {
    companion::start(&state, port.unwrap_or(companion::DEFAULT_PORT), move |problem| {
        let _ = app.emit("companion-problem", problem);
    })?;
    Ok(companion::status(&state))
}

#[tauri::command]
fn stop_companion(state: tauri::State<'_, companion::CompanionState>) -> companion::CompanionStatus {
    companion::stop(&state);
    companion::status(&state)
}

#[tauri::command]
fn companion_status(state: tauri::State<'_, companion::CompanionState>) -> companion::CompanionStatus {
    companion::status(&state)
}

#[tauri::command]
fn stop_clangd(state: tauri::State<'_, ClangdState>) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut process) = guard.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(ClangdState::default())
        .manage(RunState::default())
        .manage(companion::CompanionState::default())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(target_os = "macos")]
    let builder = builder
        .setup(|app| {
            macos_menu::install(app.handle())?;
            Ok(())
        })
        .on_menu_event(macos_menu::forward_event);

    builder
        .invoke_handler(tauri::generate_handler![
            run_code,
            stop_run,
            close_app,
            read_font_file,
            read_image_file,
            save_workspace_tests,
            update_workspace_source,
            save_problem,
            load_problem,
            create_workspace,
            save_workspace,
            list_workspace_source_filenames,
            list_workspace_directories,
            create_workspace_folder,
            delete_workspace_folder,
            delete_workspace_file,
            open_workspace_file_location,
            open_workspace_folder_location,
            duplicate_workspace_file,
            rename_workspace_file,
            load_workspace,
            import_problem,
            refresh_submission_statuses,
            clangd_info,
            start_clangd,
            send_clangd_message,
            stop_clangd,
            start_companion,
            stop_companion,
            companion_status
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.emit("native-close-requested", ());
                }
                tauri::WindowEvent::Destroyed => {
                    let state = window.state::<ClangdState>();
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut process) = guard.take() {
                            let _ = process.child.kill();
                            let _ = process.child.wait();
                        }
                    };
                    companion::stop(&window.state::<companion::CompanionState>());
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running mild editor");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_shell(script: &str, timeout: Duration) -> RunResult {
        let shell = which::which("sh").expect("a POSIX shell");
        let directory = tempfile::tempdir().expect("temporary directory");
        execute(&shell, &["-c".into(), script.into()], directory.path(), "", timeout)
    }

    #[test]
    #[cfg_attr(windows, ignore = "requires a POSIX shell")]
    fn classifies_execution_verdicts() {
        let accepted = run_shell("printf 'done'", Duration::from_secs(5));
        assert_eq!(accepted.verdict, Verdict::Ok);
        assert_eq!(accepted.stdout, "done");
        assert!(accepted.ok);

        let runtime_error = run_shell("exit 3", Duration::from_secs(5));
        assert_eq!(runtime_error.verdict, Verdict::Re);
        assert_eq!(runtime_error.code, Some(3));
        assert!(!runtime_error.ok);

        let timed_out = run_shell("sleep 5", Duration::from_millis(300));
        assert_eq!(timed_out.verdict, Verdict::Tle);
        assert!(timed_out.stderr.contains("Error: TLE"));
        assert!(!timed_out.ok);
    }

    #[test]
    fn serializes_verdicts_as_lowercase_tags() {
        assert_eq!(serde_json::to_string(&Verdict::Ok).unwrap(), "\"ok\"");
        assert_eq!(serde_json::to_string(&Verdict::Ce).unwrap(), "\"ce\"");
        assert_eq!(serde_json::to_string(&Verdict::Tle).unwrap(), "\"tle\"");
        assert_eq!(serde_json::to_string(&Verdict::Stopped).unwrap(), "\"stopped\"");
    }

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
        let metadata = WorkspaceMetadata { version: 2, problems: Vec::new() };

        assert_eq!(unique_workspace_filename(directory.path(), "A.cpp", &metadata, None), "A (1).cpp");
        assert_eq!(unique_workspace_filename(directory.path(), "A (2).cpp", &metadata, None), "A (1).cpp");
        assert_eq!(unique_workspace_filename(directory.path(), "A.py", &metadata, None), "A (1).py");
        assert_eq!(unique_workspace_filename(directory.path(), "A.cpp", &metadata, Some("A.cpp")), "A.cpp");
        assert_eq!(safe_filename("346.CPP", "cpp").unwrap(), "346.CPP");
        assert_eq!(safe_filename("script.PY", "python").unwrap(), "script.PY");
    }

    #[test]
    fn rename_duplicate_and_delete_keep_files_and_metadata_in_sync() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(CreateWorkspaceRequest { folder_path: folder_path.clone() }).expect("create workspace");
        save_workspace(SaveWorkspaceRequest {
            folder_path: folder_path.clone(),
            problems: vec![WorkspaceProblemInput {
                filename: "A.cpp".into(), title: "A".into(), language: "cpp".into(), code: "int main() {}".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, modified_at: None,
            }],
        }).expect("save source");

        let renamed = rename_workspace_file(RenameWorkspaceFileRequest { folder_path: folder_path.clone(), filename: "A.cpp".into(), new_filename: "B.cpp".into() }).expect("rename source");
        assert_eq!(renamed.filename, "B.cpp");
        assert!(!directory.path().join("A.cpp").exists());
        assert!(directory.path().join("B.cpp").exists());

        update_workspace_source(UpdateWorkspaceSourceRequest {
            folder_path: folder_path.clone(), filename: "B.cpp".into(), source: "codeforces".into(), source_url: Some("https://codeforces.com/contest/2231/problem/C".into()),
        }).expect("classify source");

        let duplicated = duplicate_workspace_file(DuplicateWorkspaceFileRequest { folder_path: folder_path.clone(), filename: "B.cpp".into(), new_filename: "B copy.cpp".into() }).expect("duplicate source");
        assert_eq!(duplicated.filename, "B copy.cpp");
        assert!(directory.path().join("B copy.cpp").exists());

        delete_workspace_file(DeleteWorkspaceFileRequest { folder_path, filename: "B.cpp".into() }).expect("delete source");
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
        create_workspace(CreateWorkspaceRequest { folder_path: folder_path.clone() }).expect("create workspace");
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
        assert_eq!(list_workspace_directories(ListWorkspaceFilesRequest { folder_path }).unwrap(), vec!["solutions", "solutions (1)", "solutions/round"]);
    }

    #[test]
    fn deleting_workspace_folder_removes_nested_sources_and_metadata() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(CreateWorkspaceRequest { folder_path: folder_path.clone() }).unwrap();
        create_workspace_folder(CreateWorkspaceFolderRequest { folder_path: folder_path.clone(), name: "round".into(), parent_directory: String::new() }).unwrap();
        save_workspace(SaveWorkspaceRequest { folder_path: folder_path.clone(), problems: vec![WorkspaceProblemInput {
            filename: "round/A.cpp".into(), title: "A".into(), language: "cpp".into(), code: "int main() {}".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, modified_at: None,
        }] }).unwrap();

        let removed = delete_workspace_folder(DeleteWorkspaceFolderRequest { folder_path: folder_path.clone(), directory: "round".into() }).unwrap();
        assert_eq!(removed, vec!["round/A.cpp"]);
        assert!(!directory.path().join("round").exists());
        let metadata: WorkspaceMetadata = serde_json::from_str(&fs::read_to_string(directory.path().join(WORKSPACE_METADATA_FILENAME)).unwrap()).unwrap();
        assert!(metadata.problems.is_empty());
    }

    #[test]
    fn workspace_save_skips_unsupported_extensions() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(CreateWorkspaceRequest { folder_path: folder_path.clone() }).unwrap();
        let saved = save_workspace(SaveWorkspaceRequest { folder_path: folder_path.clone(), problems: vec![WorkspaceProblemInput {
            filename: "notes.txt".into(), title: "notes".into(), language: "cpp".into(), code: "ignored".into(), tests: Vec::new(), source: None, source_url: None, judge_status: None, modified_at: None,
        }] }).unwrap();
        assert!(saved.problems.is_empty());
        assert!(!directory.path().join("notes.txt").exists());
    }

    #[test]
    #[ignore = "requires access to atcoder.jp"]
    fn fetches_current_atcoder_samples() {
        let client = reqwest::blocking::Client::builder()
            .user_agent("MildEditor/test")
            .build()
            .unwrap();
        let problem =
            fetch_atcoder_problem(&client, "https://atcoder.jp/contests/abc414/tasks/abc414_a")
                .unwrap();
        assert_eq!(problem.suggested_filename, "A.cpp");
        assert_eq!(problem.tests.len(), 3);
    }

    #[test]
    fn atcoder_bilingual_statement_imports_each_sample_once() {
        let html = r#"
            <div id="task-statement">
              <span class="lang-ja">
                <h3>入力例 1</h3><pre>3
</pre>
                <h3>出力例 1</h3><pre>6
</pre>
              </span>
              <span class="lang-en">
                <h3>Sample Input 1</h3><pre>3
</pre>
                <h3>Sample Output 1</h3><pre>6
</pre>
              </span>
            </div>
        "#;
        let tests = parse_atcoder_samples(html);
        assert_eq!(tests.len(), 1);
        assert_eq!(tests[0].input, "3");
        assert_eq!(tests[0].expected, "6");
    }

    #[test]
    fn atcoder_japanese_only_statement_uses_fallback_samples() {
        let html = r#"
            <div id="task-statement">
              <h3>入力例 1</h3><pre>4
</pre>
              <h3>出力例 1</h3><pre>8
</pre>
            </div>
        "#;
        let tests = parse_atcoder_samples(html);
        assert_eq!(tests.len(), 1);
        assert_eq!(tests[0].input, "4");
        assert_eq!(tests[0].expected, "8");
    }

    #[test]
    fn atcoder_samples_support_nested_live_statement_markup() {
        let html = r#"<div id="task-statement"><span class="lang-en"><h3>Sample Input 1</h3><div class="sample"><pre>2 3</pre></div><h3>Sample Output 1</h3><div class="sample"><pre>5</pre></div></span></div>"#;
        let tests = parse_atcoder_samples(html);
        assert_eq!(tests.len(), 1);
        assert_eq!(tests[0].input, "2 3");
        assert_eq!(tests[0].expected, "5");
    }

    #[test]
    #[ignore = "requires access to codeforces.com through r.jina.ai"]
    fn fetches_codeforces_problem_and_contest_samples() {
        let client = reqwest::blocking::Client::builder()
            .user_agent("MildEditor/test")
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        let problem = fetch_codeforces_problem(&client, "https://codeforces.com/contest/2120/problem/A").unwrap();
        assert_eq!(problem.suggested_filename, "A.cpp");
        assert!(!problem.tests.is_empty());
        let recent_problem = fetch_codeforces_problem(&client, "https://codeforces.com/contest/2231/problem/C").unwrap();
        assert_eq!(recent_problem.suggested_filename, "C.cpp");
        assert_eq!(recent_problem.tests[0].input.lines().next(), Some("5"));
        assert_eq!(recent_problem.tests[0].expected.lines().next(), Some("3"));
        let emotes = fetch_codeforces_problem(&client, "https://codeforces.com/contest/1117/problem/B").unwrap();
        assert_eq!(emotes.suggested_filename, "B.cpp");
        assert_eq!(emotes.tests.len(), 2);
        assert_eq!(emotes.tests[0].input, "6 9 2\n1 3 3 7 4 2");
        assert_eq!(emotes.tests[0].expected, "54");
        let contest = fetch_codeforces_contest(&client, "https://codeforces.com/contest/4").unwrap();
        assert!(!contest.is_empty());
    }

    #[test]
    #[ignore = "requires access to codeforces.com through r.jina.ai"]
    fn fetches_codeforces_2257b_samples() {
        let client = reqwest::blocking::Client::builder()
            .user_agent("MildEditor/test")
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        let problem = fetch_codeforces_problem(&client, "https://codeforces.com/contest/2257/problem/B").unwrap();
        assert_eq!(problem.suggested_filename, "B.cpp");
        assert_eq!(problem.tests.len(), 1);
        assert_eq!(problem.tests[0].input.lines().next(), Some("6"));
        assert_eq!(problem.tests[0].input.lines().last(), Some("7 5"));
        assert_eq!(problem.tests[0].expected, "1\n2\n2\n2\n1\n2");
    }

    #[test]
    fn parses_modern_codeforces_sample_markup() {
        let html = r#"<div class="problem-statement"><div class="header"><div class="title">C. Example</div></div><div class="sample-test"><div class="input"><pre><div class="test-example-line">5</div><div class="test-example-line">3 2 4</div></pre></div><div class="output"><pre><div class="test-example-line">3</div><div class="test-example-line">11</div></pre></div></div></div>"#;
        let (title, tests) = parse_codeforces_html(html).expect("parse Codeforces sample");
        assert_eq!(title, "C. Example");
        assert_eq!(tests.len(), 1);
        assert_eq!(tests[0].input, "5\n3 2 4");
        assert_eq!(tests[0].expected, "3\n11");
    }

    #[test]
    fn parses_live_codeforces_contest_problem_links() {
        let html = r#"<table class="problems"><tbody><tr><td><a href="/contest/9999/problem/A">A</a></td></tr><tr><td><a href="/contest/9999/problem/B2">B2</a></td></tr></tbody></table>"#;
        let base = reqwest::Url::parse("https://codeforces.com/contest/9999?locale=en").unwrap();
        assert_eq!(parse_codeforces_contest_urls(html, &base), vec!["https://codeforces.com/contest/9999/problem/A".to_string(), "https://codeforces.com/contest/9999/problem/B2".to_string()]);
    }

    #[test]
    fn parses_codeforces_markdown_copy_blocks() {
        let markdown = r#"Title: Problem - 1117B - Codeforces

Markdown Content:
Examples

Input

Copy

6 9 2
1 3 3 7 4 2

Output

Copy

54

Input

Copy

3 1000000000 1
1000000000 987654321 1000000000

Output

Copy

1000000000000000000

Note
"#;
        let (_, tests) = parse_codeforces_markdown(markdown).expect("parse Codeforces markdown samples");
        assert_eq!(tests.len(), 2);
        assert_eq!(tests[0].input, "6 9 2\n1 3 3 7 4 2");
        assert_eq!(tests[0].expected, "54");
        assert_eq!(tests[1].expected, "1000000000000000000");
    }

    #[test]
    fn parses_codeforces_targeted_copy_block() {
        let markdown = "Title: Problem - B - Codeforces\n\nMarkdown Content:\nInput\n\nCopy\n\n6\n\n1 1\n\n7 5\n";
        assert_eq!(parse_codeforces_targeted_block(markdown, "Input").as_deref(), Some("6\n1 1\n7 5"));
    }

    #[test]
    fn reads_supported_background_images() {
        let image = tempfile::Builder::new().suffix(".png").tempfile().expect("create image");
        fs::write(image.path(), [0x89, b'P', b'N', b'G']).expect("write image");
        let loaded = read_image_file(ReadImageFileRequest { path: image.path().to_string_lossy().into_owned() }).expect("read image");
        assert_eq!(loaded.mime, "image/png");
        assert_eq!(loaded.bytes, [0x89, b'P', b'N', b'G']);

        let text = tempfile::Builder::new().suffix(".txt").tempfile().expect("create text");
        assert!(read_image_file(ReadImageFileRequest { path: text.path().to_string_lossy().into_owned() }).is_err());
    }
}
