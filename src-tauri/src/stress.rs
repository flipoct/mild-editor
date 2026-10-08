//! Finding a counterexample.
//!
//! Nothing here comes from the judge. The generator prints a small random input and the
//! reference is a slow solution that is obviously right; running both against the real
//! solution on random inputs until their answers part is what turns "it is wrong somewhere"
//! into a concrete failing case.

use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::{fs, time::Duration};
use tauri::Emitter;

use crate::checker;
use crate::runner::{execute_with_cancel, prepare_program, BuildOptions, PreparedProgram, RunResult, RunState, Verdict, MAX_CODE};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StressProgram {
    pub(crate) language: String,
    pub(crate) code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StressRequest {
    run_id: String,
    generator: StressProgram,
    reference: StressProgram,
    solution: StressProgram,
    /// How many random inputs to try before giving up.
    rounds: u32,
    #[serde(default)]
    time_limit_ms: Option<u64>,
    #[serde(default)]
    atcoder_library_path: Option<String>,
    /// 0 or less compares outputs exactly; otherwise decimals may differ by this much.
    #[serde(default)]
    float_tolerance: f64,
    /// The problem's special judge, which then decides instead of comparing the two outputs:
    /// the reference's answer is the one it is handed as the expected answer.
    #[serde(default)]
    checker: Option<StressProgram>,
    #[serde(flatten)]
    build: BuildOptions,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StressProgress {
    run_id: String,
    round: u32,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum StressOutcome {
    /// The two solutions disagreed: `input` is the case that separated them.
    Mismatch { rounds: u32, input: String, expected: String, actual: String, reason: String },
    /// Every round agreed.
    Passed { rounds: u32 },
    /// One of the three programs did not build.
    CompileError { program: String, message: String },
    /// A program failed at run time, which is a finding of its own.
    Crashed { rounds: u32, program: String, input: String, message: String },
    Stopped { rounds: u32 },
}

/// Mirrors `outputsMatch` in src/judge.ts: lines are compared exactly, and with a tolerance
/// a differing line gets a second chance token by token, where two decimals pass if they
/// are within the tolerance absolutely or relatively. Integers never take that path.
fn outputs_match(expected: &str, actual: &str, tolerance: f64) -> bool {
    let normalise = |value: &str| value.replace("\r\n", "\n").trim_end().to_string();
    let (expected, actual) = (normalise(expected), normalise(actual));
    if expected == actual { return true; }
    if !(tolerance > 0.0) { return false; }
    let left: Vec<&str> = expected.split('\n').collect();
    let right: Vec<&str> = actual.split('\n').collect();
    if left.len() != right.len() { return false; }
    left.iter().zip(right.iter()).all(|(want, got)| {
        if want == got { return true; }
        let want_tokens: Vec<&str> = want.split_whitespace().collect();
        let got_tokens: Vec<&str> = got.split_whitespace().collect();
        if want_tokens.len() != got_tokens.len() { return false; }
        want_tokens.iter().zip(got_tokens.iter()).all(|(want, got)| {
            if want == got { return true; }
            // The expected output decides whether the answer is a real number at all.
            if !want.contains(['.', 'e', 'E']) { return false; }
            let (Ok(want), Ok(got)) = (want.parse::<f64>(), got.parse::<f64>()) else { return false };
            if !want.is_finite() || !got.is_finite() { return false; }
            let error = (want - got).abs();
            error <= tolerance || error <= tolerance * want.abs()
        })
    })
}

fn stress_sync(request: StressRequest, app: tauri::AppHandle, cancelled: Arc<AtomicBool>) -> Result<StressOutcome, String> {
    let run_id = request.run_id.clone();
    stress_search(&request, &cancelled, &move |round| {
        let _ = app.emit("stress-progress", StressProgress { run_id: run_id.clone(), round });
    })
}

fn stress_search(request: &StressRequest, cancelled: &AtomicBool, progress: &dyn Fn(u32)) -> Result<StressOutcome, String> {
    for program in [&request.generator, &request.reference, &request.solution] {
        if !matches!(program.language.as_str(), "cpp" | "python") { return Err("Unsupported language.".into()); }
        if program.code.len() > MAX_CODE { return Err("The source code is too large.".into()); }
    }
    let directory = tempfile::Builder::new().prefix("mild-stress-").tempdir().map_err(|error| error.to_string())?;

    // Each program is built in a directory of its own: prepare_program writes its source as
    // main.cpp, so sharing one would have them overwrite each other.
    let mut built = Vec::new();
    for (name, program) in [("generator", &request.generator), ("reference", &request.reference), ("solution", &request.solution)] {
        let cwd = directory.path().join(name);
        fs::create_dir_all(&cwd).map_err(|error| error.to_string())?;
        match prepare_program(&program.language, &program.code, request.atcoder_library_path.as_deref(), &cwd, false, &request.build)? {
            PreparedProgram::Ready { command, args, .. } => built.push((command, args, cwd)),
            PreparedProgram::CompileError(result) => {
                return Ok(StressOutcome::CompileError { program: name.into(), message: result.stderr });
            }
        }
    }
    let [generator, reference, solution] = <[_; 3]>::try_from(built).ok().ok_or("Could not prepare the programs.")?;
    let checker = match &request.checker {
        Some(program) => match checker::prepare(program, request.atcoder_library_path.as_deref(), &directory.path().join("checker"), &request.build)? {
            Ok(checker) => Some(checker),
            Err(message) => return Ok(StressOutcome::CompileError { program: "checker".into(), message }),
        },
        None => None,
    };

    let time_limit = Duration::from_millis(request.time_limit_ms.unwrap_or(2000).clamp(100, 60_000));
    let rounds = request.rounds.clamp(1, 100_000);
    let mut done = 0;
    for round in 1..=rounds {
        if cancelled.load(Ordering::Relaxed) { return Ok(StressOutcome::Stopped { rounds: done }); }
        done = round;
        // Reported every so often rather than every round: the rounds are short, and an
        // event each would flood the webview with more work than the run itself.
        if round % 10 == 1 || round == rounds { progress(round); }

        let made = execute_with_cancel(&generator.0, &generator.1, &generator.2, "", time_limit, Some(cancelled), None);
        if cancelled.load(Ordering::Relaxed) { return Ok(StressOutcome::Stopped { rounds: done }); }
        if !made.ok {
            return Ok(StressOutcome::Crashed { rounds: done, program: "generator".into(), input: String::new(), message: crash_message(&made) });
        }
        let input = made.stdout;

        let expected = execute_with_cancel(&reference.0, &reference.1, &reference.2, &input, time_limit, Some(cancelled), None);
        if cancelled.load(Ordering::Relaxed) { return Ok(StressOutcome::Stopped { rounds: done }); }
        if !expected.ok {
            return Ok(StressOutcome::Crashed { rounds: done, program: "reference".into(), input, message: crash_message(&expected) });
        }
        let actual = execute_with_cancel(&solution.0, &solution.1, &solution.2, &input, time_limit, Some(cancelled), None);
        if cancelled.load(Ordering::Relaxed) { return Ok(StressOutcome::Stopped { rounds: done }); }
        if !actual.ok {
            // The solution falling over on this input is exactly what the search is for.
            return Ok(StressOutcome::Crashed { rounds: done, program: "solution".into(), input, message: crash_message(&actual) });
        }
        let reason = match &checker {
            Some(checker) => {
                let verdict = checker.check(&input, &actual.stdout, &expected.stdout, Some(cancelled));
                if cancelled.load(Ordering::Relaxed) { return Ok(StressOutcome::Stopped { rounds: done }); }
                if verdict.failed {
                    return Ok(StressOutcome::Crashed { rounds: done, program: "checker".into(), input, message: verdict.message });
                }
                (!verdict.accepted).then_some(verdict.message)
            }
            None => (!outputs_match(&expected.stdout, &actual.stdout, request.float_tolerance)).then(String::new),
        };
        if let Some(reason) = reason {
            return Ok(StressOutcome::Mismatch {
                rounds: done,
                input,
                expected: expected.stdout,
                actual: actual.stdout,
                reason,
            });
        }
    }
    Ok(StressOutcome::Passed { rounds: done })
}

fn crash_message(result: &RunResult) -> String {
    let detail = result.stderr.trim();
    let verdict = match result.verdict {
        Verdict::Tle => "timed out",
        Verdict::Mle => "ran out of memory",
        Verdict::Limit => "wrote too much output",
        _ => "failed",
    };
    if detail.is_empty() { verdict.to_string() } else { format!("{verdict}: {detail}") }
}

/// Shares `RunState` with the test runner, so the stop button stops whichever is going.
#[tauri::command]
pub(crate) async fn stress_test(app: tauri::AppHandle, state: tauri::State<'_, RunState>, request: StressRequest) -> Result<StressOutcome, String> {
    state.0.store(false, Ordering::Relaxed);
    let cancelled = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || stress_sync(request, app, cancelled))
        .await
        .map_err(|error| error.to_string())?
}

/// Accepts any ordering of the expected numbers, the usual "print any valid answer".
#[cfg(test)]
pub(crate) const ANY_ORDER_CHECKER: &str = "import sys\n\
    inp, out, ans = (open(path).read().split() for path in sys.argv[1:4])\n\
    if sorted(out) != sorted(ans):\n    print('wrong set')\n    sys.exit(1)\n";

#[cfg(test)]
pub(crate) fn python_program(code: &str) -> StressProgram {
    StressProgram { language: "python".into(), code: code.into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::find_tool;

    #[test]
    fn the_counterexample_search_finds_a_case_that_separates_two_solutions() {
        if find_tool("python3").is_none() && find_tool("python").is_none() { return; }
        let program = |code: &str| StressProgram { language: "python".into(), code: code.into() };
        // A maximum-subarray problem whose "solution" never allows an all-negative answer,
        // which only a generator that can produce one will expose.
        let request = StressRequest {
            run_id: "test".into(),
            generator: program("import random\nn = random.randint(1, 4)\nprint(n)\nprint(*[random.randint(-5, -1) for _ in range(n)])\n"),
            reference: program("n = int(input()); a = list(map(int, input().split()))\nprint(max(sum(a[i:j+1]) for i in range(n) for j in range(i, n)))\n"),
            solution: program("n = int(input()); a = list(map(int, input().split()))\nbest = cur = 0\nfor x in a:\n    cur = max(0, cur + x)\n    best = max(best, cur)\nprint(best)\n"),
            rounds: 30,
            time_limit_ms: Some(10_000),
            atcoder_library_path: None,
            float_tolerance: 0.0,
            checker: None,
            build: BuildOptions::default(),
        };
        let seen = std::sync::Mutex::new(Vec::new());
        let outcome = stress_search(&request, &AtomicBool::new(false), &|round| seen.lock().expect("rounds").push(round))
            .expect("the search runs");
        match outcome {
            StressOutcome::Mismatch { input, expected, actual, .. } => {
                assert!(!input.trim().is_empty());
                assert_ne!(expected.trim(), actual.trim());
                // The reference is right: an all-negative array answers with its largest element.
                assert_eq!(actual.trim(), "0");
            }
            other => panic!("expected a counterexample, got {}", serde_json::to_string(&other).expect("outcome")),
        }
        assert_eq!(seen.lock().expect("rounds").first(), Some(&1));

        // Two solutions that agree are reported as such rather than as a finding.
        let agreeing = StressRequest {
            run_id: "test".into(),
            solution: program("n = int(input()); a = list(map(int, input().split()))\nprint(max(sum(a[i:j+1]) for i in range(n) for j in range(i, n)))\n"),
            rounds: 5,
            ..request
        };
        assert!(matches!(stress_search(&agreeing, &AtomicBool::new(false), &|_| {}), Ok(StressOutcome::Passed { rounds: 5 })));

        // Cancelling stops it where it is.
        assert!(matches!(stress_search(&agreeing, &AtomicBool::new(true), &|_| {}), Ok(StressOutcome::Stopped { .. })));

        // And the stop button works mid-search, which is the case that matters: the flag is
        // set from another thread while the rounds are already running.
        let long = StressRequest { rounds: 400, ..agreeing };
        let flag = Arc::new(AtomicBool::new(false));
        let raised = flag.clone();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            raised.store(true, Ordering::Relaxed);
        });
        let started = std::time::Instant::now();
        let outcome = stress_search(&long, &flag, &|_| {}).expect("the search runs");
        stopper.join().expect("stopper");
        match outcome {
            StressOutcome::Stopped { rounds } => assert!(rounds < 400, "stopped after {rounds} of 400"),
            other => panic!("expected a stop, got {}", serde_json::to_string(&other).expect("outcome")),
        }
        assert!(started.elapsed() < Duration::from_secs(20), "the stop was not acted on promptly");
    }

    #[test]
    fn the_counterexample_search_asks_the_checker_when_there_is_one() {
        if find_tool("python3").is_none() && find_tool("python").is_none() { return; }
        let request = StressRequest {
            run_id: "test".into(),
            generator: python_program("import random\nprint(*random.sample(range(1, 9), 3))\n"),
            reference: python_program("print(*sorted(map(int, input().split())))\n"),
            // Right in any order, so plain comparison calls it wrong and the checker does not.
            solution: python_program("print(*sorted(map(int, input().split()), reverse=True))\n"),
            rounds: 8,
            time_limit_ms: Some(10_000),
            atcoder_library_path: None,
            float_tolerance: 0.0,
            checker: None,
            build: BuildOptions::default(),
        };
        assert!(matches!(stress_search(&request, &AtomicBool::new(false), &|_| {}), Ok(StressOutcome::Mismatch { .. })));
        let judged = StressRequest { checker: Some(python_program(ANY_ORDER_CHECKER)), ..request };
        assert!(matches!(stress_search(&judged, &AtomicBool::new(false), &|_| {}), Ok(StressOutcome::Passed { rounds: 8 })));

        // A solution that really is wrong is caught, with the checker's reason attached.
        let wrong = StressRequest { solution: python_program("print(*[1] * 3)\n"), ..judged };
        match stress_search(&wrong, &AtomicBool::new(false), &|_| {}) {
            Ok(StressOutcome::Mismatch { reason, .. }) => assert_eq!(reason, "wrong set"),
            Ok(other) => panic!("expected a mismatch, got {}", serde_json::to_string(&other).expect("outcome")),
            Err(error) => panic!("{error}"),
        }
    }

    #[test]
    fn stress_output_comparison_matches_the_editors_own_rule() {
        // Exactly the cases src/judge.ts is written around, so the counterexample search
        // accepts and rejects what the test panel would.
        assert!(outputs_match("1 2\n3\n", "1 2\r\n3", 0.0));
        assert!(outputs_match("YES", "YES\n\n", 0.0));
        assert!(!outputs_match("1 2", "1  2", 0.0));
        assert!(!outputs_match("7", "9", 1e-6));
        // A decimal may drift; an integer may not, however small the difference looks.
        assert!(outputs_match("0.5000000", "0.4999999", 1e-6));
        assert!(!outputs_match("0.5", "0.6", 1e-6));
        assert!(outputs_match("1e9", "1000000000.0000001", 1e-6));
        assert!(!outputs_match("5", "5.0000001", 1e-6));
        // Tolerance never rescues a different shape.
        assert!(!outputs_match("1.0\n2.0", "1.0", 1e-6));
        assert!(!outputs_match("abc", "abd", 1e-6));
    }
}
