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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunResult {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    time_ms: u128,
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
struct ReadFontFileRequest {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveWorkspaceTestsRequest {
    folder_path: String,
    filename: String,
    tests: Vec<SavedTestCase>,
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
    if status.is_none() {
        stderr.push_str(if stopped { "\nStopped" } else { "\nTime limit exceeded (2s)" });
    }
    if stdout_bytes.len() as u64 >= MAX_OUTPUT || stderr_bytes.len() as u64 >= MAX_OUTPUT {
        stderr.push_str("\nOutput limit exceeded");
    }

    RunResult {
        ok: status.map(|value| value.success()).unwrap_or(false),
        code: status.and_then(|value| value.code()),
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr,
        time_ms: started.elapsed().as_millis(),
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
                source.to_string_lossy().into_owned(),
                "-o".into(),
                binary.to_string_lossy().into_owned(),
            ];
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
fn save_workspace_tests(request: SaveWorkspaceTestsRequest) -> Result<(), String> {
    let folder = std::path::PathBuf::from(request.folder_path);
    let metadata_path = workspace_metadata_path(&folder);
    let json = fs::read_to_string(&metadata_path).map_err(|error| format!("Could not read workspace metadata: {error}"))?;
    let mut metadata: WorkspaceMetadata = serde_json::from_str(&json).map_err(|error| format!("Invalid workspace metadata: {error}"))?;
    let problem = metadata.problems.iter_mut().find(|problem| problem.filename.eq_ignore_ascii_case(&request.filename)).ok_or("Workspace file metadata was not found.")?;
    problem.tests = request.tests;
    fs::write(metadata_path, serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?).map_err(|error| format!("Could not save test cases: {error}"))
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
    let path = Path::new(filename);
    if filename.trim().is_empty()
        || path.file_name().and_then(|value| value.to_str()) != Some(filename)
    {
        return Err(format!("Invalid filename: {filename}"));
    }
    let valid_extension = match language {
        "cpp" => ["cpp", "cc", "cxx"].contains(
            &path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or(""),
        ),
        "python" => path.extension().and_then(|value| value.to_str()) == Some("py"),
        _ => false,
    };
    if !valid_extension {
        return Err(format!("The language does not match the file extension: {filename}"));
    }
    Ok(filename.to_string())
}

fn workspace_source_filename(filename: &str) -> Result<(String, String), String> {
    let path = Path::new(filename);
    if filename.trim().is_empty() || path.file_name().and_then(|value| value.to_str()) != Some(filename) {
        return Err("Invalid workspace filename.".into());
    }
    let language = match path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()).as_deref() {
        Some("cpp") | Some("cc") | Some("cxx") => "cpp",
        Some("py") => "python",
        _ => return Err("Workspace files must use .cpp, .cc, .cxx, or .py.".into()),
    };
    Ok((filename.to_string(), language.to_string()))
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
    for problem in &request.problems {
        let filename = safe_filename(&problem.filename, &problem.language)?;
        if !new_filenames.insert(filename.clone()) {
            return Err(format!("Duplicate filename: {filename}"));
        }
    }
    let previous_metadata = fs::read_to_string(workspace_metadata_path(&folder))
        .ok()
        .and_then(|json| serde_json::from_str::<WorkspaceMetadata>(&json).ok())
        .unwrap_or(WorkspaceMetadata { version: 2, problems: Vec::new() });
    let mut metadata_problems = previous_metadata.problems;
    let mut outputs = Vec::new();
    for problem in request.problems {
        let filename = safe_filename(&problem.filename, &problem.language)?;
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
    Command::new("explorer")
        .arg(format!("/select,{}", source.to_string_lossy()))
        .spawn()
        .map_err(|error| format!("Could not open file location: {error}"))?;
    Ok(())
}

#[tauri::command]
fn duplicate_workspace_file(request: DuplicateWorkspaceFileRequest) -> Result<WorkspaceProblemOutput, String> {
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let (new_filename, new_language) = workspace_source_filename(&request.new_filename)?;
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata: WorkspaceMetadata = fs::read_to_string(&metadata_path).map_err(|error| format!("Could not read workspace metadata: {error}")).and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))?;
    if metadata.problems.iter().any(|problem| problem.filename.eq_ignore_ascii_case(&new_filename)) { return Err("A file with that name already exists.".into()); }
    let source_problem = metadata.problems.iter().find(|problem| problem.filename == filename).cloned().ok_or("Workspace file metadata was not found.")?;
    let source = folder.join(&filename);
    let destination = folder.join(&new_filename);
    fs::copy(&source, &destination).map_err(|error| format!("Could not duplicate source file: {error}"))?;
    let code = fs::read_to_string(&destination).map_err(|error| format!("Could not read duplicated source file: {error}"))?;
    let duplicated = WorkspaceProblemMetadata { filename: new_filename.clone(), title: source_problem.title.clone(), language: new_language.clone(), tests: source_problem.tests.clone(), source: source_problem.source.clone(), modified_at: file_modified_at(&destination) };
    metadata.problems.push(duplicated.clone());
    fs::write(metadata_path, serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?).map_err(|error| format!("Could not update workspace metadata: {error}"))?;
    Ok(WorkspaceProblemOutput { filename: new_filename, title: duplicated.title, language: new_language, code, tests: duplicated.tests, source: duplicated.source, modified_at: duplicated.modified_at })
}

#[tauri::command]
fn rename_workspace_file(request: RenameWorkspaceFileRequest) -> Result<WorkspaceProblemOutput, String> {
    let folder = std::path::PathBuf::from(&request.folder_path);
    let (filename, _) = workspace_source_filename(&request.filename)?;
    let (new_filename, new_language) = workspace_source_filename(&request.new_filename)?;
    let metadata_path = workspace_metadata_path(&folder);
    let mut metadata: WorkspaceMetadata = fs::read_to_string(&metadata_path).map_err(|error| format!("Could not read workspace metadata: {error}")).and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))?;
    if !filename.eq_ignore_ascii_case(&new_filename) && metadata.problems.iter().any(|problem| problem.filename.eq_ignore_ascii_case(&new_filename)) { return Err("A file with that name already exists.".into()); }
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
    let result = WorkspaceProblemOutput { filename: new_filename, title: problem.title.clone(), language: new_language, code: fs::read_to_string(folder.join(&problem.filename)).map_err(|error| format!("Could not read renamed source file: {error}"))?, tests: problem.tests.clone(), source: problem.source.clone(), modified_at: problem.modified_at };
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
    if !metadata_path.exists() {
        let loaded = load_problem(selected.to_string_lossy().into_owned())?;
        let filename = selected
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if loaded.language == "python" {
                    "main.py".into()
                } else {
                    "main.cpp".into()
                }
            });
        return Ok(LoadedWorkspace {
            folder_path: loaded.folder_path,
            problems: vec![WorkspaceProblemOutput {
                filename,
                title: loaded.title,
                language: loaded.language,
                code: loaded.code,
                tests: loaded.tests,
                source: None,
                modified_at: file_modified_at(&selected),
            }],
        });
    }
    let json = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("Could not read workspace metadata: {error}"))?;
    let metadata: WorkspaceMetadata = match serde_json::from_str(&json) {
        Ok(metadata) => metadata,
        Err(_) => {
            let old: ProblemMetadata = serde_json::from_str(&json)
                .map_err(|error| format!("Invalid .mild-editor.json format: {error}"))?;
            WorkspaceMetadata {
                version: 2,
                problems: vec![WorkspaceProblemMetadata {
                    filename: if old.language == "python" {
                        "main.py".into()
                    } else {
                        "main.cpp".into()
                    },
                    title: old.title,
                    language: old.language,
                    tests: old.tests,
                    source: None,
                    modified_at: 0,
                }],
            }
        }
    };
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
            modified_at: if problem.modified_at > 0 { problem.modified_at } else { file_modified_at(&source_path) },
        });
    }
    Ok(LoadedWorkspace {
        folder_path: folder.to_string_lossy().into_owned(),
        problems,
    })
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
    let heading_selector =
        scraper::Selector::parse("#task-statement .lang-en h3, #task-statement h3").unwrap();
    let title_selector = scraper::Selector::parse("span.h2, .h2").unwrap();
    let mut inputs: Vec<(String, String)> = Vec::new();
    let mut outputs: Vec<(String, String)> = Vec::new();
    for heading in document.select(&heading_selector) {
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
                if element.value().name() == "pre" {
                    let value = element
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
    for (index, (number, input)) in inputs.into_iter().enumerate() {
        if let Some((_, expected)) = outputs
            .iter()
            .find(|(output_number, _)| output_number == &number)
            .or_else(|| outputs.get(index))
        {
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
    })
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
    let reader_url = format!("https://r.jina.ai/https://codeforces.com/problemset/problem/{contest}/{letter}?locale=en");
    let markdown = client.get(reader_url).send().map_err(|error| format!("Could not fetch Codeforces: {error}"))?
        .error_for_status().map_err(|error| format!("Codeforces response error: {error}"))?
        .text().map_err(|error| error.to_string())?;
    let title = markdown.lines().find_map(|line| line.strip_prefix("Title: ")).unwrap_or("Codeforces problem").trim().to_string();
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut tests = Vec::new();
    let mut cursor = lines.iter().position(|line| matches!(line.trim(), "Examples" | "Example")).unwrap_or(lines.len());
    while cursor < lines.len() {
        if lines[cursor].trim() != "Input" { cursor += 1; continue; }
        cursor += 1;
        while cursor < lines.len() && (lines[cursor].trim().is_empty() || lines[cursor].trim() == "Copy") { cursor += 1; }
        let mut input = Vec::new();
        while cursor < lines.len() && lines[cursor].trim() != "Output" { if !lines[cursor].trim().is_empty() { input.push(lines[cursor]); } cursor += 1; }
        if cursor >= lines.len() { break; }
        cursor += 1;
        while cursor < lines.len() && (lines[cursor].trim().is_empty() || lines[cursor].trim() == "Copy") { cursor += 1; }
        let mut output = Vec::new();
        while cursor < lines.len() && !matches!(lines[cursor].trim(), "Input" | "Note" | "Tutorial" | "Codeforces") { if !lines[cursor].trim().is_empty() { output.push(lines[cursor]); } cursor += 1; }
        if !input.is_empty() && !output.is_empty() { tests.push(SavedTestCase { name: format!("test {}", tests.len() + 1), input: input.join("\n"), expected: output.join("\n") }); }
    }
    if tests.is_empty() { return Err("No sample test cases found on Codeforces.".into()); }
    Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{}.cpp", letter.to_uppercase()), tests, source: "codeforces".into() })
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
    Ok(ImportedAtCoderProblem { title, suggested_filename: format!("{problem_id}.cpp"), tests, source: "doj".into() })
}

fn fetch_codeforces_contest(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<ImportedAtCoderProblem>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid Codeforces contest URL.".to_string())?;
    let segments = parsed.path_segments().map(|values| values.collect::<Vec<_>>()).unwrap_or_default();
    let contest_marker = segments.iter().position(|value| *value == "contest").ok_or("This is not a Codeforces contest URL.")?;
    let contest = segments.get(contest_marker + 1).ok_or("Missing Codeforces contest ID.")?;
    let reader_url = format!("https://r.jina.ai/https://codeforces.com/contest/{contest}?locale=en");
    let markdown = client.get(reader_url).send().map_err(|error| format!("Could not fetch Codeforces contest: {error}"))?
        .error_for_status().map_err(|error| format!("Codeforces response error: {error}"))?.text().map_err(|error| error.to_string())?;
    let prefix = format!("https://codeforces.com/contest/{contest}/problem/");
    let mut urls = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for part in markdown.split(&prefix).skip(1) {
        let letter = part.chars().take_while(|character| character.is_ascii_alphanumeric()).collect::<String>();
        if !letter.is_empty() && seen.insert(letter.clone()) { urls.push(format!("{prefix}{letter}")); }
    }
    if urls.is_empty() { return Err("No problems found in the Codeforces contest.".into()); }
    urls.into_iter().take(30).map(|problem_url| fetch_codeforces_problem(client, &problem_url)).collect()
}

#[tauri::command]
async fn import_problem(url: String) -> Result<Vec<ImportedAtCoderProblem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent("MildEditor/0.6.2")
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
                let config = format!("CompileFlags:\n  Compiler: {compiler_path}\n  Add: [-std=gnu++20]\n");
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
    tauri::Builder::default()
        .manage(ClangdState::default())
        .manage(RunState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            run_code,
            stop_run,
            close_app,
            read_font_file,
            save_workspace_tests,
            save_problem,
            load_problem,
            create_workspace,
            save_workspace,
            delete_workspace_file,
            open_workspace_file_location,
            duplicate_workspace_file,
            rename_workspace_file,
            load_workspace,
            import_problem,
            clangd_info,
            start_clangd,
            send_clangd_message,
            stop_clangd
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

    #[test]
    fn rename_duplicate_and_delete_keep_files_and_metadata_in_sync() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let folder_path = directory.path().to_string_lossy().into_owned();
        create_workspace(CreateWorkspaceRequest { folder_path: folder_path.clone() }).expect("create workspace");
        save_workspace(SaveWorkspaceRequest {
            folder_path: folder_path.clone(),
            problems: vec![WorkspaceProblemInput {
                filename: "A.cpp".into(), title: "A".into(), language: "cpp".into(), code: "int main() {}".into(), tests: Vec::new(), source: None, modified_at: None,
            }],
        }).expect("save source");

        let renamed = rename_workspace_file(RenameWorkspaceFileRequest { folder_path: folder_path.clone(), filename: "A.cpp".into(), new_filename: "B.cpp".into() }).expect("rename source");
        assert_eq!(renamed.filename, "B.cpp");
        assert!(!directory.path().join("A.cpp").exists());
        assert!(directory.path().join("B.cpp").exists());

        let duplicated = duplicate_workspace_file(DuplicateWorkspaceFileRequest { folder_path: folder_path.clone(), filename: "B.cpp".into(), new_filename: "B copy.cpp".into() }).expect("duplicate source");
        assert_eq!(duplicated.filename, "B copy.cpp");
        assert!(directory.path().join("B copy.cpp").exists());

        delete_workspace_file(DeleteWorkspaceFileRequest { folder_path, filename: "B.cpp".into() }).expect("delete source");
        assert!(!directory.path().join("B.cpp").exists());
        let metadata: WorkspaceMetadata = serde_json::from_str(&fs::read_to_string(directory.path().join(WORKSPACE_METADATA_FILENAME)).expect("read metadata")).expect("parse metadata");
        assert_eq!(metadata.problems.len(), 1);
        assert_eq!(metadata.problems[0].filename, "B copy.cpp");
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
        let contest = fetch_codeforces_contest(&client, "https://codeforces.com/contest/4").unwrap();
        assert!(!contest.is_empty());
    }
}
