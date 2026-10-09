//! Compiling the program under test and judging it against the test cases.

use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::Emitter;
use wait_timeout::ChildExt;

use crate::stress::StressProgram;
use crate::tools::{decode_output, find_tool, tool_search_path, CommandExtHidden};
use crate::{checker, memory, pch};

pub(crate) const MAX_CODE: usize = 100_000;
const MAX_INPUT: usize = 100_000;
const MAX_OUTPUT: u64 = 1_000_001;

const MISSING_COMPILER: &str = if cfg!(target_os = "macos") {
    "g++ was not found. Install the Xcode Command Line Tools with `xcode-select --install`, or GCC with `brew install gcc`."
} else if cfg!(windows) {
    "g++ was not found. Install MinGW or GCC and add it to PATH."
} else {
    "g++ was not found. Install GCC with your package manager and add it to PATH."
};

const MISSING_PYTHON: &str = if cfg!(target_os = "macos") {
    "Python was not found. Install Python 3 from python.org or with `brew install python`."
} else {
    "Python was not found. Install Python 3 and add it to PATH."
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunRequest {
    language: String,
    code: String,
    tests: Vec<TestInput>,
    run_id: String,
    #[serde(default)]
    atcoder_library_path: Option<String>,
    /// The problem's own limits; absent means the 2 s default and no memory limit.
    #[serde(default)]
    time_limit_ms: Option<u64>,
    #[serde(default)]
    memory_limit_mb: Option<u64>,
    /// A special judge for the problem; without one the output is compared with the expected
    /// one by the frontend.
    #[serde(default)]
    checker: Option<StressProgram>,
    #[serde(flatten)]
    build: BuildOptions,
}

/// How the C++ program is built: the flags of the selected compile profile, and whether
/// `bits/stdc++.h` may come from a precompiled header. Python ignores both.
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuildOptions {
    #[serde(default)]
    pub(crate) compile_flags: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) precompile_headers: bool,
}

impl BuildOptions {
    /// `-O2` is what the runner always used before profiles existed.
    fn flags(&self) -> Vec<String> {
        match &self.compile_flags {
            Some(flags) => flags.iter().map(|flag| flag.trim().to_string()).filter(|flag| !flag.is_empty()).take(64).collect(),
            None => vec!["-O2".into()],
        }
    }
}

pub(crate) struct RunState(pub(crate) Arc<AtomicBool>);

impl Default for RunState {
    fn default() -> Self { Self(Arc::new(AtomicBool::new(false))) }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TestResultEvent {
    run_id: String,
    index: usize,
    result: RunResult,
    /// The special judge's verdict, for a run that exited cleanly and has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    checker: Option<checker::CheckerVerdict>,
}

#[derive(Deserialize)]
struct TestInput {
    input: String,
    /// Only a checker reads it; without one the frontend compares.
    expected: String,
}

/// Competitive-programming verdict for a single execution, independent of whether
/// the produced output matches the expected one. The frontend turns `Ok` into
/// `AC`/`WA` by comparing the streams; every other value is already final.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Verdict {
    Ok,
    /// Compilation failed before any test could run.
    Ce,
    /// The process exited with a non-zero status or could not be spawned.
    Re,
    /// The process was still alive when the time limit expired.
    Tle,
    /// The process grew past the memory limit.
    Mle,
    /// The process wrote more than `MAX_OUTPUT` bytes.
    Limit,
    /// The user cancelled the run.
    Stopped,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunResult {
    pub(crate) ok: bool,
    pub(crate) code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    time_ms: u128,
    /// Peak resident memory in KiB, where the platform reports it.
    memory_kb: Option<u64>,
    pub(crate) verdict: Verdict,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunResponse {
    results: Vec<RunResult>,
    /// Compiler warnings from a successful build, for the editor to mark.
    compile_warnings: String,
}

fn read_limited<R: Read>(reader: R) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = reader.take(MAX_OUTPUT).read_to_end(&mut bytes);
    bytes
}

pub(crate) fn execute(
    command: &Path,
    args: &[String],
    cwd: &Path,
    input: &str,
    timeout: Duration,
) -> RunResult {
    execute_with_cancel(command, args, cwd, input, timeout, None, None)
}

pub(crate) fn execute_with_cancel(
    command: &Path,
    args: &[String],
    cwd: &Path,
    input: &str,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
    memory_limit_kb: Option<u64>,
) -> RunResult {
    let started = Instant::now();
    let mut child = match Command::new(command)
        .args(args)
        .current_dir(cwd)
        .env("PATH", tool_search_path())
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
                memory_kb: None,
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
    let mut memory_exceeded = false;
    let mut memory_kb: Option<u64> = None;
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
        // Short polls: they are also the memory samples, and on Linux and macOS the only ones.
        let wait = Duration::from_millis(15).min(timeout - elapsed);
        let waited = child.wait_timeout(wait);
        memory_kb = memory_kb.max(memory::peak_memory_kb(&child));
        if memory_limit_kb.is_some_and(|limit| memory_kb.is_some_and(|used| used > limit)) {
            memory_exceeded = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        match waited {
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
    let mut stderr = decode_output(&stderr_bytes);
    let mut verdict = match status {
        Some(value) if value.success() => Verdict::Ok,
        Some(_) => Verdict::Re,
        None if stopped => Verdict::Stopped,
        None if memory_exceeded => Verdict::Mle,
        None => Verdict::Tle,
    };
    if status.is_none() {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        if stopped {
            stderr.push_str("Error: stopped");
        } else if memory_exceeded {
            stderr.push_str(&format!("Error: MLE ({} MB)", memory_limit_kb.unwrap_or(0) / 1024));
        } else if timeout.subsec_millis() != 0 {
            stderr.push_str(&format!("Error: TLE ({} ms)", timeout.as_millis()));
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
        memory_kb,
        verdict,
    }
}

/// Compiles (C++) or locates (Python) the program under test inside `cwd` and returns the
/// command line that runs it. `unbuffered` only matters for interactive runs, where the
/// interpreter must not hold a prompt in its own buffer.
pub(crate) enum PreparedProgram {
    /// `warnings` is what the compiler said about a build that succeeded.
    Ready { command: std::path::PathBuf, args: Vec<String>, warnings: String },
    CompileError(RunResult),
}

pub(crate) fn prepare_program(
    language: &str,
    code: &str,
    atcoder_library_path: Option<&str>,
    cwd: &Path,
    unbuffered: bool,
    build: &BuildOptions,
) -> Result<PreparedProgram, String> {
    if language == "cpp" {
        let compiler = find_tool("g++").ok_or_else(|| MISSING_COMPILER.to_string())?;
        let source = cwd.join("main.cpp");
        let binary = cwd.join(if cfg!(windows) { "main.exe" } else { "main" });
        fs::write(&source, code).map_err(|error| error.to_string())?;

        let flags = build.flags();
        let wants_pch = build.precompile_headers && code.contains("bits/stdc++.h");
        let mut compile = None;
        for standard in ["c++20", "c++17", "c++1z", "c++14"] {
            let pch_include = wants_pch.then(|| pch::ensure(&compiler, standard, &flags)).flatten();
            let compile_with = |pch_include: Option<&std::path::PathBuf>| {
                let mut compile_args = vec![format!("-std={standard}")];
                compile_args.extend(flags.iter().cloned());
                compile_args.push("-pipe".into());
                // First on the include path, so `bits/stdc++.h.gch` is found before the header itself.
                if let Some(directory) = pch_include {
                    compile_args.push(format!("-I{}", directory.to_string_lossy()));
                }
                if let Some(path) = atcoder_library_path.filter(|path| !path.trim().is_empty()) {
                    compile_args.push(format!("-I{path}"));
                }
                compile_args.push(source.to_string_lossy().into_owned());
                compile_args.push("-o".into());
                compile_args.push(binary.to_string_lossy().into_owned());
                // Sanitizers and debug containers are slow to build.
                execute(&compiler, &compile_args, cwd, "", Duration::from_secs(30))
            };
            let mut result = compile_with(pch_include.as_ref());
            // A header GCC cannot load back is its own failure, not the program's. One built
            // now takes an address that is free now, so it is rebuilt once; if that one will
            // not load either, this compiler goes without from here on.
            if pch_include.is_some() && !result.ok && pch::failed_to_load(&result.stderr) {
                let rebuilt = pch::rebuild(&compiler, standard, &flags);
                result = compile_with(rebuilt.as_ref());
                if let Some(directory) = rebuilt.as_ref().filter(|_| !result.ok && pch::failed_to_load(&result.stderr)) {
                    pch::give_up(directory);
                    result = compile_with(None);
                }
            }
            let unsupported = result.stderr.contains("unrecognized command line option");
            compile = Some(result);
            if compile.as_ref().is_some_and(|value| value.ok) || !unsupported {
                break;
            }
        }
        let compile = compile.expect("compile attempt");
        if !compile.ok {
            return Ok(PreparedProgram::CompileError(RunResult {
                stdout: String::new(),
                stderr: format!("Compile error\n{}", compile.stderr),
                verdict: Verdict::Ce,
                ..compile
            }));
        }
        Ok(PreparedProgram::Ready { command: binary, args: Vec::new(), warnings: compile.stderr })
    } else {
        // Windows keeps `python` first because its `python3` is usually the
        // Microsoft Store execution alias, which opens the Store instead of running.
        let candidates = if cfg!(windows) { ["python", "python3"] } else { ["python3", "python"] };
        let python = candidates
            .iter()
            .find_map(|name| find_tool(name))
            .ok_or_else(|| MISSING_PYTHON.to_string())?;
        let source = cwd.join("main.py");
        fs::write(&source, code).map_err(|error| error.to_string())?;
        let mut args = vec!["-I".to_string()];
        if unbuffered {
            args.push("-u".into());
        }
        args.push(source.to_string_lossy().into_owned());
        Ok(PreparedProgram::Ready { command: python, args, warnings: String::new() })
    }
}

fn run_sync(request: RunRequest, app: tauri::AppHandle, cancelled: Arc<AtomicBool>) -> Result<RunResponse, String> {
    run_tests(&request, &cancelled, &|event| { let _ = app.emit("test-result", event); })
}

/// Builds the solution (and its checker, if it has one) and runs every test, reporting each
/// result through `report` as it lands so the panel fills in while the rest still run.
fn run_tests(request: &RunRequest, cancelled: &AtomicBool, report: &dyn Fn(TestResultEvent)) -> Result<RunResponse, String> {
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

    let (command, args, compile_warnings) = match prepare_program(
        &request.language,
        &request.code,
        request.atcoder_library_path.as_deref(),
        cwd,
        false,
        &request.build,
    )? {
        PreparedProgram::Ready { command, args, warnings } => (command, args, warnings),
        PreparedProgram::CompileError(result) => {
            let results = request.tests.iter().enumerate().map(|(index, _)| {
                report(TestResultEvent { run_id: request.run_id.clone(), index, result: result.clone(), checker: None });
                result.clone()
            }).collect();
            return Ok(RunResponse { results, compile_warnings: String::new() });
        }
    };
    // After the solution, so a solution that does not compile is reported as such first.
    let checker = match &request.checker {
        Some(program) => match checker::prepare(program, request.atcoder_library_path.as_deref(), &cwd.join("checker"), &request.build)? {
            Ok(checker) => Some(checker),
            Err(message) => return Err(format!("The checker does not compile.\n{message}")),
        },
        None => None,
    };

    let time_limit = Duration::from_millis(request.time_limit_ms.unwrap_or(2000).clamp(100, 60_000));
    let memory_limit_kb = request.memory_limit_mb.map(|limit| limit.clamp(1, 16_384) * 1024);
    let mut results = Vec::new();
    for (index, test) in request.tests.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) { break; }
        let result = execute_with_cancel(&command, &args, cwd, &test.input, time_limit, Some(cancelled), memory_limit_kb);
        let verdict = checker.as_ref()
            .filter(|_| result.verdict == Verdict::Ok)
            .map(|checker| checker.check(&test.input, &result.stdout, &test.expected, Some(cancelled)));
        let stopped = cancelled.load(Ordering::Relaxed);
        report(TestResultEvent { run_id: request.run_id.clone(), index, result: result.clone(), checker: verdict });
        results.push(result);
        if stopped { break; }
    }
    Ok(RunResponse { results, compile_warnings })
}

#[tauri::command]
pub(crate) async fn run_code(app: tauri::AppHandle, state: tauri::State<'_, RunState>, request: RunRequest) -> Result<RunResponse, String> {
    state.0.store(false, Ordering::Relaxed);
    let cancelled = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || run_sync(request, app, cancelled))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn stop_run(state: tauri::State<'_, RunState>) {
    state.0.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stress::{python_program, ANY_ORDER_CHECKER};

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
        assert_eq!(serde_json::to_string(&Verdict::Mle).unwrap(), "\"mle\"");
        assert_eq!(serde_json::to_string(&Verdict::Stopped).unwrap(), "\"stopped\"");
    }

    /// Skipped, not failed, on a machine without Python: the runner is what is under test.
    fn python() -> Option<std::path::PathBuf> {
        ["python3", "python"].iter().find_map(|name| find_tool(name))
    }

    #[test]
    fn a_run_past_its_memory_limit_is_an_mle() {
        let Some(python) = python() else { return };
        let directory = tempfile::tempdir().expect("temporary directory");
        // Filled, not just reserved: untouched pages never become resident on Linux or macOS.
        let hog = "import time\nblock = b'x' * (300 * 1024 * 1024)\ntime.sleep(5)\n";
        let args = ["-c".to_string(), hog.to_string()];

        let limited = execute_with_cancel(&python, &args, directory.path(), "", Duration::from_secs(10), None, Some(64 * 1024));
        assert_eq!(limited.verdict, Verdict::Mle);
        assert!(limited.stderr.contains("Error: MLE (64 MB)"));
        assert!(limited.memory_kb.is_some_and(|used| used > 64 * 1024));

        let quick = execute_with_cancel(&python, &["-c".into(), "print(1)".into()], directory.path(), "", Duration::from_secs(10), None, Some(1024 * 1024));
        assert_eq!(quick.verdict, Verdict::Ok);
    }

    #[test]
    fn a_sub_second_time_limit_is_reported_in_milliseconds() {
        let Some(python) = python() else { return };
        let directory = tempfile::tempdir().expect("temporary directory");
        let result = execute(&python, &["-c".into(), "import time\ntime.sleep(5)".into()], directory.path(), "", Duration::from_millis(500));
        assert_eq!(result.verdict, Verdict::Tle);
        assert!(result.stderr.contains("Error: TLE (500 ms)"), "{}", result.stderr);
    }

    #[test]
    fn a_checker_judges_the_tests_and_only_runs_on_a_clean_exit() {
        if find_tool("python3").is_none() && find_tool("python").is_none() { return; }
        let test = |input: &str, expected: &str| TestInput { input: input.into(), expected: expected.into() };
        let request = RunRequest {
            language: "python".into(),
            // Prints the numbers back reversed, which only an any-order checker accepts, and
            // fails outright on a negative one.
            code: "a = input().split()\nassert not any(x.startswith('-') for x in a)\nprint(*reversed(a))\n".into(),
            tests: vec![test("1 2 3", "1 2 3"), test("4 5", "4 6"), test("-1", "-1")],
            run_id: "run".into(),
            atcoder_library_path: None,
            time_limit_ms: Some(10_000),
            memory_limit_mb: None,
            checker: Some(python_program(ANY_ORDER_CHECKER)),
            build: BuildOptions::default(),
        };
        let events = std::sync::Mutex::new(Vec::new());
        let response = run_tests(&request, &AtomicBool::new(false), &|event| events.lock().expect("events").push(event)).expect("runs");
        assert_eq!(response.results.len(), 3);
        let events = events.into_inner().expect("events");
        let verdicts: Vec<_> = events.iter().map(|event| (event.index, event.result.verdict, event.checker.as_ref().map(|verdict| verdict.accepted))).collect();
        assert_eq!(verdicts, vec![(0, Verdict::Ok, Some(true)), (1, Verdict::Ok, Some(false)), (2, Verdict::Re, None)]);
        assert_eq!(events[1].checker.as_ref().map(|verdict| verdict.message.as_str()), Some("wrong set"));

        // A checker that does not build stops the run with a message naming the checker, not
        // the solution, and before any test has been reported.
        let broken = RunRequest { checker: Some(python_program("def (:\n")), ..request };
        let reported = std::sync::atomic::AtomicUsize::new(0);
        let error = run_tests(&broken, &AtomicBool::new(false), &|_| { reported.fetch_add(1, Ordering::Relaxed); }).err().expect("an error");
        assert!(error.starts_with("The checker does not compile."), "{error}");
        assert_eq!(reported.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn build_options_default_to_the_release_flag() {
        let default: BuildOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(default.flags(), vec!["-O2".to_string()]);
        assert!(!default.precompile_headers);
        let debug: BuildOptions = serde_json::from_str(r#"{"compileFlags":["-O0"," -g ",""],"precompileHeaders":true}"#).unwrap();
        assert_eq!(debug.flags(), vec!["-O0".to_string(), "-g".to_string()]);
        assert!(debug.precompile_headers);
    }

    #[test]
    fn a_profile_compiles_with_its_flags_and_the_precompiled_header() {
        // `g++` on macOS is Clang, which has no bits/stdc++.h to compile at all.
        let Some(compiler) = find_tool("g++") else { return };
        if !pch::is_gcc(&compiler) { return; }
        let code = "#include <bits/stdc++.h>\nint main() {\n#ifdef LOCAL\n  std::cout << \"local\";\n#else\n  std::cout << \"judge\";\n#endif\n}\n";
        for (flags, expected) in [(vec!["-O2".to_string()], "judge"), (vec!["-O0".to_string(), "-DLOCAL".to_string()], "local")] {
            let build = BuildOptions { compile_flags: Some(flags), precompile_headers: true };
            // Twice: the first build writes the header, the second one compiles against it.
            for _ in 0..2 {
                let directory = tempfile::tempdir().expect("temporary directory");
                let PreparedProgram::Ready { command, args, .. } = prepare_program("cpp", code, None, directory.path(), false, &build).expect("toolchain") else {
                    panic!("the program should compile");
                };
                let result = execute(&command, &args, directory.path(), "", Duration::from_secs(10));
                assert_eq!(result.stdout, expected);
            }
        }
    }
}
