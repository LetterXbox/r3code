import Foundation
import Darwin

enum SupervisorError: Error, CustomStringConvertible {
    case failure(String)
    var description: String { if case let .failure(message) = self { return message }; return "Server startup failed" }
}

func fail(_ message: String) throws -> Never { throw SupervisorError.failure(message) }

func privateDirectory(_ path: String) throws {
    if mkdir(path, 0o700) != 0 {
        if errno == ENOENT {
            let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
            if !parent.isEmpty && parent != "/" && parent != path {
                try privateDirectory(parent)
                if mkdir(path, 0o700) != 0 && errno != EEXIST {
                    try fail("Cannot create app-owned directory")
                }
            } else {
                try fail("Cannot create app-owned directory")
            }
        } else if errno != EEXIST {
            try fail("Cannot create app-owned directory")
        }
    }
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
          info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
        try fail("App-owned directory is not private")
    }
}

func privateFile(_ path: String, flags: Int32) throws -> Int32 {
    let fd = open(path, flags | O_NOFOLLOW, mode_t(0o600))
    guard fd >= 0 else { try fail("Cannot open app-owned file") }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
        close(fd)
        try fail("App-owned file is not private")
    }
    return fd
}

func parentAlive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 || errno == EPERM }

func stopProcess(_ process: Process) {
    guard process.isRunning else { return }
    process.terminate()
    let until = Date().addingTimeInterval(5)
    while process.isRunning && Date() < until { Thread.sleep(forTimeInterval: 0.1) }
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    process.waitUntilExit()
}

final class SharedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}

/// Binds (with SO_REUSEADDR) and immediately releases a specific loopback port, to probe whether it is free
/// right now. There is an inherent TOCTOU race between this probe and the real server's own bind, same as
/// `availablePort()`'s race below; accepted for the same reason (a restart's port choice is best-effort, not a
/// reservation).
func tryReservePort(_ port: UInt16) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var reuse: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr = in_addr(s_addr: in_addr_t(INADDR_LOOPBACK).bigEndian)
    address.sin_port = port.bigEndian
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    return bound == 0
}

func availablePort() throws -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { try fail("Cannot create a local socket") }
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr = in_addr(s_addr: in_addr_t(INADDR_LOOPBACK).bigEndian)
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0 else { try fail("Cannot select a local port") }
    var size = socklen_t(MemoryLayout<sockaddr_in>.size)
    let result = withUnsafeMutablePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &size) }
    }
    guard result == 0 else { try fail("Cannot read the local port") }
    return UInt16(bigEndian: address.sin_port)
}

func isReady(_ port: UInt16) -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    let success = SharedFlag()
    let url = URL(string: "http://127.0.0.1:\(port)/.well-known/t3/environment")!
    let task = URLSession.shared.dataTask(with: url) { _, response, _ in
        if (response as? HTTPURLResponse)?.statusCode == 200 { success.set() }
        semaphore.signal()
    }
    task.resume()
    if semaphore.wait(timeout: .now() + 1) == .timedOut { task.cancel(); return false }
    return success.get()
}

func optionalArgument(_ arguments: [String], _ flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

/// Ordered, de-duplicated `:`-joined merge of several `:`-separated PATH-shaped strings (mirrors
/// `tools/run_local.py`'s `merge_paths`): earlier entries win placement, later duplicates are dropped.
func mergePaths(_ parts: [String]) -> String {
    var seen = Set<String>()
    var entries: [String] = []
    for part in parts {
        for raw in part.split(separator: ":") {
            let entry = raw.trimmingCharacters(in: .whitespaces)
            if !entry.isEmpty && seen.insert(entry).inserted { entries.append(entry) }
        }
    }
    return entries.joined(separator: ":")
}

// MARK: - Login shell PATH snapshot
//
// Mirrors the design (read-only reference, never built from here) in
// /Users/jkneen/Documents/GitHub/zuse/crates/providers/src/shell_env.rs: an app launched from LaunchServices
// (Finder, the Dock, `open`) never sources the user's shell rc files, so tools a version manager's shell
// function installs (nvm, mise shims, asdf, custom npm prefixes, ...) are otherwise invisible. The only fix
// that works for any setup is asking the user's actual shell: spawn it as an interactive login shell, have it
// print its environment between markers, and keep the PATH it reports.
//
// Defensive the same way the reference is: `-l -i -c` first (interactive login loads rc files most managers
// hook), falling back to `-l -c` if that produces nothing (some rc files hang, or `exec` a multiplexer, only
// in interactive mode); output is read on a side thread into a shared buffer so a shell that blocks after
// printing -- or a grandchild that inherits the pipe and never closes it -- cannot wedge the caller on EOF; a
// hard per-attempt timeout kills the shell. Captured once per process and cached, including a negative result.
// `T3GPUI_NO_LOGIN_SHELL_PATH=1` disables it entirely, same escape hatch as `ZUSE_NO_LOGIN_SHELL`.

private let shellEnvBeginMarker = "__T3GPUI_SHELL_ENV_BEGIN__"
private let shellEnvEndMarker = "__T3GPUI_SHELL_ENV_END__"
private let shellEnvMaxOutput = 2 * 1024 * 1024
private let shellEnvAttemptTimeout = 5.0
private let shellEnvExitFlushGrace = 0.25

private func passwdShell() -> String? {
    guard let pw = getpwuid(getuid()), let shellPtr = pw.pointee.pw_shell else { return nil }
    let shell = String(cString: shellPtr)
    return shell.isEmpty ? nil : shell
}

private func isExecutableFile(_ path: String) -> Bool {
    var info = stat()
    guard stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return false }
    return access(path, X_OK) == 0
}

/// `$SHELL`, then the passwd entry (services started without `$SHELL` still have one), then well-known
/// defaults. Non-executables and nologin/false shells are skipped.
private func userShell(environment: [String: String]) -> String? {
    var candidates: [String] = []
    if let shell = environment["SHELL"], !shell.isEmpty { candidates.append(shell) }
    if let shell = passwdShell() { candidates.append(shell) }
    candidates.append(contentsOf: ["/bin/zsh", "/bin/bash", "/bin/sh"])
    for candidate in candidates {
        let name = URL(fileURLWithPath: candidate).lastPathComponent
        if name == "nologin" || name == "false" { continue }
        if isExecutableFile(candidate) { return candidate }
    }
    return nil
}

/// Flag sets to try, most-loaded first. csh/tcsh reject `-l` combined with `-c`; fish runs `config.fish` for
/// every invocation, so `-l` alone loads everything without interactive-mode side effects.
private func shellAttemptFlagSets(_ shell: String) -> [[String]] {
    switch URL(fileURLWithPath: shell).lastPathComponent {
    case "csh", "tcsh": return [["-c"]]
    case "fish": return [["-l", "-c"], ["-c"]]
    default: return [["-l", "-i", "-c"], ["-l", "-c"]]
    }
}

private func findBytes(_ haystack: [UInt8], _ needle: [UInt8], from: Int = 0) -> Int? {
    guard !needle.isEmpty, from >= 0, haystack.count >= needle.count else { return nil }
    var i = from
    while i <= haystack.count - needle.count {
        if Array(haystack[i..<(i + needle.count)]) == needle { return i }
        i += 1
    }
    return nil
}

private func rfindBytes(_ haystack: [UInt8], _ needle: [UInt8]) -> Int? {
    guard !needle.isEmpty, haystack.count >= needle.count else { return nil }
    var i = haystack.count - needle.count
    while i >= 0 {
        if Array(haystack[i..<(i + needle.count)]) == needle { return i }
        i -= 1
    }
    return nil
}

/// Extract PATH from the `env` dump between the LAST begin marker and the first end marker after it (rc noise
/// printed before our command -- or a marker echoed by init itself -- lands before the real one).
private func parseSnapshotPath(_ output: [UInt8]) -> String? {
    let begin = Array(shellEnvBeginMarker.utf8)
    let end = Array(shellEnvEndMarker.utf8)
    guard let beginIndex = rfindBytes(output, begin) else { return nil }
    let afterBegin = Array(output[(beginIndex + begin.count)...])
    guard let endIndex = findBytes(afterBegin, end) else { return nil }
    guard let text = String(bytes: afterBegin[..<endIndex], encoding: .utf8) else { return nil }
    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : String(rawLine)
        if line.hasPrefix("PATH="), line.count > 5 { return String(line.dropFirst(5)) }
    }
    return nil
}

private final class ByteBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data: [UInt8] = []
    func append(_ bytes: [UInt8]) { lock.lock(); data.append(contentsOf: bytes); lock.unlock() }
    func snapshot() -> [UInt8] { lock.lock(); defer { lock.unlock() }; return data }
    func count() -> Int { lock.lock(); defer { lock.unlock() }; return data.count }
}

/// Spawn the shell and collect stdout until the end marker appears, the child exits (plus a flush grace), or
/// the timeout kills it. The reader lives on its own thread appending into a shared buffer, so a shell that
/// blocks after printing -- or a grandchild that inherits the pipe and never closes it -- can't hang this
/// function on EOF; this loop only ever polls the buffer.
private func runAndCapture(shell: String, flags: [String], script: String, environment: [String: String], timeout: Double) -> [UInt8] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: shell)
    process.arguments = flags + [script]
    var env = environment
    // Lets rc files detect (and skip work for) this probe, mirroring VSCODE_RESOLVING_ENVIRONMENT upstream;
    // TERM=dumb quiets fancy prompts/spinners that could otherwise emit control bytes before the markers.
    env["T3GPUI_RESOLVING_ENVIRONMENT"] = "1"
    env["TERM"] = "dumb"
    process.environment = env
    process.standardInput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    let output = Pipe()
    process.standardOutput = output
    guard (try? process.run()) != nil else { return [] }
    let buffer = ByteBuffer()
    let readHandle = output.fileHandleForReading
    let reader = Thread {
        while true {
            let chunk = readHandle.availableData
            if chunk.isEmpty { break }
            if buffer.count() >= shellEnvMaxOutput { break }
            buffer.append([UInt8](chunk))
        }
    }
    reader.start()
    let deadline = Date().addingTimeInterval(timeout)
    var exitedAt: Date?
    let endBytes = Array(shellEnvEndMarker.utf8)
    while true {
        if findBytes(buffer.snapshot(), endBytes) != nil { break }
        if let exited = exitedAt {
            if Date().timeIntervalSince(exited) >= shellEnvExitFlushGrace { break }
        } else if !process.isRunning {
            exitedAt = Date()
        } else if Date() >= deadline {
            stopProcess(process)
            break
        }
        Thread.sleep(forTimeInterval: 0.02)
    }
    if process.isRunning { stopProcess(process) }
    try? readHandle.close()
    return buffer.snapshot()
}

/// Run `<shell> <flags> 'echo BEGIN; env; echo END'` per flag set until one yields a parseable PATH.
private func loginShellSnapshotPath(shell: String, environment: [String: String], timeout: Double) -> String? {
    let script = "echo \(shellEnvBeginMarker); env; echo \(shellEnvEndMarker)"
    for flags in shellAttemptFlagSets(shell) {
        if let path = parseSnapshotPath(runAndCapture(shell: shell, flags: flags, script: script, environment: environment, timeout: timeout)),
           !path.isEmpty {
            return path
        }
    }
    return nil
}

// Outer optional: not yet captured this process. Inner optional: the captured result (nil = none found).
private var loginShellPathCache: String??

/// The PATH the user's login shell reports, captured once and cached for the life of this process (including a
/// negative result, same as upstream's `OnceLock`). `nil` when disabled, no usable shell was found, or the
/// shell never produced a parseable snapshot within `shellEnvAttemptTimeout`.
func loginShellPath(environment: [String: String]) -> String? {
    if let cached = loginShellPathCache { return cached }
    if let disable = environment["T3GPUI_NO_LOGIN_SHELL_PATH"], !disable.isEmpty {
        loginShellPathCache = .some(nil)
        return nil
    }
    guard let shell = userShell(environment: environment) else {
        loginShellPathCache = .some(nil)
        return nil
    }
    let result = loginShellSnapshotPath(shell: shell, environment: environment, timeout: shellEnvAttemptTimeout)
    loginShellPathCache = .some(result)
    return result
}

func augmentedPath(_ existingPath: String?, homeDirectory: String) -> String {
    let extra = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        homeDirectory + "/.local/share/vite-plus/bin",
        homeDirectory + "/.nvm/current/bin",
        homeDirectory + "/.local/share/mise/shims",
        homeDirectory + "/.bun/bin",
        homeDirectory + "/.npm-global/bin",
        homeDirectory + "/.local/bin",
        homeDirectory + "/.volta/bin",
        homeDirectory + "/.fnm/aliases/default/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    return mergePaths([existingPath ?? "", extra.joined(separator: ":")])
}

func createPairingCredential(
    runtimePath: String,
    baseEnvironment: [String: String],
    dataDir: String,
    parent: pid_t,
    stopping: SharedFlag
) -> String? {
    let pairing = Process()
    let output = Pipe()
    pairing.executableURL = URL(fileURLWithPath: runtimePath)
    pairing.currentDirectoryURL = pairing.executableURL!.deletingLastPathComponent()
    var pairingEnvironment = baseEnvironment
    pairingEnvironment["T3CODE_HOME"] = dataDir
    pairing.arguments = ["auth", "pairing", "create", "--ttl", "1h", "--label", "R3 Code", "--json", "--base-dir", dataDir]
    pairing.environment = pairingEnvironment
    pairing.standardOutput = output
    pairing.standardError = FileHandle.nullDevice
    guard (try? pairing.run()) != nil else { return nil }
    let pairingDeadline = Date().addingTimeInterval(30)
    while pairing.isRunning && Date() < pairingDeadline && parentAlive(parent) && !stopping.get() {
        Thread.sleep(forTimeInterval: 0.1)
    }
    if pairing.isRunning {
        stopProcess(pairing)
        return nil
    }
    let result = output.fileHandleForReading.readDataToEndOfFile()
    guard pairing.terminationStatus == 0,
          let body = try? JSONSerialization.jsonObject(with: result) as? [String: Any],
          let credential = body["credential"] as? String else {
        return nil
    }
    let trimmed = credential.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

/// Writes the bootstrap JSON to a private tmp file beside `path` and renames it into place atomically. Used both
/// for the very first bootstrap and for every later re-issue after a restart: `t3ui/backend/bootstrap.ts`'s
/// `consumeLocalBootstrap` only cares that the final path matches its naming pattern, not how it got there, so
/// the app can keep reading the same `T3GPUI_BOOTSTRAP_FILE` path across restarts instead of needing a new one
/// handed to it out of band.
func publishBootstrap(path: String, port: UInt16, credential: String) throws {
    let tmp = path + ".tmp"
    unlink(tmp)
    let payload: [String: Any] = ["endpoint": "ws://127.0.0.1:\(port)/ws", "token": credential, "serverEngine": "r3"]
    let contents = try JSONSerialization.data(withJSONObject: payload)
    let fd = try privateFile(tmp, flags: O_WRONLY | O_CREAT | O_EXCL)
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    try handle.write(contentsOf: contents)
    try handle.close()
    guard rename(tmp, path) == 0 else { try fail("Cannot publish bootstrap file") }
}

// Exponential backoff for an unexpected server exit or failed restart: 500ms, 1s, 2s, 4s, 8s, 10s, 10s, ...
// Mirrors `tools/run_local.py`'s `ServerSupervisor` (INITIAL_RESTART_DELAY/MAX_RESTART_DELAY/HEALTHY_RUN_PERIOD),
// so the two launchers behave the same way under a crash loop.
let initialRestartDelay = 0.5
let maxRestartDelay = 10.0
let healthyRunPeriod = 10.0

func calculateRestartDelay(_ attempt: Int) -> Double {
    min(initialRestartDelay * pow(2.0, Double(attempt)), maxRestartDelay)
}

func main() throws {
    let arguments = CommandLine.arguments
    func argument(_ flag: String) throws -> String {
        guard let value = optionalArgument(arguments, flag) else { try fail("Missing \(flag)") }
        return value
    }
    let homeDirectory = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
    guard let rustRuntime = optionalArgument(arguments, "--rust-runtime") ?? optionalArgument(arguments, "--runtime"),
          access(rustRuntime, X_OK) == 0 else {
        try fail("Bundled R3 Rust server is missing or not executable")
    }
    let data = try argument("--data-dir")
    let bootstrapDir = try argument("--bootstrap-dir")
    guard let parent = Int32(try argument("--parent")), parent > 1 else { try fail("Invalid parent") }
    let dataURL = URL(fileURLWithPath: data)

    let stopping = SharedFlag()
    signal(SIGTERM, SIG_IGN)
    signal(SIGHUP, SIG_IGN)
    let signals = [SIGTERM, SIGHUP].map { number in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { stopping.set() }
        source.resume()
        return source
    }
    defer { signals.forEach { $0.cancel() } }

    try privateDirectory(URL(fileURLWithPath: bootstrapDir).deletingLastPathComponent().path)
    try privateDirectory(data)
    try privateDirectory(bootstrapDir)
    let lock = try privateFile(dataURL.appendingPathComponent("supervisor.lock").path, flags: O_RDWR | O_CREAT)
    defer { close(lock) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { try fail("The app-owned local server is already running") }

    var environment = ProcessInfo.processInfo.environment.filter { key, _ in
        !["VITE_", "T3CODE_", "npm_", "PNPM_"].contains(where: key.hasPrefix) &&
        !["PORT", "NODE_PATH", "INIT_CWD", "NODE_PACKAGE_MANAGER"].contains(key)
    }
    environment["T3CODE_HOME"] = data
    environment["T3CODE_ENVIRONMENT_LABEL"] = "R3 Code"
    environment["PATH"] = augmentedPath(environment["PATH"], homeDirectory: homeDirectory)
    // A GUI launch (Dock/Finder/`open`) never sources ~/.zshrc etc., so tools a version manager installs
    // (nvm/mise/volta/asdf shims) are invisible unless asked for explicitly through a real login shell. Best
    // effort and bounded: a slow or broken shell rc falls back to the hardcoded list above, never blocking start.
    if let shellPath = loginShellPath(environment: ProcessInfo.processInfo.environment) {
        environment["PATH"] = mergePaths([shellPath, environment["PATH"] ?? ""])
    }
    let speechEntry = URL(fileURLWithPath: rustRuntime)
        .deletingLastPathComponent()
        .appendingPathComponent("node_modules/transcribe-cpp/dist/index.js")
    if FileManager.default.fileExists(atPath: speechEntry.path) {
        environment["T3_SPEECH_MODULE"] = speechEntry.absoluteString
    }

    let bootstrapPath = URL(fileURLWithPath: bootstrapDir).appendingPathComponent("bootstrap-\(UUID().uuidString.lowercased()).json").path
    var currentServer: Process?
    defer {
        if let server = currentServer { stopProcess(server) }
        unlink(bootstrapPath)
    }

    /// Starts a fresh server `Process` on `preferredPort` if it is free, else a new ephemeral port, waits for it
    /// to answer ready, mints a pairing credential and (re-)publishes the bootstrap file. Throws (never silently
    /// fails) so the caller decides: the first call turns a throw into `exit(1)` (the C launcher is blocked on
    /// the pipe waiting for exactly one line, so a startup failure must be immediate and loud); every later call,
    /// made from the supervision loop after an unexpected exit, turns a throw into a scheduled retry instead.
    func attemptStart(preferredPort: UInt16) throws -> (Process, UInt16) {
        let port = tryReservePort(preferredPort) ? preferredPort : try availablePort()
        let server = Process()
        server.executableURL = URL(fileURLWithPath: rustRuntime)
        server.currentDirectoryURL = server.executableURL!.deletingLastPathComponent()
        server.environment = environment
        server.arguments = ["serve", "--mode", "desktop", "--host", "127.0.0.1", "--port", String(port), "--base-dir", data, "--no-browser"]
        server.standardOutput = FileHandle.nullDevice
        server.standardError = FileHandle.nullDevice
        try server.run()
        let deadline = Date().addingTimeInterval(90)
        var ready = false
        while server.isRunning && parentAlive(parent) && !stopping.get() && Date() < deadline {
            if isReady(port) { ready = true; break }
            Thread.sleep(forTimeInterval: 0.2)
        }
        if !ready {
            stopProcess(server)
            try fail("The local server did not become ready")
        }
        guard let credential = createPairingCredential(
            runtimePath: rustRuntime, baseEnvironment: environment, dataDir: data, parent: parent, stopping: stopping
        ) else {
            stopProcess(server)
            try fail("The local server did not return a pairing credential")
        }
        do {
            try publishBootstrap(path: bootstrapPath, port: port, credential: credential)
        } catch {
            stopProcess(server)
            throw error
        }
        return (server, port)
    }

    let (initialServer, initialPort) = try attemptStart(preferredPort: try availablePort())
    currentServer = initialServer
    var currentPort = initialPort
    print(bootstrapPath)
    fflush(stdout)

    // H1 (DESKTOP_PARITY_AUDIT.md): detect an unexpected exit and restart with exponential backoff, same as
    // `tools/run_local.py`'s `ServerSupervisor`. Every (re)start re-issues the bootstrap file in place (same
    // path) so the app can pick up a changed port/token after a crash without the launcher restarting it.
    var attempt = 0
    var startedAt: Date? = Date()
    var retryAt: Date?
    while parentAlive(parent) && !stopping.get() {
        if let server = currentServer {
            if server.isRunning {
                if let started = startedAt, Date().timeIntervalSince(started) >= healthyRunPeriod { attempt = 0 }
                Thread.sleep(forTimeInterval: 0.2)
                continue
            }
            let code = server.terminationStatus
            currentServer = nil
            startedAt = nil
            let delay = calculateRestartDelay(attempt)
            attempt += 1
            retryAt = Date().addingTimeInterval(delay)
            fputs("the server exited unexpectedly (code \(code)); restart scheduled in \(String(format: "%.1f", delay))s\n", stderr)
            continue
        }
        guard let retry = retryAt else {
            retryAt = Date().addingTimeInterval(calculateRestartDelay(attempt))
            attempt += 1
            continue
        }
        if Date() < retry {
            Thread.sleep(forTimeInterval: 0.2)
            continue
        }
        retryAt = nil
        do {
            let (server, port) = try attemptStart(preferredPort: currentPort)
            currentServer = server
            currentPort = port
            startedAt = Date()
        } catch {
            let delay = calculateRestartDelay(attempt)
            attempt += 1
            retryAt = Date().addingTimeInterval(delay)
            fputs("restart failed (\(error)); retrying in \(String(format: "%.1f", delay))s\n", stderr)
        }
    }
}

do { try main() } catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
