//! A special judge for problems with more than one right answer.
//!
//! "Print any valid order" or "any shortest path" cannot be judged by comparing streams, so a
//! problem may carry a checker: a program of its own, in C++ or Python, called the way testlib
//! calls one — `checker <input> <output> <answer>`, three file paths — that exits 0 to accept
//! the output and anything else to reject it. Whatever it prints comes back with the verdict.
//! Exit code 3 is testlib's `_fail`: the checker itself could not decide, which is reported as
//! a fault of the checker rather than of the solution.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde::Serialize;

use crate::{execute_with_cancel, prepare_program, BuildOptions, PreparedProgram, StressProgram, Verdict};

/// A checker is not the program under test, so it is not held to the problem's time limit,
/// only to one that stops a checker stuck in a loop.
const CHECKER_TIME_LIMIT: Duration = Duration::from_secs(10);
/// testlib's `_fail`: the checker found something wrong with itself or the test.
const CHECKER_FAILED: i32 = 3;
/// What the checker says is shown beside the verdict, so a page of it is plenty.
const MAX_MESSAGE: usize = 2000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckerVerdict {
    pub accepted: bool,
    /// The checker crashed, timed out or exited with testlib's "fail" code: the solution's
    /// output was never really judged.
    pub failed: bool,
    pub message: String,
}

pub(crate) struct Checker {
    command: PathBuf,
    args: Vec<String>,
    directory: PathBuf,
}

/// Builds the checker in `directory`, which must be its own: the solution and the checker are
/// both written there as `main.cpp` or `main.py`. `Ok(Err(message))` is a checker that does
/// not compile.
pub(crate) fn prepare(
    program: &StressProgram,
    atcoder_library_path: Option<&str>,
    directory: &Path,
    build: &BuildOptions,
) -> Result<Result<Checker, String>, String> {
    if !matches!(program.language.as_str(), "cpp" | "python") {
        return Err("Unsupported checker language.".into());
    }
    if program.code.len() > crate::MAX_CODE {
        return Err("The checker's source code is too large.".into());
    }
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    // The checker is built with the release flags whatever profile the solution uses: a
    // sanitizer firing inside the checker would read as a wrong answer.
    let release = BuildOptions { compile_flags: None, precompile_headers: build.precompile_headers };
    Ok(match prepare_program(&program.language, &program.code, atcoder_library_path, directory, false, &release)? {
        PreparedProgram::Ready { command, args, .. } => {
            // Python only finds a syntax error when it runs, and a checker that exits 1 on one
            // would read as a wrong answer on every test. Compiling it first says what it is.
            if program.language == "python" {
                let source = directory.join("main.py").to_string_lossy().into_owned();
                let compiled = crate::execute(&command, &["-m".into(), "py_compile".into(), source], directory, "", Duration::from_secs(10));
                if !compiled.ok {
                    return Ok(Err([compiled.stdout.trim(), compiled.stderr.trim()].join("\n").trim().to_string()));
                }
            }
            Ok(Checker { command, args, directory: directory.to_path_buf() })
        }
        PreparedProgram::CompileError(result) => Err(result.stderr.trim_start_matches("Compile error").trim().to_string()),
    })
}

impl Checker {
    pub(crate) fn check(&self, input: &str, output: &str, answer: &str, cancelled: Option<&AtomicBool>) -> CheckerVerdict {
        let files = [("input.txt", input), ("output.txt", output), ("answer.txt", answer)];
        let mut args = self.args.clone();
        for (name, contents) in files {
            let path = self.directory.join(name);
            if let Err(error) = fs::write(&path, contents) {
                return CheckerVerdict { accepted: false, failed: true, message: format!("could not write {name}: {error}") };
            }
            args.push(path.to_string_lossy().into_owned());
        }
        let result = execute_with_cancel(&self.command, &args, &self.directory, "", CHECKER_TIME_LIMIT, cancelled, None);
        let said = [result.stdout.trim(), result.stderr.trim()].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join("\n");
        let message = truncate(&said);
        let (accepted, failed) = classify(result.verdict, result.code);
        CheckerVerdict { accepted, failed, message }
    }
}

/// `(accepted, failed)` for how the checker ended. Only an ordinary exit code rejects: a
/// signal, a Windows exception status (`0xC0000005` and the like, far outside 1–255),
/// testlib's fail code, a timeout or a stop all mean nothing was judged.
fn classify(verdict: Verdict, code: Option<i32>) -> (bool, bool) {
    match (verdict, code) {
        (Verdict::Ok, _) => (true, false),
        (Verdict::Re, Some(code)) if (1..=255).contains(&code) && code != CHECKER_FAILED => (false, false),
        _ => (false, true),
    }
}

fn truncate(text: &str) -> String {
    if text.len() <= MAX_MESSAGE { return text.to_string(); }
    let mut end = MAX_MESSAGE;
    while !text.is_char_boundary(end) { end -= 1; }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn python_available() -> bool {
        crate::find_tool("python3").is_some() || crate::find_tool("python").is_some()
    }

    fn python(code: &str) -> StressProgram {
        StressProgram { language: "python".into(), code: code.into() }
    }

    /// Accepts any permutation of the expected tokens, the shape of a typical "print any
    /// order" problem, and says why when it rejects.
    const PERMUTATION: &str = "import sys\n\
        inp, out, ans = (open(path).read().split() for path in sys.argv[1:4])\n\
        if sorted(out) != sorted(ans):\n    print('not a permutation of', ' '.join(ans))\n    sys.exit(1)\n\
        print('ok')\n";

    #[test]
    fn a_checker_accepts_any_right_answer_and_explains_a_wrong_one() {
        if !python_available() { return; }
        let directory = tempfile::tempdir().expect("temp dir");
        let checker = prepare(&python(PERMUTATION), None, &directory.path().join("checker"), &BuildOptions::default())
            .expect("prepared")
            .expect("compiles");
        let accepted = checker.check("3\n", "3 1 2\n", "1 2 3\n", None);
        assert_eq!(accepted, CheckerVerdict { accepted: true, failed: false, message: "ok".into() });
        let rejected = checker.check("3\n", "1 1 2\n", "1 2 3\n", None);
        assert!(!rejected.accepted && !rejected.failed, "{rejected:?}");
        assert_eq!(rejected.message, "not a permutation of 1 2 3");
    }

    #[test]
    fn a_checker_that_fails_is_not_a_wrong_answer() {
        if !python_available() { return; }
        let directory = tempfile::tempdir().expect("temp dir");
        let prepare_in = |name: &str, code: &str| prepare(&python(code), None, &directory.path().join(name), &BuildOptions::default())
            .expect("prepared")
            .expect("compiles");
        // testlib's `_fail` code.
        let quitting = prepare_in("fail", "import sys\nprint('answer file is broken')\nsys.exit(3)\n");
        let verdict = quitting.check("", "", "", None);
        assert!(verdict.failed && !verdict.accepted);
        assert_eq!(verdict.message, "answer file is broken");

        // A checker that is stopped mid-way never judged anything either.
        let stopped = AtomicBool::new(true);
        let looping = prepare_in("loop", "while True:\n    pass\n");
        assert!(looping.check("", "", "", Some(&stopped)).failed);
    }

    #[test]
    fn a_python_checker_with_a_syntax_error_does_not_compile() {
        if !python_available() { return; }
        let directory = tempfile::tempdir().expect("temp dir");
        let outcome = prepare(&python("def (:\n"), None, &directory.path().join("checker"), &BuildOptions::default()).expect("prepared");
        let message = outcome.err().expect("a compile error");
        assert!(message.contains("SyntaxError"), "{message}");
    }

    #[test]
    fn a_checker_that_does_not_compile_says_so() {
        if crate::find_tool("g++").is_none() { return; }
        let directory = tempfile::tempdir().expect("temp dir");
        let broken = StressProgram { language: "cpp".into(), code: "int main( { return 0; }\n".into() };
        let outcome = prepare(&broken, None, &directory.path().join("checker"), &BuildOptions::default()).expect("prepared");
        let message = outcome.err().expect("a compile error");
        assert!(!message.is_empty() && !message.starts_with("Compile error"), "{message}");
    }

    #[test]
    fn only_an_ordinary_exit_code_rejects() {
        assert_eq!(classify(Verdict::Ok, Some(0)), (true, false));
        assert_eq!(classify(Verdict::Re, Some(1)), (false, false));
        assert_eq!(classify(Verdict::Re, Some(2)), (false, false));
        assert_eq!(classify(Verdict::Re, Some(CHECKER_FAILED)), (false, true));
        // An access violation on Windows, and a signal on Unix.
        assert_eq!(classify(Verdict::Re, Some(0xC000_0005_u32 as i32)), (false, true));
        assert_eq!(classify(Verdict::Re, None), (false, true));
        assert_eq!(classify(Verdict::Tle, None), (false, true));
        assert_eq!(classify(Verdict::Stopped, None), (false, true));
    }

    #[test]
    fn long_messages_are_cut_on_a_character_boundary() {
        let long = "가".repeat(MAX_MESSAGE);
        let cut = truncate(&long);
        assert!(cut.ends_with('…'));
        assert!(cut.len() <= MAX_MESSAGE + '…'.len_utf8());
    }
}
