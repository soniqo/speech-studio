#include "sidecar_sysinfo.h"

#include <cstdio>

#if defined(_WIN32)
#include <windows.h>
#elif defined(__APPLE__)
#include <mach/mach.h>
#include <sys/sysctl.h>
#else  // Linux and other Unix
#include <fstream>
#include <sstream>
#endif

bool query_physical_memory(uint64_t& total_bytes, uint64_t& available_bytes) {
    total_bytes = 0;
    available_bytes = 0;
#if defined(_WIN32)
    MEMORYSTATUSEX st;
    st.dwLength = sizeof(st);
    if (!GlobalMemoryStatusEx(&st)) return false;
    total_bytes = static_cast<uint64_t>(st.ullTotalPhys);
    available_bytes = static_cast<uint64_t>(st.ullAvailPhys);
    return true;
#elif defined(__APPLE__)
    // Total via sysctl hw.memsize.
    {
        uint64_t mem = 0;
        size_t len = sizeof(mem);
        int mib[2] = {CTL_HW, HW_MEMSIZE};
        if (sysctl(mib, 2, &mem, &len, nullptr, 0) == 0) total_bytes = mem;
    }
    // Available ≈ (free + inactive) pages * page size, via host_statistics64.
    // inactive pages are reclaimable, so counting them mirrors what the kernel
    // would hand back under pressure (akin to Linux MemAvailable).
    {
        mach_port_t host = mach_host_self();
        vm_size_t page_size = 0;
        if (host_page_size(host, &page_size) == KERN_SUCCESS) {
            vm_statistics64_data_t vm;
            mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
            if (host_statistics64(host, HOST_VM_INFO64,
                                  reinterpret_cast<host_info64_t>(&vm),
                                  &count) == KERN_SUCCESS) {
                available_bytes = (static_cast<uint64_t>(vm.free_count) +
                                   static_cast<uint64_t>(vm.inactive_count)) *
                                  static_cast<uint64_t>(page_size);
            }
        }
        mach_port_deallocate(mach_task_self(), host);
    }
    return total_bytes != 0;
#else  // Linux: parse /proc/meminfo (values in kB).
    std::ifstream f("/proc/meminfo");
    if (!f) return false;
    uint64_t mem_total_kb = 0, mem_avail_kb = 0, mem_free_kb = 0;
    std::string line;
    while (std::getline(f, line)) {
        std::istringstream ls(line);
        std::string key;
        uint64_t value_kb = 0;
        ls >> key >> value_kb;
        if (key == "MemTotal:") mem_total_kb = value_kb;
        else if (key == "MemAvailable:") mem_avail_kb = value_kb;
        else if (key == "MemFree:") mem_free_kb = value_kb;
    }
    if (mem_total_kb == 0) return false;
    total_bytes = mem_total_kb * 1024ull;
    // MemAvailable is the kernel's own estimate of allocatable-without-swap;
    // fall back to MemFree on ancient kernels that don't expose it.
    available_bytes = (mem_avail_kb ? mem_avail_kb : mem_free_kb) * 1024ull;
    return true;
#endif
}

std::string format_gib(uint64_t bytes) {
    // Integer math + floor, deliberately not "%.1f": (1) locale-independent —
    // %llu has no LC_NUMERIC decimal separator, so the output (and the unit
    // tests) stay stable even if a linked lib flips the locale; (2) floors
    // instead of rounding, so a value just under a threshold (e.g. 9.99 GiB)
    // never renders as "10.0 GiB" and make a block message self-contradict.
    // Splitting the fraction off the remainder keeps it overflow-safe.
    constexpr uint64_t GiB = uint64_t{1} << 30;
    const uint64_t whole = bytes / GiB;
    const uint64_t tenths = ((bytes % GiB) * 10) / GiB;
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%llu.%llu GiB",
                  static_cast<unsigned long long>(whole),
                  static_cast<unsigned long long>(tenths));
    return std::string(buf);
}

RamCheckResult check_model_ram(uint64_t total_bytes, uint64_t available_bytes,
                               uint64_t required_bytes, bool force) {
    if (force) return {true, ""};
    // Prefer "available" (what can actually be allocated now); fall back to
    // total when the platform reports only that. Zero on both = unknown → don't
    // block on missing data. "available" is the right signal even on big boxes:
    // Linux MemAvailable / Windows ullAvailPhys already count reclaimable cache,
    // so available < required means the load would genuinely swap or OOM. The
    // rare reclaim-heavy false positive is recoverable via SONIQO_SKIP_RAM_CHECK.
    uint64_t effective = available_bytes ? available_bytes : total_bytes;
    if (effective == 0) return {true, ""};
    if (effective >= required_bytes) return {true, ""};

    std::string msg = "insufficient RAM for the VoxCPM2 fp16 model: needs ~" +
                      format_gib(required_bytes) + ", but ";
    if (available_bytes) {
        msg += "only " + format_gib(available_bytes) + " is available";
        if (total_bytes) msg += " (of " + format_gib(total_bytes) + " total)";
    } else {
        msg += "this machine has only " + format_gib(total_bytes) + " total";
    }
    msg += ". Close other apps, or use a machine with at least 16 GB RAM. "
           "To attempt the load anyway, set SONIQO_SKIP_RAM_CHECK=1.";
    return {false, msg};
}
