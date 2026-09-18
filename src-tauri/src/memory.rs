//! Peak memory of a program under test, for the memory column and the `MLE` verdict.
//!
//! The runner samples this while it waits on the child and once more after the child has
//! exited. Windows keeps the counters readable through the process handle after exit, so the
//! last sample is exact there; Linux and macOS drop them with the process, so the peak is
//! the highest sample taken while it was alive and a run shorter than one poll has none.

use std::process::Child;

/// Peak resident memory of `child` in KiB, or `None` when the platform cannot tell.
#[cfg(windows)]
pub(crate) fn peak_memory_kb(child: &Child) -> Option<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};

    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: the handle belongs to `child`, which outlives this call, and `counters` is a
    // correctly sized, writable PROCESS_MEMORY_COUNTERS.
    let ok = unsafe { GetProcessMemoryInfo(child.as_raw_handle() as _, &mut counters, counters.cb) };
    (ok != 0).then(|| counters.PeakWorkingSetSize as u64 / 1024)
}

/// `VmHWM` is the kernel's own high-water mark of the resident set.
#[cfg(target_os = "linux")]
pub(crate) fn peak_memory_kb(child: &Child) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{}/status", child.id())).ok()?;
    parse_vm_hwm(&status)
}

#[cfg(any(target_os = "linux", test))]
fn parse_vm_hwm(status: &str) -> Option<u64> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|value| value.parse().ok())
}

#[cfg(target_os = "macos")]
pub(crate) fn peak_memory_kb(child: &Child) -> Option<u64> {
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a writable rusage_info_v2, the flavor passed alongside it.
    let status = unsafe {
        libc::proc_pid_rusage(child.id() as libc::c_int, libc::RUSAGE_INFO_V2, &mut info as *mut _ as *mut libc::rusage_info_t)
    };
    (status == 0).then(|| info.ri_resident_size / 1024)
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(crate) fn peak_memory_kb(_child: &Child) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_hwm_is_read_from_proc_status() {
        let status = "Name:\tmain\nVmPeak:\t  10000 kB\nVmHWM:\t    2048 kB\nVmRSS:\t    1024 kB\n";
        assert_eq!(parse_vm_hwm(status), Some(2048));
        assert_eq!(parse_vm_hwm("Name:\tzombie\n"), None);
    }
}
