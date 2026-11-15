import { expect, test } from "nsh/test";
import { createFakeKeychain } from "./backend/fakeKeychain";
import { CHUNK_SIZE, keychainServiceName } from "./backend/secureStorage";

test("a secret round-trips through the Keychain and never reaches argv", async () => {
  const keychain = createFakeKeychain();
  await keychain.storage.set("acct", "s3cret-ünï");
  expect(await keychain.storage.get("acct")).toBe("s3cret-ünï");
  expect(keychain.stdinLog.length).toBe(1);
  expect(keychain.stdinLog[0]!.startsWith('add-generic-password -U -a "acct" -s "test-service" -w "')).toBe(true);
  // The secret only ever went down stdin: no argv holds the value or its base64.
  const encoded = btoa(unescape(encodeURIComponent("s3cret-ünï")));
  expect(keychain.argvLog.flat().some((word) => word.includes("s3cret") || word.includes(encoded))).toBe(false);
  expect(await keychain.storage.get("missing")).toBe(null);
});

test("a value past the interactive line limit is chunked and read back whole", async () => {
  const keychain = createFakeKeychain();
  const big = JSON.stringify({ values: Array.from({ length: 900 }, (_, index) => `token-${index}-${"x".repeat(20)}`) });
  await keychain.storage.set("catalog", big);
  expect(keychain.stdinLog.length).toBeGreaterThan(2);
  expect(keychain.stdinLog.every((line) => line.length < 4096)).toBe(true);
  expect(await keychain.storage.get("catalog")).toBe(big);
  // Overwriting with a short value drops the stale chunks.
  await keychain.storage.set("catalog", "small");
  expect([...keychain.items.keys()].filter((name) => name.includes("catalog")).length).toBe(1);
  expect(await keychain.storage.get("catalog")).toBe("small");
  await keychain.storage.set("catalog", "y".repeat(CHUNK_SIZE * 2));
  await keychain.storage.remove("catalog");
  expect(keychain.items.size).toBe(0);
  expect(await keychain.storage.get("catalog")).toBe(null);
});

test("a mixed-up chunk reads back as the raw head, not as a half value", async () => {
  const keychain = createFakeKeychain();
  await keychain.storage.set("catalog", "z".repeat(CHUNK_SIZE * 2));
  const tail = [...keychain.items.keys()].find((name) => name.endsWith("catalog#1"))!;
  keychain.items.set(tail, "othernonce:AAAA");
  const read = await keychain.storage.get("catalog");
  expect(read !== "z".repeat(CHUNK_SIZE * 2)).toBe(true);
  expect(/^\d+:[a-z0-9]+:/.test(read ?? "")).toBe(true);
});

test("a failing write throws, unavailable is reported, and the service name follows the data directory", async () => {
  const keychain = createFakeKeychain();
  keychain.failNextWrite = true;
  let message = "";
  await keychain.storage.set("acct", "v").catch((error: Error) => { message = error.message; });
  expect(message.startsWith("Keychain write failed")).toBe(true);
  expect(await keychain.storage.isEncryptionAvailable()).toBe(true);
  const off = createFakeKeychain();
  off.unavailable = true;
  expect(await off.storage.isEncryptionAvailable()).toBe(false);
  expect(keychainServiceName(null)).toBe("T3 Code connection catalog");
  expect(keychainServiceName("/a/b") === keychainServiceName("/a/c")).toBe(false);
  expect(keychainServiceName("/a/b")).toBe(keychainServiceName("/a/b"));
});
