import { expect, test } from "nsh/test";
import {
  activationFailure,
  activationSuccess,
  isActivationRequest,
  isActivationResponse,
  pollActivationOnce,
  renderActivationClientScript,
  sendActivationRequest,
  type ActivationFs,
  type ActivationRequest,
  type ActivationResponse,
} from "./appActivation";

function memoryActivationFs(): ActivationFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    exists: async (p) => files.has(p) || dirs.has(p),
    readText: async (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    writeText: async (p, text) => { files.set(p, text); },
    mkdirp: async (p) => { dirs.add(p); },
    rename: async (a, b) => { const v = files.get(a); if (v === undefined) throw new Error("ENOENT"); files.set(b, v); files.delete(a); },
    unlink: async (p) => { if (!files.delete(p)) throw new Error("ENOENT"); },
    list: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).filter((name) => !name.includes("/")),
  };
}

/** A manual-advance replacement for `setTimeout`/`clearTimeout`: the per-request deadline inside
 * `pollActivationOnce`, fired by calling `fire()` instead of waiting out a real 15 s. */
function manualTimer() {
  let handle: { fn: () => void } | null = null;
  return {
    setTimeout: (fn: () => void) => { handle = { fn }; return handle; },
    clearTimeout: (h: unknown) => { if (handle === h) handle = null; },
    fire: () => { const h = handle; handle = null; h?.fn(); },
  };
}

test("isActivationRequest / isActivationResponse validate the wire shape", () => {
  const request: ActivationRequest = { version: 1, requestId: "r1", type: "open-workspace", workspaceRoot: "/tmp/x", platform: "darwin" };
  expect(isActivationRequest(request)).toBe(true);
  expect(isActivationRequest({ ...request, version: 2 })).toBe(false);
  expect(isActivationRequest({ ...request, workspaceRoot: "" })).toBe(false);
  expect(isActivationRequest({ ...request, platform: "amiga" })).toBe(false);
  expect(isActivationRequest(null)).toBe(false);
  expect(isActivationResponse(activationSuccess("r1", "p1", "t1"))).toBe(true);
  expect(isActivationResponse(activationFailure("r1", "internal-error", "x"))).toBe(true);
  expect(isActivationResponse({ version: 1, requestId: "r1", ok: true })).toBe(false);
});

test("a poll pass while not ready writes the heartbeat but leaves requests queued, uncalled", async () => {
  const fs = memoryActivationFs();
  const activated: number[] = [];
  const handled: ActivationRequest[] = [];
  const request: ActivationRequest = { version: 1, requestId: "r1", type: "open-workspace", workspaceRoot: "/tmp/x", platform: "darwin" };
  await fs.writeText("/h/.t3codegpui/activation/requests/r1.json", JSON.stringify(request));

  await pollActivationOnce({
    dir: "/h/.t3codegpui/activation",
    fs,
    isReady: () => false,
    activate: () => activated.push(1),
    handle: async (r) => { handled.push(r); return activationSuccess(r.requestId, "p1", "t1"); },
  });
  expect(fs.files.has("/h/.t3codegpui/activation/requests/r1.json")).toBe(true); // not ready: left queued
  expect(handled).toEqual([]);
  expect(fs.files.has("/h/.t3codegpui/activation/ready")).toBe(true); // the heartbeat still runs while not ready

  await pollActivationOnce({
    dir: "/h/.t3codegpui/activation",
    fs,
    isReady: () => true,
    activate: () => activated.push(1),
    handle: async (r) => { handled.push(r); return activationSuccess(r.requestId, "p1", "t1"); },
  });
  expect(handled).toEqual([request]);
  expect(activated).toEqual([1]);
  expect(fs.files.has("/h/.t3codegpui/activation/requests/r1.json")).toBe(false);
  const response = JSON.parse(fs.files.get("/h/.t3codegpui/activation/responses/r1.json")!);
  expect(response).toEqual(activationSuccess("r1", "p1", "t1"));
});

test("a request the handler never resolves times out at its own deadline, independent of the client's", async () => {
  const fs = memoryActivationFs();
  const timer = manualTimer();
  const request: ActivationRequest = { version: 1, requestId: "slow", type: "open-workspace", workspaceRoot: "/tmp/x", platform: "darwin" };
  await fs.writeText("/h/.t3codegpui/activation/requests/slow.json", JSON.stringify(request));

  const pending = pollActivationOnce({
    dir: "/h/.t3codegpui/activation",
    fs,
    isReady: () => true,
    activate: () => {},
    handle: () => new Promise(() => {}), // never resolves
    requestTimeoutMs: 15_000,
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  });
  // Let the poll pass drain its own sequential awaits (heartbeat write, list, read) to reach `handle` and
  // register its timeout, before simulating the 15 s deadline elapsing.
  for (let i = 0; i < 15; i++) await Promise.resolve();
  timer.fire();
  await pending;
  const response = JSON.parse(fs.files.get("/h/.t3codegpui/activation/responses/slow.json")!);
  expect(response).toEqual(activationFailure("slow", "request-timeout", "T3 Code did not finish opening the project in time."));
});

test("an invalid request file is answered as invalid-request and removed, without calling the handler", async () => {
  const fs = memoryActivationFs();
  const handled: unknown[] = [];
  await fs.writeText("/h/.t3codegpui/activation/requests/bad.json", "not json");
  await pollActivationOnce({
    dir: "/h/.t3codegpui/activation",
    fs,
    isReady: () => true,
    activate: () => {},
    handle: async (r) => { handled.push(r); return activationSuccess(r.requestId, "p", "t"); },
  });
  expect(handled).toEqual([]);
  expect(fs.files.has("/h/.t3codegpui/activation/requests/bad.json")).toBe(false);
  const response = JSON.parse(fs.files.get("/h/.t3codegpui/activation/responses/bad.json")!);
  expect(response.ok).toBe(false);
  expect(response.code).toBe("invalid-request");
});

test("sendActivationRequest reports not-running with no heartbeat or a stale one", async () => {
  const fs = memoryActivationFs();
  let now = 1_000_000;
  const common = { dir: "/h/.t3codegpui/activation", fs, workspaceRoot: "/tmp/x", platform: "darwin" as const, requestId: "r1", now: () => now, sleep: async () => {} };
  expect(await sendActivationRequest(common)).toEqual({ outcome: "not-running" });

  await fs.writeText("/h/.t3codegpui/activation/ready", JSON.stringify({ updatedAt: now - 9_000 }));
  expect(await sendActivationRequest(common)).toEqual({ outcome: "not-running" });
});

test("sendActivationRequest writes the request, then returns the app's response", async () => {
  const fs = memoryActivationFs();
  let now = 1_000_000;
  await fs.writeText("/h/.t3codegpui/activation/ready", JSON.stringify({ updatedAt: now }));
  const sendPromise = sendActivationRequest({ dir: "/h/.t3codegpui/activation", fs, workspaceRoot: "/tmp/x", platform: "darwin", requestId: "r1", now: () => now, sleep: async () => { now += 150; } });
  // Simulate the app answering shortly after the request file appears. `sendActivationRequest` awaits several
  // sequential trivial promises (read, mkdirp, write, rename) before the request file exists; drain them all.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const written = JSON.parse(fs.files.get("/h/.t3codegpui/activation/requests/r1.json")!);
  expect(written).toEqual({ version: 1, requestId: "r1", type: "open-workspace", workspaceRoot: "/tmp/x", platform: "darwin" });
  await fs.writeText("/h/.t3codegpui/activation/responses/r1.json", JSON.stringify(activationSuccess("r1", "p1", "t1")));
  const result = await sendPromise;
  expect(result).toEqual({ outcome: "handled", response: activationSuccess("r1", "p1", "t1") });
  expect(fs.files.has("/h/.t3codegpui/activation/responses/r1.json")).toBe(false);
});

test("sendActivationRequest times out when nothing ever answers", async () => {
  const fs = memoryActivationFs();
  let now = 1_000_000;
  await fs.writeText("/h/.t3codegpui/activation/ready", JSON.stringify({ updatedAt: now }));
  const result = await sendActivationRequest({ dir: "/h/.t3codegpui/activation", fs, workspaceRoot: "/tmp/x", platform: "darwin", requestId: "r1", timeoutMs: 500, pollMs: 100, now: () => now, sleep: async () => { now += 100; } });
  expect(result).toEqual({ outcome: "timed-out" });
});

test("renderActivationClientScript embeds the activation directory and the fallback exit code", () => {
  const script = renderActivationClientScript({ dir: "/h/.t3codegpui/activation" });
  expect(script).toContain('const DIR = "/h/.t3codegpui/activation";');
  expect(script).toContain("const FALLBACK_EXIT_CODE = 3;");
  expect(script).toContain("open-workspace");
});
