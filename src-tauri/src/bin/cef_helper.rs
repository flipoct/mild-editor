//! CEF sub-process entry point for macOS.
//!
//! Chromium runs its renderer, GPU, network and utility work in separate processes. On
//! macOS those must be launched from helper `.app` bundles, so this binary is bundled five
//! times under the names CEF expects (`Helper`, `Helper (GPU)`, `Helper (Renderer)`,
//! `Helper (Plugin)`, `Helper (Alerts)`). It loads the framework and hands control to CEF;
//! it never runs any editor code.
//!
//! `cef` is a macOS-only dependency and Cargo cannot declare a binary target for one
//! platform, so on every other platform this is an empty placeholder: `tauri build` builds
//! every declared binary, and a body referring to `cef` would fail to compile there.

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    let args = cef::args::Args::new();

    {
        const FRAMEWORK: &str = "Chromium Embedded Framework.framework/Chromium Embedded Framework";
        let exe = std::env::current_exe().expect("helper executable path");
        // <dir>/X Helper.app/Contents/MacOS/X Helper -> <dir>
        let dir = exe.ancestors().nth(4).expect("helper bundle layout").to_path_buf();
        // `tauri dev` keeps the framework next to the helpers; the app bundle keeps the
        // helpers under Contents/Resources/cef/helpers and the framework under
        // Contents/Frameworks.
        let candidates = [dir.join(FRAMEWORK), dir.join("../../../Frameworks").join(FRAMEWORK)];
        let framework = candidates
            .iter()
            .find(|path| path.is_file())
            .unwrap_or_else(|| panic!("CEF framework not found near {}", dir.display()));
        let path = std::ffi::CString::new(framework.to_string_lossy().as_bytes()).expect("framework path");
        assert_eq!(cef::load_library(Some(unsafe { &*path.as_ptr() })), 1, "could not load {}", framework.display());
    }

    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let code = cef::execute_process(Some(args.as_main_args()), None::<&mut cef::App>, std::ptr::null_mut());
    std::process::exit(code);
}
