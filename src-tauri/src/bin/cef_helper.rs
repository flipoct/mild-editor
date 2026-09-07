//! CEF sub-process entry point for macOS.
//!
//! Chromium runs its renderer, GPU, network and utility work in separate processes. On
//! macOS those must be launched from helper `.app` bundles that sit next to the
//! `Chromium Embedded Framework.framework`, so this binary is bundled five times under
//! the names CEF expects (`Helper`, `Helper (GPU)`, `Helper (Renderer)`, `Helper (Plugin)`,
//! `Helper (Alerts)`). It loads the framework and hands control to CEF; it never runs
//! any editor code.

fn main() {
    let args = cef::args::Args::new();

    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().expect("helper executable path");
        // <dir>/X Helper.app/Contents/MacOS/X Helper -> <dir>, where the framework lives.
        let framework = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|dir| dir.join("Chromium Embedded Framework.framework/Chromium Embedded Framework"))
            .expect("helper bundle layout");
        let path = std::ffi::CString::new(framework.to_string_lossy().as_bytes()).expect("framework path");
        assert_eq!(cef::load_library(Some(unsafe { &*path.as_ptr() })), 1, "could not load {}", framework.display());
    }

    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let code = cef::execute_process(Some(args.as_main_args()), None::<&mut cef::App>, std::ptr::null_mut());
    std::process::exit(code);
}
