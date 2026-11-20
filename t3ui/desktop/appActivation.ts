// apps/desktop/src/app/DesktopAppActivation.ts + DesktopAppActivationBroker.ts + ipc/methods/appActivation.ts,
// ported to a file-drop/poll contract: NSH's `net` module only dials out (t3ui/.nsh/types/net.d.ts `connect`), it
// cannot listen, and nsh.json grants no socket capability, so there is no Unix socket or named pipe for `t3 <path>`
// to reach a running window the way the reference's DesktopAppActivation does. `~/.t3codegpui/activation`
// (writable: it is under nsh.json's `capabilities.fs.write` entry for `${homeDir}/.t3codegpui`) stands in for that
// socket: a heartbeat file says the app is alive, and `requests/<id>.json` / `responses/<id>.json` carry the
// protocol, version 1, `open-workspace`, matching the field names in packages/contracts/src/desktopAppActivation.ts.
//
// Single-instance handoff: the reference also uses this channel so a second `t3code` launch hands its work to the
// first and exits. This port has no second-instance hook to intercept (there is no Electron `requestSingleInstance`
// equivalent here, and `tools/run_local.py` -- out of scope to edit -- is what would launch a second window), so
// only the CLI side of the handoff (`t3 <path>` -> a running window) is wired; running the launcher twice is not
// covered and is reported as a gap, not solved here.
//
// The client that writes the request is not this module: a `/bin/sh` launcher (cliCommand.ts's installed shim)
// cannot import an NSH app bundle, so the client is a hand-written plain-Node twin shipped next to the shim
// (`renderActivationClientScript` below). Keep its wire format in sync with this file's types by hand.

export const ACTIVATION_PROTOCOL_VERSION = 1 as const;
export type ActivationPlatform = "darwin" | "linux" | "win32";

export interface ActivationRequest {
  version: 1;
  requestId: string;
  type: "open-workspace";
  workspaceRoot: string;
  platform: ActivationPlatform;
}

export type ActivationErrorCode =
  | "invalid-request"
  | "renderer-unavailable"
  | "environment-unavailable"
  | "project-create-failed"
  | "thread-open-failed"
  | "request-timeout"
  | "internal-error";

export type ActivationResponse =
  | { version: 1; requestId: string; ok: true; projectId: string; threadId: string }
  | { version: 1; requestId: string; ok: false; code: ActivationErrorCode; message: string };

export function activationFailure(requestId: string, code: ActivationErrorCode, message: string): ActivationResponse {
  return { version: ACTIVATION_PROTOCOL_VERSION, requestId, ok: false, code, message };
}

export function activationSuccess(requestId: string, projectId: string, threadId: string): ActivationResponse {
  return { version: ACTIVATION_PROTOCOL_VERSION, requestId, ok: true, projectId, threadId };
}

const REQUEST_ID_PATTERN = /^[\w-]{1,128}$/;

export function isActivationRequest(value: unknown): value is ActivationRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === ACTIVATION_PROTOCOL_VERSION
    && typeof v.requestId === "string" && REQUEST_ID_PATTERN.test(v.requestId)
    && v.type === "open-workspace"
    && typeof v.workspaceRoot === "string" && v.workspaceRoot.trim().length > 0
    && (v.platform === "darwin" || v.platform === "linux" || v.platform === "win32");
}

export function isActivationResponse(value: unknown): value is ActivationResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== ACTIVATION_PROTOCOL_VERSION || typeof v.requestId !== "string" || v.requestId.length === 0) return false;
  if (v.ok === true) return typeof v.projectId === "string" && typeof v.threadId === "string";
  return v.ok === false && typeof v.code === "string" && typeof v.message === "string";
}

/** `fs/promises`-shaped so the real implementation and tests share one interface with cliCommand.ts's `CliFs`. */
export interface ActivationFs {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Basenames; `[]` when the directory does not exist. */
  list(dir: string): Promise<string[]>;
}

const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

async function writeAtomic(fs: ActivationFs, dir: string, file: string, text: string, randomId: () => string): Promise<void> {
  await fs.mkdirp(dir);
  const staging = `${file}.${randomId()}.tmp`;
  await fs.writeText(staging, text);
  await fs.rename(staging, file);
}

export interface ActivationDirs { readonly base: string; readonly requests: string; readonly responses: string; readonly ready: string }

export function activationDirs(base: string): ActivationDirs {
  return { base, requests: join(base, "requests"), responses: join(base, "responses"), ready: join(base, "ready") };
}

// ---------------------------------------------------------------------------------------------------------------
// App side: DesktopAppActivation.start + the renderer-ready handshake, folded into one poll loop since this port
// has no separate main/renderer split to hand the request across.
// ---------------------------------------------------------------------------------------------------------------

export interface ActivationListener { stop(): void }

export interface ActivationPollDeps {
  readonly dir: string;
  readonly fs: ActivationFs;
  /** setRendererReady's equivalent: requests wait, undeleted, until this is true. */
  readonly isReady: () => boolean;
  /** DesktopWindow.activate. */
  readonly activate: () => void;
  readonly handle: (request: ActivationRequest) => Promise<ActivationResponse>;
  readonly requestTimeoutMs?: number;
  readonly randomId?: () => string;
  readonly now?: () => number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly onError?: (error: unknown) => void;
}

const defaultRandomId = () => Math.random().toString(16).slice(2);

/** One pass: write the heartbeat, then -- only once ready -- answer every request currently on disk, each under its
 * own `requestTimeoutMs` deadline (default 15 s, DesktopAppActivationBroker's `REQUEST_TIMEOUT_MS`). Awaits every
 * request it starts, so a caller (a test, or `startActivationListener`'s interval) can tell when a pass settles. */
export async function pollActivationOnce(input: ActivationPollDeps): Promise<void> {
  const dirs = activationDirs(input.dir);
  const requestTimeoutMs = input.requestTimeoutMs ?? 15_000;
  const randomId = input.randomId ?? defaultRandomId;
  const now = input.now ?? (() => Date.now());
  const setTimeoutFn = input.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = input.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const onError = input.onError ?? (() => {});

  const respond = async (requestId: string, response: ActivationResponse) => {
    try {
      await writeAtomic(input.fs, dirs.responses, join(dirs.responses, `${requestId}.json`), JSON.stringify(response), randomId);
    } catch (error) {
      // The client's own timeout covers a response that never lands.
      onError(error);
    }
  };

  const withTimeout = (request: ActivationRequest): Promise<ActivationResponse> =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeoutFn(() => {
        if (settled) return;
        settled = true;
        resolve(activationFailure(request.requestId, "request-timeout", "T3 Code did not finish opening the project in time."));
      }, requestTimeoutMs);
      input.handle(request).then(
        (response) => { if (!settled) { settled = true; clearTimeoutFn(timer); resolve(response); } },
        () => { if (!settled) { settled = true; clearTimeoutFn(timer); resolve(activationFailure(request.requestId, "internal-error", "T3 Code could not process the desktop app request.")); } },
      );
    });

  const processOne = async (name: string) => {
    const file = join(dirs.requests, name);
    try {
      const text = await input.fs.readText(file);
      const fallbackId = name.replace(/\.json$/, "");
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        await respond(fallbackId, activationFailure(fallbackId, "invalid-request", "The desktop app request is not valid JSON."));
        await input.fs.unlink(file).catch(() => undefined);
        return;
      }
      if (!isActivationRequest(parsed)) {
        const requestId = typeof (parsed as { requestId?: unknown })?.requestId === "string" ? (parsed as { requestId: string }).requestId : fallbackId;
        await respond(requestId, activationFailure(requestId, "invalid-request", "The desktop app request is invalid."));
        await input.fs.unlink(file).catch(() => undefined);
        return;
      }
      input.activate();
      const response = await withTimeout(parsed);
      await respond(parsed.requestId, response);
      await input.fs.unlink(file).catch(() => undefined);
    } catch (error) {
      onError(error);
      await input.fs.unlink(file).catch(() => undefined);
    }
  };

  try {
    await writeAtomic(input.fs, dirs.base, dirs.ready, JSON.stringify({ updatedAt: now() }), randomId);
  } catch (error) {
    onError(error);
  }
  if (!input.isReady()) return; // DesktopAppActivation.setRendererReady(false): leave files queued.
  let names: string[];
  try { names = await input.fs.list(dirs.requests); } catch (error) { onError(error); return; }
  await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => processOne(name)));
}

export function startActivationListener(input: ActivationPollDeps & {
  readonly pollMs?: number;
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}): ActivationListener {
  const pollMs = input.pollMs ?? 400;
  const setIntervalFn = input.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = input.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let running = false;
  const tick = () => {
    if (running) return; // one pass in flight at a time; a slow handler never piles up pollers.
    running = true;
    void pollActivationOnce(input).finally(() => { running = false; });
  };
  const timer = setIntervalFn(tick, pollMs);
  tick();
  return { stop: () => clearIntervalFn(timer) };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI side: apps/server/src/cli/app.ts's sendDesktopAppActivationRequest, ported to the same files. Exported for
// its own tests; the shipped shim uses the plain-Node twin below instead, since it cannot import this module.
// ---------------------------------------------------------------------------------------------------------------

export type ActivationSendResult =
  | { readonly outcome: "handled"; readonly response: ActivationResponse }
  /** No fresh heartbeat: nothing is listening. The caller falls back to its own launch path. */
  | { readonly outcome: "not-running" }
  | { readonly outcome: "timed-out" };

export async function sendActivationRequest(input: {
  readonly dir: string;
  readonly fs: ActivationFs;
  readonly workspaceRoot: string;
  readonly platform: ActivationPlatform;
  readonly requestId: string;
  readonly readyStaleMs?: number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly randomId?: () => string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<ActivationSendResult> {
  const dirs = activationDirs(input.dir);
  const readyStaleMs = input.readyStaleMs ?? 8_000;
  const timeoutMs = input.timeoutMs ?? 17_000;
  const pollMs = input.pollMs ?? 150;
  const randomId = input.randomId ?? (() => Math.random().toString(16).slice(2));
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let heartbeat: unknown;
  try { heartbeat = JSON.parse(await input.fs.readText(dirs.ready)); } catch { return { outcome: "not-running" }; }
  const updatedAt = typeof heartbeat === "object" && heartbeat !== null ? (heartbeat as { updatedAt?: unknown }).updatedAt : undefined;
  if (typeof updatedAt !== "number" || now() - updatedAt > readyStaleMs) return { outcome: "not-running" };

  const request: ActivationRequest = { version: ACTIVATION_PROTOCOL_VERSION, requestId: input.requestId, type: "open-workspace", workspaceRoot: input.workspaceRoot, platform: input.platform };
  await writeAtomic(input.fs, dirs.requests, join(dirs.requests, `${input.requestId}.json`), JSON.stringify(request), randomId);

  const responseFile = join(dirs.responses, `${input.requestId}.json`);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const text = await input.fs.readText(responseFile);
      await input.fs.unlink(responseFile).catch(() => undefined);
      const parsed: unknown = JSON.parse(text);
      if (isActivationResponse(parsed) && parsed.requestId === input.requestId) return { outcome: "handled", response: parsed };
    } catch { /* not written yet */ }
    await sleep(pollMs);
  }
  return { outcome: "timed-out" };
}

/** The exit code `renderActivationClientScript` uses to mean "nothing is listening; the caller should fall back to
 * its own launch path" -- distinct from 0 (handled, success) and 1 (handled-but-failed, or timed out: a live app
 * exists and should not be raced with a second launch). cliCommand.ts's shim checks for exactly this code. */
export const ACTIVATION_CLIENT_FALLBACK_EXIT_CODE = 3;

/**
 * DesktopAppActivation's client, as plain Node (no imports beyond `node:*`) so a `/bin/sh` launcher can run it with
 * the system `node` the shim already resolves (`CliEnvironment.node`), without bundling an NSH app. Mirrors
 * `sendActivationRequest` above field for field; keep the two in sync by hand (`appActivation.test.ts` pins both).
 */
export function renderActivationClientScript(input: { readonly dir: string }): string {
  const dir = JSON.stringify(input.dir);
  return `#!/usr/bin/env node
// Written by T3 Code: hands a workspace path to a running window before the CLI falls back to its own launch.
// Twin of t3ui/desktop/appActivation.ts's sendActivationRequest; keep the wire format in sync by hand.
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

const DIR = ${dir};
const REQUESTS = DIR + "/requests";
const RESPONSES = DIR + "/responses";
const READY = DIR + "/ready";
const READY_STALE_MS = 8000;
const TIMEOUT_MS = 17000;
const POLL_MS = 150;
const FALLBACK_EXIT_CODE = ${ACTIVATION_CLIENT_FALLBACK_EXIT_CODE};

function platformOf(uname) {
  if (uname === "Darwin") return "darwin";
  if (uname === "Linux") return "linux";
  return "win32";
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  const workspaceRoot = process.argv[2];
  const uname = process.argv[3] || "";
  if (!workspaceRoot) process.exit(FALLBACK_EXIT_CODE);

  let heartbeat;
  try { heartbeat = JSON.parse(readFileSync(READY, "utf8")); } catch { process.exit(FALLBACK_EXIT_CODE); }
  if (typeof heartbeat.updatedAt !== "number" || Date.now() - heartbeat.updatedAt > READY_STALE_MS) {
    process.exit(FALLBACK_EXIT_CODE);
  }

  mkdirSync(REQUESTS, { recursive: true, mode: 0o700 });
  mkdirSync(RESPONSES, { recursive: true, mode: 0o700 });
  const requestId = randomBytes(12).toString("hex");
  const request = { version: 1, requestId, type: "open-workspace", workspaceRoot, platform: platformOf(uname) };
  const file = REQUESTS + "/" + requestId + ".json";
  const staging = file + "." + randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(staging, JSON.stringify(request));
  renameSync(staging, file);

  const responseFile = RESPONSES + "/" + requestId + ".json";
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(responseFile, "utf8");
      try { unlinkSync(responseFile); } catch {}
      const response = JSON.parse(text);
      if (response.requestId === requestId && response.ok === true) {
        console.log("Opened " + workspaceRoot + " in T3 Code.");
        process.exit(0);
      }
      if (response.requestId === requestId) {
        console.error("T3 Code could not open " + workspaceRoot + " (" + response.code + ").");
        process.exit(1);
      }
    } catch { /* not written yet */ }
    await sleep(POLL_MS);
  }
  console.error("The desktop app did not respond in time.");
  process.exit(1);
}

main();
`;
}
