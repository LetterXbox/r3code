// Orchestration tests for the H6 read/write flow, all through the runtime seam (desktop/runtime.ts's DesktopRuntime)
// so no test touches a real keychain or home directory. `writeImportedCookies` is exercised through its capability
// gate rather than a real webview: this test environment has no native NSH host, so `desktopHostCapabilities()`
// resolves to an empty set and the gate reports `sessionUnavailable`, which is exactly the behavior documented in
// browserCookieImport.ts for every build today (no host implements nsh-host-patches/0022 yet).
import { expect, test } from "nsh/test";
import type { DesktopRuntime, RunResult } from "../../desktop/runtime";
import { BrowserCookieImportError, readSourceCookies, resolveCookieDatabasePath, resolveWritePartition, writeImportedCookies } from "./browserCookieImport";
import type { Definition } from "./browserImportDetect";
import { CHROMIUM_FIXTURE_BASE64, FIREFOX_FIXTURE_BASE64 } from "./cookieImportFixtures";

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const HOME = "/Users/u";

function fakeRuntime(files: Record<string, Uint8Array>, run?: (command: string, args: string[]) => Promise<RunResult>): DesktopRuntime {
  const notImplemented = () => { throw new Error("not implemented in this fake"); };
  return {
    run: run ?? (async () => ({ code: 0, stdout: "secret\n", stderr: "" })),
    spawn: notImplemented, writeFile: notImplemented, mkdir: notImplemented, unlink: notImplemented,
    readdir: notImplemented, mtime: notImplemented, rename: notImplemented, openUrl: notImplemented,
    getItem: notImplemented, setItem: notImplemented,
    readFile: async (path) => { const f = files[path]; if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return f; },
    fileSize: async (path) => (files[path] ? files[path]!.length : null),
    os: () => "macos", dataDir: () => null, homeDir: () => HOME, randomId: () => "id", now: () => new Date(0),
  };
}

const firefoxDef: Definition = { id: "firefox", name: "Firefox", engine: "firefox", root: (home) => `${home}/Library/Application Support/Firefox` };
const safariDef: Definition = { id: "safari", name: "Safari", engine: "safari", root: (home) => `${home}/Library/Containers/com.apple.Safari/Data/Library/Cookies` };
const chromiumDef: Definition = { id: "chrome", name: "Chrome", engine: "chromium", root: (home) => `${home}/Library/Application Support/Google/Chrome`, keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" };

test("resolveCookieDatabasePath: firefox resolves to <profile>/cookies.sqlite when it exists", async () => {
  const path = `${HOME}/Library/Application Support/Firefox/Default/cookies.sqlite`;
  const runtime = fakeRuntime({ [path]: new Uint8Array(1) });
  expect(await resolveCookieDatabasePath(runtime, firefoxDef, HOME, "Default")).toBe(path);
});

test("resolveCookieDatabasePath: chromium prefers Network/Cookies over the legacy Cookies path", async () => {
  const legacy = `${HOME}/Library/Application Support/Google/Chrome/Default/Cookies`;
  const modern = `${HOME}/Library/Application Support/Google/Chrome/Default/Network/Cookies`;
  const runtime = fakeRuntime({ [legacy]: new Uint8Array(1), [modern]: new Uint8Array(1) });
  expect(await resolveCookieDatabasePath(runtime, chromiumDef, HOME, "Default")).toBe(modern);
});

test("resolveCookieDatabasePath: no candidate exists returns undefined", async () => {
  const runtime = fakeRuntime({});
  expect(await resolveCookieDatabasePath(runtime, firefoxDef, HOME, "Default")).toBeUndefined();
});

test("readSourceCookies: dispatches firefox profiles to the plain moz_cookies reader", async () => {
  const path = `${HOME}/Library/Application Support/Firefox/Default/cookies.sqlite`;
  const runtime = fakeRuntime({ [path]: bytes(FIREFOX_FIXTURE_BASE64) });
  const result = await readSourceCookies(runtime, firefoxDef, HOME, "Default");
  expect(result.cookies.map((c) => c.name).sort()).toEqual(["session", "strict_cookie"]);
});

test("readSourceCookies: dispatches safari to the binarycookies parser and reports a bad format as readFailed", async () => {
  const path = `${HOME}/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`;
  const runtime = fakeRuntime({ [path]: new TextEncoder().encode("not a cookie jar") });
  try {
    await readSourceCookies(runtime, safariDef, HOME, ".");
    throw new Error("expected to throw");
  } catch (error) {
    expect(error instanceof BrowserCookieImportError && error.reason).toBe("readFailed");
  }
});

test("readSourceCookies: safari EPERM on the actual read reports needsFullDiskAccess (stat succeeding proves nothing)", async () => {
  const path = `${HOME}/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`;
  const runtime: DesktopRuntime = {
    ...fakeRuntime({}),
    fileSize: async () => 1,
    readFile: async () => { throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" }); },
  };
  try {
    await readSourceCookies(runtime, safariDef, HOME, ".");
    throw new Error("expected to throw");
  } catch (error) {
    expect(error instanceof BrowserCookieImportError && error.reason).toBe("needsFullDiskAccess");
  }
  void path;
});

test("readSourceCookies: dispatches chromium through the Keychain key then the sqlite reader", async () => {
  const path = `${HOME}/Library/Application Support/Google/Chrome/Default/Network/Cookies`;
  const runtime = fakeRuntime(
    { [path]: bytes(CHROMIUM_FIXTURE_BASE64) },
    async (command, args) => { expect(command).toBe("/usr/bin/security"); expect(args).toContain("Chrome Safe Storage"); return { code: 0, stdout: "secret\n", stderr: "" }; },
  );
  const result = await readSourceCookies(runtime, chromiumDef, HOME, "Default");
  expect(result.cookies.map((c) => c.name)).toEqual(["sid"]);
  expect(result.undecryptable).toBe(1);
});

test("readSourceCookies: a chromium definition missing keychain service/account reports unsupportedPlatform", async () => {
  const noKeychain: Definition = { ...chromiumDef, keychainService: undefined, keychainAccount: undefined };
  const path = `${HOME}/Library/Application Support/Google/Chrome/Default/Network/Cookies`;
  const runtime = fakeRuntime({ [path]: bytes(CHROMIUM_FIXTURE_BASE64) });
  try {
    await readSourceCookies(runtime, noKeychain, HOME, "Default");
    throw new Error("expected to throw");
  } catch (error) {
    expect(error instanceof BrowserCookieImportError && error.reason).toBe("unsupportedPlatform");
  }
});

test("readSourceCookies: no resolvable database path reports readFailed, named for the source id", async () => {
  const runtime = fakeRuntime({});
  try {
    await readSourceCookies(runtime, firefoxDef, HOME, "Missing");
    throw new Error("expected to throw");
  } catch (error) {
    expect(error instanceof BrowserCookieImportError).toBe(true);
    expect((error as Error).message).toBe("Importing cookies from firefox failed: readFailed.");
  }
});

test("writeImportedCookies: no cookies read means nothing to write, no capability check needed", async () => {
  const result = await writeImportedCookies("firefox", { cookies: [], undecryptable: 3, undecryptableHosts: ["a.example.com", "b.example.com"] }, "partition");
  expect(result).toEqual({ imported: 0, skipped: 3, skippedDomains: ["a.example.com", "b.example.com"] });
});

test("writeImportedCookies: with cookies to write but no host capability, reports sessionUnavailable rather than silently importing zero", async () => {
  const read = { cookies: [{ url: "https://example.com/", name: "sid", value: "v", domain: ".example.com", path: "/", secure: true, httpOnly: true, expirationDate: undefined, sameSite: "lax" as const }], undecryptable: 0, undecryptableHosts: [] };
  try {
    await writeImportedCookies("firefox", read, "partition");
    throw new Error("expected to throw");
  } catch (error) {
    expect(error instanceof BrowserCookieImportError && error.reason).toBe("sessionUnavailable");
  }
});

test("resolveWritePartition: the default profile writes straight into the environment's own partition", () => {
  expect(resolveWritePartition("env-1", undefined)).toBe("env-1");
  expect(resolveWritePartition("env-1", "default")).toBe("env-1");
});

test("resolveWritePartition: a non-default profile gets a distinct partition from the same environment", () => {
  const partition = resolveWritePartition("env-1", "profile-2");
  expect(partition).not.toBe("env-1");
  expect(JSON.parse(partition)).toEqual(["env-1", "profile-2"]);
});
