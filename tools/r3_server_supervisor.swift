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
    var parts = (existingPath ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty }
    var seen = Set(parts)
    for dir in extra where seen.insert(dir).inserted {
        parts.append(dir)
    }
    return parts.joined(separator: ":")
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

    let port = try availablePort()
    var environment = ProcessInfo.processInfo.environment.filter { key, _ in
        !["VITE_", "T3CODE_", "npm_", "PNPM_"].contains(where: key.hasPrefix) &&
        !["PORT", "NODE_PATH", "INIT_CWD", "NODE_PACKAGE_MANAGER"].contains(key)
    }
    environment["T3CODE_HOME"] = data
    environment["T3CODE_ENVIRONMENT_LABEL"] = "R3 Code"
    environment["PATH"] = augmentedPath(environment["PATH"], homeDirectory: homeDirectory)
    let speechEntry = URL(fileURLWithPath: rustRuntime)
        .deletingLastPathComponent()
        .appendingPathComponent("node_modules/transcribe-cpp/dist/index.js")
    if FileManager.default.fileExists(atPath: speechEntry.path) {
        environment["T3_SPEECH_MODULE"] = speechEntry.absoluteString
    }

    let server = Process()
    server.executableURL = URL(fileURLWithPath: rustRuntime)
    server.currentDirectoryURL = server.executableURL!.deletingLastPathComponent()
    server.environment = environment
    server.arguments = ["serve", "--mode", "desktop", "--host", "127.0.0.1", "--port", String(port), "--base-dir", data, "--no-browser"]
    server.standardOutput = FileHandle.nullDevice
    server.standardError = FileHandle.nullDevice

    let bootstrap = URL(fileURLWithPath: bootstrapDir).appendingPathComponent("bootstrap-\(UUID().uuidString.lowercased()).json").path
    defer {
        unlink(bootstrap)
        stopProcess(server)
    }

    try server.run()
    let deadline = Date().addingTimeInterval(90)
    var ready = false
    while server.isRunning && parentAlive(parent) && !stopping.get() && Date() < deadline {
        if isReady(port) {
            ready = true
            break
        }
        Thread.sleep(forTimeInterval: 0.2)
    }
    if !ready {
        try fail("The local server did not become ready")
    }

    guard let credential = createPairingCredential(
        runtimePath: rustRuntime,
        baseEnvironment: environment,
        dataDir: data,
        parent: parent,
        stopping: stopping
    ) else {
        try fail("The local server did not return a pairing credential")
    }

    let bootstrapPayload: [String: Any] = [
        "endpoint": "ws://127.0.0.1:\(port)/ws",
        "token": credential,
        "serverEngine": "r3",
    ]
    let contents = try JSONSerialization.data(withJSONObject: bootstrapPayload)
    let file = try privateFile(bootstrap, flags: O_WRONLY | O_CREAT | O_EXCL)
    let handle = FileHandle(fileDescriptor: file, closeOnDealloc: true)
    try handle.write(contentsOf: contents)
    try handle.close()
    print(bootstrap)
    fflush(stdout)
    while parentAlive(parent) && server.isRunning && !stopping.get() { Thread.sleep(forTimeInterval: 0.5) }
}

do { try main() } catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
