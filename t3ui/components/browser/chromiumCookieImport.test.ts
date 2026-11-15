// readChromiumCookiesFromBytes against the fixture needs no decryption (its one real row is plaintext), so that part
// of this file tests schema-version plumbing and the CHIPS-partition skip. decryptChromiumValueMac's actual crypto is
// tested separately with a real encrypt/decrypt round trip through WebCrypto, matching OSCrypt's algorithm
// (PBKDF2-SHA1/1003 iterations -> AES-128-CBC, fixed IV of 16 spaces, "v10" prefix, schema>=24 domain-hash binding).
import { expect, test } from "nsh/test";
import type { DesktopRuntime, RunResult } from "../../desktop/runtime";
import { ChromiumKeyError, decryptChromiumValueMac, readChromiumCookiesFromBytes, readKeychainSecret, resolveChromiumKey } from "./chromiumCookieImport";
import { CHROMIUM_FIXTURE_BASE64 } from "./cookieImportFixtures";

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

function fakeRuntime(run: (command: string, args: string[]) => Promise<RunResult>): DesktopRuntime {
  const notImplemented = () => { throw new Error("not implemented in this fake"); };
  return {
    run: (command, args) => run(command, args),
    spawn: notImplemented, writeFile: notImplemented, readFile: notImplemented, mkdir: notImplemented,
    unlink: notImplemented, fileSize: notImplemented, readdir: notImplemented, mtime: notImplemented, rename: notImplemented,
    openUrl: notImplemented, getItem: notImplemented, setItem: notImplemented,
    os: () => "macos", dataDir: () => null, homeDir: () => "/Users/u", randomId: () => "id", now: () => new Date(0),
  };
}

test("readChromiumCookiesFromBytes: the plaintext row comes through with its schema-version-24 columns decoded", () => {
  return readChromiumCookiesFromBytes(bytes(CHROMIUM_FIXTURE_BASE64), new Uint8Array(16)).then((result) => {
    expect(result.cookies.length).toBe(1);
    const cookie = result.cookies[0]!;
    expect(cookie.name).toBe("sid");
    expect(cookie.value).toBe("plainvalue");
    expect(cookie.domain).toBe(".example.com");
    expect(cookie.url).toBe("https://example.com/");
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
  });
});

test("readChromiumCookiesFromBytes: a partitioned (CHIPS) row is reported undecryptable, not imported", () => {
  return readChromiumCookiesFromBytes(bytes(CHROMIUM_FIXTURE_BASE64), new Uint8Array(16)).then((result) => {
    expect(result.undecryptable).toBe(1);
    expect(result.undecryptableHosts).toEqual(["partitioned.example.com"]);
    expect(result.cookies.some((c) => c.name === "part")).toBe(false);
  });
});

test("readKeychainSecret: a zero exit returns the trimmed password", async () => {
  const runtime = fakeRuntime(async (command, args) => {
    expect(command).toBe("/usr/bin/security");
    expect(args).toEqual(["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"]);
    return { code: 0, stdout: "the-secret\n", stderr: "" };
  });
  expect(await readKeychainSecret(runtime, "Chrome Safe Storage", "Chrome")).toBe("the-secret");
});

test("readKeychainSecret: a 'could not be found' stderr reports keychainItemMissing, not a generic approval prompt", async () => {
  const runtime = fakeRuntime(async () => ({ code: 44, stdout: "", stderr: "security: item could not be found in the keychain." }));
  await expect(readKeychainSecret(runtime, "s", "a")).rejects.toThrow(ChromiumKeyError);
  try {
    await readKeychainSecret(runtime, "s", "a");
    throw new Error("expected to throw");
  } catch (error) {
    expect(error instanceof ChromiumKeyError && error.reason).toBe("keychainItemMissing");
  }
});

test("readKeychainSecret: a non-zero exit with no 'not found' message reports needsKeychainApproval", async () => {
  const runtime = fakeRuntime(async () => ({ code: 1, stdout: "", stderr: "User interaction is not allowed." }));
  try {
    await readKeychainSecret(runtime, "s", "a");
    throw new Error("expected to throw");
  } catch (error) {
    expect(error instanceof ChromiumKeyError && error.reason).toBe("needsKeychainApproval");
  }
});

test("readKeychainSecret: the child process itself failing to run reports keychainUnavailable", async () => {
  const runtime = fakeRuntime(async () => { throw new Error("spawn failed"); });
  try {
    await readKeychainSecret(runtime, "s", "a");
    throw new Error("expected to throw");
  } catch (error) {
    expect(error instanceof ChromiumKeyError && error.reason).toBe("keychainUnavailable");
  }
});

test("decryptChromiumValueMac: round-trips a schema>=24 domain-bound v10 value through real WebCrypto", async () => {
  const runtime = fakeRuntime(async () => ({ code: 0, stdout: "test-os-crypt-secret\n", stderr: "" }));
  const key = await resolveChromiumKey(runtime, "Chrome Safe Storage", "Chrome");
  const domain = ".example.com";
  const domainHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain)));
  const plaintext = new Uint8Array([...domainHash, ...new TextEncoder().encode("secret-value")]);
  const iv = new Uint8Array(16).fill(0x20);
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, plaintext));
  const encrypted = new Uint8Array([...new TextEncoder().encode("v10"), ...cipher]);
  expect(await decryptChromiumValueMac(encrypted, key, domain, 24)).toBe("secret-value");
});

test("decryptChromiumValueMac: a schema>=24 value bound to a different domain fails to decrypt (returns null)", async () => {
  const runtime = fakeRuntime(async () => ({ code: 0, stdout: "test-os-crypt-secret\n", stderr: "" }));
  const key = await resolveChromiumKey(runtime, "Chrome Safe Storage", "Chrome");
  const wrongHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(".other.com")));
  const plaintext = new Uint8Array([...wrongHash, ...new TextEncoder().encode("secret-value")]);
  const iv = new Uint8Array(16).fill(0x20);
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, plaintext));
  const encrypted = new Uint8Array([...new TextEncoder().encode("v10"), ...cipher]);
  expect(await decryptChromiumValueMac(encrypted, key, ".example.com", 24)).toBeNull();
});

test("decryptChromiumValueMac: v11 (Linux keyring) is never produced on macOS, so it is reported undecryptable", async () => {
  const encrypted = new TextEncoder().encode("v11-some-linux-only-payload");
  expect(await decryptChromiumValueMac(encrypted, new Uint8Array(16), ".example.com", 24)).toBeNull();
});

test("decryptChromiumValueMac: an empty value decrypts to an empty string without touching the key", async () => {
  expect(await decryptChromiumValueMac(new Uint8Array(0), new Uint8Array(16), ".example.com", 24)).toBe("");
});
