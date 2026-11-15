import { connect } from "websocket";
import { stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

/**
 * Diagnostics for a test copy only: with a `rpc-trace` file beside the bootstrap file (workspace test copies), every
 * request and stream start is appended (method, input, time) to `rpc-trace.ndjson` there. Never on otherwise.
 */
const rpcTraceFile: Promise<string | null> = (async () => {
  try {
    const bootstrap = typeof process !== "undefined" ? process.env.T3GPUI_BOOTSTRAP_FILE : undefined;
    if (!bootstrap) return null;
    const dir = dirname(bootstrap);
    return (await stat(join(dir, "rpc-trace"))).isFile() ? join(dir, "rpc-trace.ndjson") : null;
  } catch { return null; }
})();
const rpcTraceLines: string[] = [];
let rpcTraceFlush: ReturnType<typeof setTimeout> | undefined;
function traceRpc(kind: string, method: string, payload: unknown) {
  void rpcTraceFile.then((file) => {
    if (!file) return;
    let input = "";
    try { input = JSON.stringify(payload); } catch { input = "?"; }
    rpcTraceLines.push(JSON.stringify({ at: new Date().toISOString(), kind, method, input: input.length > 400 ? `${input.slice(0, 400)}...` : input }));
    if (rpcTraceFlush === undefined) rpcTraceFlush = setTimeout(() => {
      rpcTraceFlush = undefined;
      void writeFile(file, `${rpcTraceLines.join("\n")}\n`).catch(() => {});
    }, 1000);
  }).catch(() => {});
}

type RecordValue = Record<string, unknown>;

export function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

type Pending =
  | { kind: "request"; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number | undefined }
  | { kind: "stream"; receive: (value: unknown) => void; reject: (error: Error) => void; end?: () => void };

export interface SocketConnection {
  read(): Promise<string | Uint8Array | null>;
  write(data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface HeartbeatClock {
  now(): number;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(handle: number): void;
}

const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 15000;
const heartbeatClock: HeartbeatClock = {
  now: () => Date.now(),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle),
};

const SECRET_REQUEST_FAILURES: Record<string, string> = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  store_failed: "Could not store the secret.",
  reference_unreadable: "Could not read the secret from the secret provider.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable: "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
  consume_failed: "Could not use that secretRef. Try again.",
  not_a_file_request: 'The user did not save this secret for shell use. Ask again with request_secret and delivery: "file".',
};
const MCP_APP_REQUEST_FAILURES: Record<string, string> = {
  "not-an-app": "This tool call has no MCP app.",
  "provider-unsupported": "This thread's provider cannot run MCP app requests.",
  "session-stopped": "The app's thread is not running. Send a message in the thread that created it to use the app again.",
  "tool-not-callable": "This app cannot call that tool.",
  "unsupported-content": "Only text and structured content are supported.",
  "request-failed": "The app's MCP server request failed.",
};
const PEER_LINK_REQUEST_FAILURES: Record<string, string> = {
  load_failed: "Could not load the link request.",
  not_found: "This link request no longer exists.",
  already_answered: "This link request was already answered.",
  record_failed: "Could not update the link request.",
};
const str = (value: unknown): string => (typeof value === "string" ? value : "");

const GUEST_SHARE_CREATE_FAILURES: Record<string, string> = {
  disabled: "Guest links are off. Turn them on in Settings > Labs.",
  connect_unavailable: "Guest links need a running T3 Connect tunnel.",
  thread_unavailable: "This thread cannot be shared.",
  read_failed: "Failed to read the shared thread.",
  changed: "The guest link changed while it was being created.",
};

/**
 * The text of contract errors whose `message` is a getter computed from fields (contracts/src/device.ts). Only the fields cross the
 * wire, so the reference rebuilds the text by decoding into the class; this does the same for the device errors.
 */
export function contractErrorMessage(error: Record<string, unknown>): string | null {
  switch (error._tag) {
    case "DeviceHostUnavailableError": return `${str(error.hostLabel) || `Device host ${str(error.hostId)}`} is unavailable: ${str(error.reason)}`;
    case "DevicePlatformUnavailableError": return `${str(error.platform)} devices are unavailable on host ${str(error.hostId)}: ${str(error.reason)}`;
    case "DeviceNotFoundError": return `Device ${str(error.deviceId)} was not found on host ${str(error.hostId)}.`;
    case "DeviceBootError": {
      const explanation = ({ disk_space: "There is not enough free disk space on its device host.", timeout: "The device did not become ready in time.",
        launch_failed: "The simulator or emulator could not start." } as Record<string, string>)[str(error.reason)];
      const summary = `Device ${str(error.deviceId)} failed to boot: ${explanation ?? str(error.reason)}`;
      return str(error.diagnostics) ? `${summary}\n\n${str(error.diagnostics)}`
        : `${summary} The device host sent no details. Try again or open another device; if it keeps failing, check the device on that host.`;
    }
    case "DeviceOperationError": {
      const explanation = ({
        command_failed: `The device command failed${typeof error.exitCode === "number" ? ` (exit code ${error.exitCode})` : ""}.`,
        request_failed: "Could not communicate with device support. Try refreshing devices.",
        invalid_payload: "The device request could not be encoded.",
        settings_failed: "Could not read or save device settings.",
        hub_rejected: "The device hub could not complete the request.",
      } as Record<string, string>)[str(error.reason)];
      return `Device ${str(error.operation)} failed: ${explanation ?? str(error.reason)}`;
    }
    case "DeviceActionUnavailableError":
      return error.reason === "helper_missing" ? `Device ${str(error.operation)} requires a helper missing from this install. Set up device support again.`
        : `Device ${str(error.operation)} is not supported on ${str(error.platform)}.`;
    case "SecretRequestError": {
      if (error.reason === "reference_unreadable" && typeof error.provider === "string") {
        return `Could not read the secret from the secret provider "${error.provider}". Unlock it and try again, or enter the value.`;
      }
      return SECRET_REQUEST_FAILURES[str(error.reason)] ?? null;
    }
    case "McpAppRequestError": return MCP_APP_REQUEST_FAILURES[str(error.reason)] ?? null;
    case "PeerLinkRequestError": return PEER_LINK_REQUEST_FAILURES[str(error.reason)] ?? null;
    case "DeviceToolUnavailableError": case "DeviceEasAccountError": case "DeviceSimlockIdentityError": return str(error.reason) || null;
    // contracts/src/server.ts, settings.ts, keybindings.ts, guestShare.ts: `message` is a getter over the serialized fields.
    case "ServerProviderUpdateError": return `Provider update failed for ${str(error.provider)}: ${str(error.reason)}`;
    case "ServerSelfUpdateError": return `Server update failed: ${str(error.reason)}`;
    case "ServerNpmReleaseError": return `Could not check the configured npm registry: ${str(error.reason)}`;
    case "DatabaseReclaimError": return str(error.reason) || null;
    case "ServerPrepareTriageError": return "Could not write the triage session files.";
    case "KeybindingsConfigParseError": return `Unable to parse keybindings config at ${str(error.configPath)}: ${str(error.detail)}`;
    case "GuestShareCreateError": return GUEST_SHARE_CREATE_FAILURES[str(error.reason)] ?? null;
    case "ServerSettingsError": {
      if (error.operation === "write-managed-setting") return `${str(error.managedSetting) || "This setting"} is managed by ${str(error.managedBy) || "your organization"} and cannot be changed.`;
      if (error.operation === "use-disallowed-provider") return `${str(error.managedBy) ? `${str(error.managedBy)}'s` : "Your organization"} policy does not allow the ${str(error.providerLabel) || str(error.providerInstanceId) || "this"} provider.`;
      const provider = str(error.providerInstanceId) ? ` for provider ${str(error.providerInstanceId)}` : "";
      const variable = str(error.environmentVariable) ? ` and environment variable ${str(error.environmentVariable)}` : "";
      return `Server settings ${str(error.operation)} failed${provider}${variable} at ${str(error.settingsPath)}.`;
    }
    default: return null;
  }
}

function failureMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = failureMessage(item);
      if (found !== "Request failed") return found;
    }
  }
  const data = record(value);
  if (data) {
    if (typeof data.message === "string") return data.message;
    const contract = contractErrorMessage(data);
    if (contract) return contract;
    // Contract errors such as ProviderSetupError carry their safe text in `detail` (their `message` getter returns it).
    if (typeof data.detail === "string" && data.detail.trim()) return data.detail;
    if (data.error !== undefined) return failureMessage(data.error);
    if (data.cause !== undefined) return failureMessage(data.cause);
    if (data.defect !== undefined) return failureMessage(data.defect);
  }
  return "Request failed";
}

const CAUSE_TAGS = new Set(["Fail", "Die", "Interrupt", "Failure", "Success", "Sequential", "Parallel", "Empty"]);

/** The contract error `_tag` a failed RPC carried (for example OrchestrationV2DispatchCommandError), when it names one. */
export function failureTag(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) { const found = failureTag(item); if (found) return found; }
    return null;
  }
  const data = record(value);
  if (!data) return null;
  if (typeof data._tag === "string" && !CAUSE_TAGS.has(data._tag)) return data._tag;
  return failureTag(data.error ?? data.cause);
}

/** An RPC failure from the server, with the contract error tag it carried (null for transport failures). */
export class RequestFailure extends Error {
  constructor(message: string, readonly tag: string | null, readonly reason: string | null = null) { super(message); }
}

/** The reference's `String(squashAtomCommandFailure(result))`: a decoded contract error's Error#toString, "<Tag>: <message>". */
export function stringifiedFailure(cause: unknown): string {
  if (cause instanceof RequestFailure && cause.tag) return `${cause.tag}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}

/** The contract error's `reason` a failed RPC carried (PullRequestOperationError's "not-found"), when it has one. */
export function failureReason(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) { const found = failureReason(item); if (found) return found; }
    return null;
  }
  const data = record(value);
  if (!data) return null;
  if (typeof data.reason === "string") return data.reason;
  return failureReason(data.error ?? data.cause);
}

/** The server's Effect RPC protocol uses one ordered WebSocket for all calls. */
/** rpc/session.ts SOCKET_OPEN_TIMEOUT. */
export const SOCKET_OPEN_TIMEOUT_MS = 15_000;

export class BackendClient {
  private socket: SocketConnection | null = null;
  private pending = new Map<string, Pending>();
  private serial = 0;
  private closed = false;
  private pingTimer: number | undefined;
  private lastFrameAt = 0;
  private lastPingTickAt = 0;
  private awaitingPingResponse = false;

  constructor(
    private readonly onClose: (error: Error) => void,
    private readonly openSocket: (url: string) => Promise<SocketConnection> = connect,
    private readonly clock: HeartbeatClock = heartbeatClock,
  ) {}

  async connect(url: string) {
    // rpc/session.ts SOCKET_OPEN_TIMEOUT (15 s): a blackholed route fails here and backs off instead of hanging.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const opening = this.openSocket(url);
    opening.then((late) => { if (timedOut) void Promise.resolve(late.close()).catch(() => {}); }, () => {});
    const socket = await Promise.race([opening, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new Error("Timed out opening the connection to the environment.")); }, SOCKET_OPEN_TIMEOUT_MS);
    })]).finally(() => clearTimeout(timer));
    if (this.closed) {
      await socket.close();
      return;
    }
    this.socket = socket;
    this.lastFrameAt = this.clock.now();
    this.lastPingTickAt = this.lastFrameAt;
    this.awaitingPingResponse = false;
    this.pingTimer = this.clock.setInterval(() => {
      const now = this.clock.now();
      const sinceTick = now - this.lastPingTickAt;
      this.lastPingTickAt = now;
      // Give a stalled or suspended client time to process frames and send a fresh ping.
      if (sinceTick < 0 || sinceTick > HEARTBEAT_INTERVAL_MS * 2) {
        this.lastFrameAt = now;
        this.awaitingPingResponse = false;
      }
      if (this.awaitingPingResponse && now - this.lastFrameAt > HEARTBEAT_TIMEOUT_MS) {
        this.fail(new Error("Environment stopped responding"));
        return;
      }
      this.awaitingPingResponse = true;
      void this.write({ _tag: "Ping" }).catch((error: unknown) => this.fail(error));
    }, HEARTBEAT_INTERVAL_MS);
    void this.read(socket);
  }

  private write(value: unknown): Promise<void> {
    if (!this.socket || this.closed) return Promise.reject(new Error("Not connected to an environment"));
    // The host socket rejects a write while too many are outstanding ("WebSocket
    // command queue is full"), so frames go out one at a time, in call order.
    const frame = JSON.stringify(value);
    // An idle socket is written to at once; later frames wait for the one before.
    const sent = this.writesOutstanding === 0
      ? this.socket.write(frame)
      : this.writeChain.then(() => {
        if (!this.socket || this.closed) throw new Error("Not connected to an environment");
        return this.socket.write(frame);
      });
    this.writesOutstanding += 1;
    this.writeChain = sent.catch(() => {}).then(() => { this.writesOutstanding -= 1; });
    return sent;
  }
  private writeChain: Promise<void> = Promise.resolve();
  private writesOutstanding = 0;
  /** packages/shared socketFrameParts.ts joinSocketFrameParts: parts except the last start with this. */
  private pendingFrame = "";

  /** Joins `frameParts=1` parts. A held-back part is a Pong so the heartbeat stays up while the rest arrives. */
  private assembleFrame(frame: string): string {
    if (frame.startsWith("\u001e")) {
      this.pendingFrame += frame.slice(1);
      return '{"_tag":"Pong"}';
    }
    if (this.pendingFrame === "") return frame;
    const whole = this.pendingFrame + frame;
    this.pendingFrame = "";
    return whole;
  }

  request(method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      // rpc/client.ts has no RPC timeout: a request waits for its answer or for the connection closing (the heartbeat
      // ends a dead socket). Only a caller's own deadline (probe, background reads) applies; on it the request is interrupted.
      const deadline = options?.timeoutMs;
      const timer = deadline === undefined || deadline === Infinity ? undefined : setTimeout(() => {
        if (!this.pending.delete(id)) return;
        void this.write({ _tag: "Interrupt", requestId: id, interruptors: [] }).catch(() => {});
        reject(new Error("Request timed out. Its outcome may be unknown; check the thread before retrying."));
      }, Math.max(1000, deadline));
      this.pending.set(id, { kind: "request", resolve, reject, timer });
      traceRpc("request", method, payload);
      void this.write({ _tag: "Request", id, tag: method, payload, headers: [] }).catch((error: unknown) => {
        const entry = this.pending.get(id);
        if (!entry || entry.kind !== "request") return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** `end`, when given, receives a normal end of the stream (Exit Success), which is then not an error. */
  subscribe(method: string, payload: unknown, receive: (value: unknown) => void, reject: (error: Error) => void, end?: () => void): () => void {
    const id = String(++this.serial);
    this.pending.set(id, { kind: "stream", receive, reject, end });
    traceRpc("stream", method, payload);
    void this.write({ _tag: "Request", id, tag: method, payload, headers: [] }).catch((error: unknown) => {
      if (!this.pending.delete(id)) return;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    return () => {
      if (!this.pending.delete(id)) return;
      void this.write({ _tag: "Interrupt", requestId: id, interruptors: [] }).catch(() => {});
    };
  }

  private async read(socket: SocketConnection) {
    try {
      while (!this.closed) {
        const data = await socket.read();
        if (data === null) throw new Error("The environment closed the connection");
        this.lastFrameAt = this.clock.now();
        this.awaitingPingResponse = false;
        const text = this.assembleFrame(typeof data === "string" ? data : new TextDecoder().decode(data));
        const message = record(JSON.parse(text));
        if (!message) throw new Error("Invalid response from the environment");
        if (message._tag === "Pong") continue;
        if (message._tag === "Defect") throw new Error(failureMessage(message.defect));
        const id = String(message.requestId ?? "");
        const pending = this.pending.get(id);
        if (!pending) continue;
        if (message._tag === "Chunk" && pending.kind === "stream") {
          if (!Array.isArray(message.values)) throw new Error("Invalid stream response from the environment");
          for (const value of message.values) pending.receive(value);
          await this.write({ _tag: "Ack", requestId: id });
        } else if (message._tag === "Exit") {
          this.pending.delete(id);
          if (pending.kind === "request") clearTimeout(pending.timer);
          const result = record(message.exit);
          if (result?._tag === "Success") {
            if (pending.kind === "request") pending.resolve(result.value);
            else if (pending.end) pending.end();
            else pending.reject(new Error("Environment subscription ended unexpectedly"));
          } else {
            pending.reject(new RequestFailure(failureMessage(result?.cause), failureTag(result?.cause), failureReason(result?.cause)));
          }
        }
      }
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  }

  /** Ends the connection as a failure (onClose runs, so the owner reconnects): a health check that went unanswered. */
  abandon(error: Error) {
    if (!this.closed) this.fail(error);
  }

  private fail(value: unknown) {
    const error = value instanceof Error ? value : new Error(String(value));
    this.close(error);
    this.onClose(error);
  }

  close(error = new Error("Environment disconnected")) {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer !== undefined) this.clock.clearInterval(this.pingTimer);
    for (const pending of this.pending.values()) {
      if (pending.kind === "request") clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) void socket.close().catch(() => {});
  }
}
