//! What a program under test runs inside, so its limits hold the way a judge's do.
//!
//! On Windows that is a Job Object, the mechanism judges on Windows use:
//! - memory is a hard cap on committed memory, so a program that allocates fast cannot take
//!   the machine's RAM before a sample notices, and the job says when the cap was hit, which
//!   tells an MLE apart from a crash even though the failed allocation never counted;
//! - time is CPU time, so the seconds Windows Defender spends scanning a freshly built exe
//!   before it starts, or a busy machine, do not turn into a TLE;
//! - killing the job kills everything the program started, and closing it does the same, so
//!   no grandchild outlives a stopped run (or a compile cut off by its timeout);
//! - an unhandled exception ends the process instead of opening Windows' crash dialog.
//!
//! On Linux and macOS the program leads a process group of its own, so a kill reaches what it
//! started, and its stack limit is raised to what judges give (see `STACK_BYTES`). Time stays
//! wall-clock there and memory is sampled (see `memory.rs`).

use std::process::{Child, Command};
use std::time::Duration;

/// The stack judges give a solution (Codeforces and AtCoder: 256 MB). The default is 1 MB
/// for a Windows executable and 8 MB on Linux, which deep recursion accepted there overruns.
pub(crate) const STACK_BYTES: u64 = 256 * 1024 * 1024;

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectAssociateCompletionPortInformation, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED};

    /// What the job posts to its completion port when a process in it hits the memory cap.
    const JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT: u32 = 9;
    const JOB_OBJECT_MSG_JOB_MEMORY_LIMIT: u32 = 10;

    pub(crate) struct Sandbox {
        job: HANDLE,
        port: HANDLE,
        memory_limit_hit: std::cell::Cell<bool>,
        caps_memory: bool,
    }

    // SAFETY: both handles are owned by this value and closed only in Drop; the kernel objects
    // they name may be used from any thread.
    unsafe impl Send for Sandbox {}

    impl Sandbox {
        /// `None` when the job cannot be made; the run then goes ahead without it, as before.
        pub(crate) fn new(memory_limit_kb: Option<u64>) -> Option<Self> {
            // SAFETY: plain Win32 calls with valid arguments; every handle made here is owned
            // by the returned value (or closed on the way out).
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() { return None; }
                let port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1);
                let sandbox = Sandbox { job, port, memory_limit_hit: std::cell::Cell::new(false), caps_memory: memory_limit_kb.is_some() && !port.is_null() };
                if !port.is_null() {
                    let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey: job, CompletionPort: port };
                    SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &association as *const _ as _, std::mem::size_of_val(&association) as u32);
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
                if let Some(limit) = memory_limit_kb {
                    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                    limits.ProcessMemoryLimit = (limit as usize).saturating_mul(1024);
                }
                if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32) == 0 {
                    return None;
                }
                Some(sandbox)
            }
        }

        /// Puts a freshly spawned child in the job. Anything it starts afterwards joins too.
        pub(crate) fn attach(&self, child: &Child) -> bool {
            // SAFETY: the handle belongs to `child`, which is alive.
            unsafe { AssignProcessToJobObject(self.job, child.as_raw_handle() as HANDLE) != 0 }
        }

        /// Ends every process in the job.
        pub(crate) fn kill(&self) {
            // SAFETY: `job` is a valid job handle owned by self.
            unsafe { TerminateJobObject(self.job, 1); }
        }

        /// User plus kernel time of every process that ran in the job.
        pub(crate) fn cpu_time(&self) -> Option<Duration> {
            // SAFETY: the buffer is a correctly sized, writable accounting structure.
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                let ok = QueryInformationJobObject(self.job, JobObjectBasicAccountingInformation, &mut info as *mut _ as _, std::mem::size_of_val(&info) as u32, std::ptr::null_mut());
                (ok != 0).then(|| Duration::from_nanos(((info.TotalUserTime + info.TotalKernelTime).max(0) as u64) * 100))
            }
        }

        /// The most committed memory any one process in the job had, in KiB.
        pub(crate) fn peak_memory_kb(&self) -> Option<u64> {
            // SAFETY: as in `cpu_time`.
            unsafe {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                let ok = QueryInformationJobObject(self.job, JobObjectExtendedLimitInformation, &mut info as *mut _ as _, std::mem::size_of_val(&info) as u32, std::ptr::null_mut());
                (ok != 0).then(|| info.PeakProcessMemoryUsed as u64 / 1024)
            }
        }

        /// Whether the job holds the memory limit itself and reports a breach, so the runner
        /// asks it instead of sampling. Without a completion port a breach would go unseen.
        pub(crate) fn caps_memory(&self) -> bool { self.caps_memory }

        /// Whether a process asked for more than the cap at any point so far.
        pub(crate) fn memory_limit_hit(&self) -> bool {
            if self.port.is_null() { return false; }
            // Drain what the job has posted, without waiting.
            loop {
                let mut message = 0u32;
                let mut key = 0usize;
                let mut overlapped: *mut OVERLAPPED = std::ptr::null_mut();
                // SAFETY: valid out-pointers; a zero timeout returns at once when nothing is queued.
                let got = unsafe { GetQueuedCompletionStatus(self.port, &mut message, &mut key, &mut overlapped, 0) };
                if got == 0 { break; }
                if message == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT || message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT {
                    self.memory_limit_hit.set(true);
                }
            }
            self.memory_limit_hit.get()
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            // SAFETY: both handles are owned here. Closing the job kills what is left in it.
            unsafe {
                CloseHandle(self.job);
                if !self.port.is_null() { CloseHandle(self.port); }
            }
        }
    }

    pub(crate) fn configure(_command: &mut Command) {}
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::process::CommandExt;

    pub(crate) struct Sandbox {
        group: std::cell::Cell<Option<i32>>,
    }

    impl Sandbox {
        pub(crate) fn new(_memory_limit_kb: Option<u64>) -> Option<Self> {
            Some(Sandbox { group: std::cell::Cell::new(None) })
        }

        /// The child leads its own process group (see `configure`), named by its pid.
        pub(crate) fn attach(&self, child: &Child) -> bool {
            self.group.set(Some(child.id() as i32));
            true
        }

        pub(crate) fn kill(&self) {
            if let Some(group) = self.group.get() {
                // SAFETY: signalling a process group we created; ESRCH once it is gone is fine.
                unsafe { libc::kill(-group, libc::SIGKILL); }
            }
        }

        pub(crate) fn cpu_time(&self) -> Option<Duration> { None }
        pub(crate) fn peak_memory_kb(&self) -> Option<u64> { None }
        /// Memory is not capped here; the runner samples it (see `memory.rs`).
        pub(crate) fn caps_memory(&self) -> bool { false }
        pub(crate) fn memory_limit_hit(&self) -> bool { false }
    }

    impl Drop for Sandbox {
        /// Whatever the program left running in the background goes with it.
        fn drop(&mut self) { self.kill(); }
    }

    /// A process group of its own, and the judges' stack.
    pub(crate) fn configure(command: &mut Command) {
        command.process_group(0);
        // SAFETY: getrlimit and setrlimit are async-signal-safe, which is all a pre_exec hook
        // may call; nothing is allocated.
        unsafe {
            command.pre_exec(|| {
                let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
                if libc::getrlimit(libc::RLIMIT_STACK, &mut limit) == 0 {
                    let wanted = STACK_BYTES as libc::rlim_t;
                    let ceiling = if limit.rlim_max == libc::RLIM_INFINITY { wanted } else { limit.rlim_max.min(wanted) };
                    if limit.rlim_cur != libc::RLIM_INFINITY && limit.rlim_cur < ceiling {
                        limit.rlim_cur = ceiling;
                        libc::setrlimit(libc::RLIMIT_STACK, &limit);
                    }
                }
                Ok(())
            });
        }
    }
}

#[cfg(not(any(windows, unix)))]
mod platform {
    use super::*;
    pub(crate) struct Sandbox;
    impl Sandbox {
        pub(crate) fn new(_memory_limit_kb: Option<u64>) -> Option<Self> { None }
        pub(crate) fn attach(&self, _child: &Child) -> bool { false }
        pub(crate) fn kill(&self) {}
        pub(crate) fn cpu_time(&self) -> Option<Duration> { None }
        pub(crate) fn peak_memory_kb(&self) -> Option<u64> { None }
        pub(crate) fn caps_memory(&self) -> bool { false }
        pub(crate) fn memory_limit_hit(&self) -> bool { false }
    }
    pub(crate) fn configure(_command: &mut Command) {}
}

pub(crate) use platform::{configure, Sandbox};
