//! Host CPU and memory snapshot used by the diagnostics RPC.
use serde::Serialize;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResourcesSnapshot {
    pub sampled_at: u128,
    pub cpu_utilization: Option<f64>,
    pub cpu_count: usize,
    pub available_memory_bytes: u64,
    pub total_memory_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CpuTimes {
    idle: u64,
    total: u64,
    count: usize,
}

#[cfg(any(target_os = "linux", test))]
fn cpu_list(list: &str) -> Option<std::collections::HashSet<usize>> {
    let mut result = std::collections::HashSet::new();
    for item in list.split(',') {
        let (start, end) = item
            .trim()
            .split_once('-')
            .unwrap_or((item.trim(), item.trim()));
        let (start, end) = (start.parse::<usize>().ok()?, end.parse::<usize>().ok()?);
        if end < start || end > 1_000_000 {
            return None;
        }
        result.extend(start..=end);
    }
    (!result.is_empty()).then_some(result)
}

#[cfg(any(target_os = "linux", test))]
fn linux_cpu(stat: &str, allowed: Option<&std::collections::HashSet<usize>>) -> Option<CpuTimes> {
    let mut result = CpuTimes {
        idle: 0,
        total: 0,
        count: 0,
    };
    for line in stat.lines() {
        let mut fields = line.split_whitespace();
        let label = fields.next()?;
        let selected = match allowed {
            Some(ids) => label
                .strip_prefix("cpu")
                .and_then(|n| n.parse::<usize>().ok())
                .is_some_and(|n| ids.contains(&n)),
            None => label == "cpu",
        };
        if !selected {
            continue;
        }
        let values = fields
            .take(8)
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        if values.len() < 4 {
            continue;
        }
        result.idle = result
            .idle
            .saturating_add(values[3])
            .saturating_add(*values.get(4).unwrap_or(&0));
        result.total = values
            .iter()
            .fold(result.total, |sum, n| sum.saturating_add(*n));
        result.count += 1;
        if allowed.is_none() {
            break;
        }
    }
    (result.count > 0).then_some(result)
}

#[cfg(any(target_os = "linux", test))]
fn linux_meminfo(meminfo: &str) -> Option<(u64, u64)> {
    fn kb(input: &str, key: &str) -> Option<u64> {
        input.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name != key {
                return None;
            }
            value
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()?
                .checked_mul(1024)
        })
    }
    let total = kb(meminfo, "MemTotal")?;
    let available = kb(meminfo, "MemAvailable")
        .or_else(|| kb(meminfo, "MemFree"))?
        .min(total);
    Some((available, total))
}

#[cfg(any(target_os = "linux", test))]
fn stat_number(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(' ')?;
        (name == key).then(|| value.trim().parse().ok()).flatten()
    })
}

#[cfg(any(target_os = "linux", test))]
fn memory_limit(
    host: (u64, u64),
    max: Option<u64>,
    current: Option<u64>,
    reclaimable: u64,
) -> (u64, u64) {
    match (max, current) {
        (Some(max), Some(current)) => {
            let total = host.1.min(max);
            (
                host.0
                    .min(max.saturating_sub(current.saturating_sub(reclaimable)))
                    .min(total),
                total,
            )
        }
        _ => host,
    }
}

#[cfg(any(target_os = "linux", test))]
fn utilization(
    before: CpuTimes,
    after: CpuTimes,
    usage: Option<(u64, u64, f64)>,
    capacity: Option<f64>,
) -> (Option<f64>, usize) {
    let total = after.total.checked_sub(before.total);
    let idle = after.idle.checked_sub(before.idle);
    let host = match (total, idle) {
        (Some(total), Some(idle)) if before.count == after.count && total > 0 && idle <= total => {
            Some(1.0 - idle as f64 / total as f64)
        }
        _ => None,
    };
    let count = after.count;
    let Some(capacity) = capacity.filter(|c| c.is_finite() && *c > 0.0) else {
        return (host, count);
    };
    let capacity = capacity.min(count as f64);
    let host_idle = host.map(|h| count as f64 * (1.0 - h));
    let group_idle = usage.and_then(|(a, b, elapsed)| {
        b.checked_sub(a)
            .filter(|_| elapsed > 0.0)
            .map(|delta| capacity - delta as f64 / elapsed)
    });
    let idle = match (host_idle, group_idle) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    (
        idle.map(|i| (1.0 - i / capacity).clamp(0.0, 1.0)),
        (capacity.floor() as usize).max(1),
    )
}

#[cfg(target_os = "linux")]
fn cgroup_dir() -> Option<std::path::PathBuf> {
    let input = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = input.lines().find_map(|line| line.strip_prefix("0::"))?;
    let mut root = std::path::PathBuf::from("/sys/fs/cgroup");
    for part in std::path::Path::new(path).components() {
        match part {
            std::path::Component::RootDir | std::path::Component::CurDir => {}
            std::path::Component::Normal(p) => root.push(p),
            _ => return None,
        }
    }
    Some(root)
}

#[cfg(any(target_os = "macos", test))]
fn darwin_available_memory(output: &str) -> Option<u64> {
    let page_size = output
        .lines()
        .next()?
        .split("page size of ")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    if page_size == 0 {
        return None;
    }
    let pages = |key: &str| {
        output.lines().find_map(|line| {
            line.strip_prefix(key)?
                .trim()
                .trim_end_matches('.')
                .parse::<u64>()
                .ok()
        })
    };
    pages("Pages free:")?
        .checked_add(pages("Pages inactive:")?)?
        .checked_add(pages("Pages speculative:")?)?
        .checked_mul(page_size)
}

#[cfg(windows)]
fn platform_cpu() -> Option<CpuTimes> {
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
    }
    let mut idle = FileTime { low: 0, high: 0 };
    let mut kernel = FileTime { low: 0, high: 0 };
    let mut user = FileTime { low: 0, high: 0 };
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let value = |f: FileTime| (u64::from(f.high) << 32) | u64::from(f.low);
    Some(CpuTimes {
        idle: value(idle),
        total: value(kernel).saturating_add(value(user)),
        count: 1,
    })
}

#[cfg(target_os = "macos")]
fn platform_cpu() -> Option<CpuTimes> {
    #[link(name = "System")]
    extern "C" {
        fn mach_host_self() -> u32;
        fn host_statistics(host: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
        fn mach_port_deallocate(task: u32, name: u32) -> i32;
        static mach_task_self_: u32;
    }
    let mut ticks = [0u32; 4];
    let mut count = 4;
    let host = unsafe { mach_host_self() };
    let result = unsafe { host_statistics(host, 3, ticks.as_mut_ptr().cast(), &mut count) };
    unsafe {
        mach_port_deallocate(mach_task_self_, host);
    }
    if result != 0 || count < 4 {
        return None;
    }
    Some(CpuTimes {
        idle: ticks[2] as u64,
        total: ticks.iter().map(|v| *v as u64).sum(),
        count: 1,
    })
}

#[cfg(target_os = "macos")]
fn darwin_memory() -> Option<(u64, u64)> {
    use std::ffi::c_void;
    extern "C" {
        fn sysctlbyname(
            name: *const i8,
            old: *mut c_void,
            oldlen: *mut usize,
            new: *mut c_void,
            newlen: usize,
        ) -> i32;
    }
    let mut total = 0u64;
    let mut size = std::mem::size_of::<u64>();
    if unsafe {
        sysctlbyname(
            b"hw.memsize\0".as_ptr().cast(),
            (&mut total as *mut u64).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    let mut child = std::process::Command::new("/usr/bin/vm_stat")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let available = darwin_available_memory(std::str::from_utf8(&output.stdout).ok()?)?.min(total);
    Some((available, total))
}

fn sample() -> HostResourcesSnapshot {
    let mut cpu_utilization = None;
    let mut cpu_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let mut available_memory_bytes = 0;
    let mut total_memory_bytes = 0;
    #[cfg(target_os = "linux")]
    {
        use std::fs;
        let cgroup = cgroup_dir();
        let read_group = |name: &str| {
            cgroup
                .as_ref()
                .and_then(|p| fs::read_to_string(p.join(name)).ok())
        };
        let capacity = read_group("cpu.max").and_then(|s| {
            let mut parts = s.split_whitespace();
            let quota = parts.next()?.parse::<u64>().ok()?;
            let period = parts.next()?.parse::<u64>().ok()?;
            (period > 0 && quota > 0).then_some(quota as f64 / period as f64)
        });
        let allowed = fs::read_to_string("/proc/self/status").ok().and_then(|s| {
            s.lines().find_map(|line| {
                line.strip_prefix("Cpus_allowed_list:")
                    .and_then(|v| cpu_list(v.trim()))
            })
        });
        let read_cpu = || {
            fs::read_to_string("/proc/stat").ok().and_then(|s| {
                allowed
                    .as_ref()
                    .and_then(|ids| linux_cpu(&s, Some(ids)))
                    .or_else(|| {
                        let mut total = linux_cpu(&s, None)?;
                        total.count = s
                            .lines()
                            .filter(|line| {
                                line.strip_prefix("cpu").is_some_and(|tail| {
                                    tail.as_bytes().first().is_some_and(u8::is_ascii_digit)
                                })
                            })
                            .count()
                            .max(1);
                        Some(total)
                    })
            })
        };
        let read_usage = || read_group("cpu.stat").and_then(|s| stat_number(&s, "usage_usec"));
        let before = read_cpu();
        let before_usage = read_usage();
        let start = Instant::now();
        std::thread::sleep(Duration::from_millis(200));
        let after = read_cpu();
        let after_usage = read_usage();
        let elapsed = start.elapsed().as_secs_f64() * 1_000_000.0;
        if let (Some(before), Some(after)) = (before, after) {
            (cpu_utilization, cpu_count) = utilization(
                before,
                after,
                before_usage.zip(after_usage).map(|(a, b)| (a, b, elapsed)),
                capacity,
            );
        }
        if let Some(host) = fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|s| linux_meminfo(&s))
        {
            let max = read_group("memory.max").and_then(|s| s.trim().parse().ok());
            let current = read_group("memory.current").and_then(|s| s.trim().parse().ok());
            let reclaimable = read_group("memory.stat")
                .and_then(|s| stat_number(&s, "inactive_file"))
                .unwrap_or(0);
            (available_memory_bytes, total_memory_bytes) =
                memory_limit(host, max, current, reclaimable);
        }
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        let before = platform_cpu();
        std::thread::sleep(Duration::from_millis(200));
        let after = platform_cpu();
        if let (Some(before), Some(after)) = (before, after) {
            if let (Some(total), Some(idle)) = (
                after.total.checked_sub(before.total),
                after.idle.checked_sub(before.idle),
            ) {
                if total > 0 && idle <= total {
                    cpu_utilization = Some((1.0 - idle as f64 / total as f64).clamp(0.0, 1.0));
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Some((available, total)) = darwin_memory() {
        available_memory_bytes = available;
        total_memory_bytes = total;
    }
    #[cfg(windows)]
    {
        #[repr(C)]
        struct MemoryStatus {
            length: u32,
            load: u32,
            total_phys: u64,
            avail_phys: u64,
            total_page: u64,
            avail_page: u64,
            total_virtual: u64,
            avail_virtual: u64,
            avail_extended: u64,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
        }
        let mut status = MemoryStatus {
            length: std::mem::size_of::<MemoryStatus>() as u32,
            load: 0,
            total_phys: 0,
            avail_phys: 0,
            total_page: 0,
            avail_page: 0,
            total_virtual: 0,
            avail_virtual: 0,
            avail_extended: 0,
        };
        if unsafe { GlobalMemoryStatusEx(&mut status) } != 0 {
            total_memory_bytes = status.total_phys;
            available_memory_bytes = status.avail_phys.min(status.total_phys);
        }
    }
    HostResourcesSnapshot {
        sampled_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        cpu_utilization,
        cpu_count,
        available_memory_bytes,
        total_memory_bytes,
    }
}

/// Return a cached snapshot, refreshing at most once per five seconds.
pub fn read() -> HostResourcesSnapshot {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<(Instant, HostResourcesSnapshot)>>> =
        std::sync::OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((when, value)) = &*cache {
        if when.elapsed() < Duration::from_secs(5) {
            return value.clone();
        }
    }
    let value = sample();
    *cache = Some((Instant::now(), value.clone()));
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cpu_counters_ignore_guest_and_filter_affinity() {
        let s =
            "cpu  10 2 3 20 5 1 2 4 100 200\ncpu0 1 0 0 3 0 0 0 0 10 0\ncpu2 3 0 0 1 0 0 0 0 5 0\n";
        assert_eq!(linux_cpu(s, None).unwrap().total, 47);
        let allowed = cpu_list("0,2-3").unwrap();
        assert_eq!(
            linux_cpu(s, Some(&allowed)),
            Some(CpuTimes {
                idle: 4,
                total: 8,
                count: 2
            })
        );
        assert!(cpu_list("3-1").is_none());
    }
    #[test]
    fn memory_limits_account_for_reclaimable_and_missing_usage() {
        assert_eq!(
            linux_meminfo("MemTotal: 100 kB\nMemAvailable: 40 kB\n"),
            Some((40960, 102400))
        );
        assert_eq!(
            memory_limit((800, 1000), Some(500), Some(450), 100),
            (150, 500)
        );
        assert_eq!(memory_limit((800, 1000), Some(500), None, 100), (800, 1000));
        assert_eq!(memory_limit((800, 1000), Some(500), Some(900), 0), (0, 500));
    }
    #[test]
    fn quota_utilization_considers_host_and_cgroup() {
        let a = CpuTimes {
            idle: 0,
            total: 100,
            count: 4,
        };
        let b = CpuTimes {
            idle: 80,
            total: 200,
            count: 4,
        };
        assert_eq!(
            utilization(a, b, Some((0, 500_000, 1_000_000.0)), Some(1.0)),
            (Some(0.5), 1)
        );
        assert_eq!(utilization(a, b, None, None).1, 4);
    }
    #[test]
    fn parses_darwin_reclaimable_pages() {
        let output = "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 3.\n";
        assert_eq!(darwin_available_memory(output), Some(33 * 4096));
        assert_eq!(darwin_available_memory("bad input"), None);
    }
    #[test]
    fn repeated_reads_return_cached_snapshot() {
        assert_eq!(read(), read());
    }
}
