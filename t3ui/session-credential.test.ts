import { expect, test } from "nsh/test";
import { Storage } from "nsh";
import { forgetSessionBearer, loadSessionBearer, migrateLegacySessionBearer, saveSessionBearer } from "./backend/sessionCredential";
import { createFakeKeychain } from "./backend/fakeKeychain";
import { useSecureStorageForTest } from "./environments/connectionCatalog";

test("a session bearer is kept per environment in the Keychain and can be forgotten", async () => {
  const keychain = createFakeKeychain();
  useSecureStorageForTest(keychain.storage);
  try {
    const a = "ws://127.0.0.1:3777/ws";
    const b = "ws://127.0.0.1:4777/ws";
    expect(await loadSessionBearer(a)).toBe(null);
    await saveSessionBearer(a, "bearer-a");
    await saveSessionBearer(b, "bearer-b");
    expect(await loadSessionBearer(a)).toBe("bearer-a");
    expect(await loadSessionBearer(b)).toBe("bearer-b");
    // Nothing is in plain storage, and no token on argv.
    expect(await Storage.getItem(`sessionBearer:${a}`)).toBe(null);
    expect(keychain.argvLog.flat().some((word) => word.includes("bearer-"))).toBe(false);
    // A restart reads the same Keychain.
    useSecureStorageForTest(keychain.storage);
    expect(await loadSessionBearer(b)).toBe("bearer-b");
    await forgetSessionBearer(a);
    expect(await loadSessionBearer(a)).toBe(null);
    expect(await loadSessionBearer(b)).toBe("bearer-b");
    await forgetSessionBearer(b);
  } finally {
    useSecureStorageForTest(null);
  }
});

test("a bearer an earlier version kept in plain storage moves into the Keychain once", async () => {
  const keychain = createFakeKeychain();
  useSecureStorageForTest(keychain.storage);
  try {
    const url = "wss://old.example.com/ws";
    await Storage.setItem(`sessionBearer:${url}`, "legacy-token");
    expect(await loadSessionBearer(url)).toBe("legacy-token");
    expect(await Storage.getItem(`sessionBearer:${url}`)).toBe(null);
    useSecureStorageForTest(keychain.storage);
    expect(await loadSessionBearer(url)).toBe("legacy-token");
    // A stale plain copy next to a newer secure one is never preferred; migrating only deletes it.
    await Storage.setItem(`sessionBearer:${url}`, "stale");
    expect(await loadSessionBearer(url)).toBe("legacy-token");
    expect(await migrateLegacySessionBearer(url)).toBe("legacy-token");
    expect(await Storage.getItem(`sessionBearer:${url}`)).toBe(null);
    await Storage.setItem(`sessionBearer:${url}`, "stale");
    await forgetSessionBearer(url);
    expect(await Storage.getItem(`sessionBearer:${url}`)).toBe(null);
    expect(await loadSessionBearer(url)).toBe(null);
  } finally {
    useSecureStorageForTest(null);
  }
});

test("with secure storage unavailable a save throws the reference's error and plain storage is neither read nor written", async () => {
  const keychain = createFakeKeychain();
  keychain.unavailable = true;
  useSecureStorageForTest(keychain.storage);
  try {
    const url = "wss://nokeychain.example.com/ws";
    let message = "";
    await saveSessionBearer(url, "tok").catch((error: Error) => { message = error.message; });
    expect(message).toBe("Could not save the local connection catalog: Desktop secure storage is unavailable in this system context.");
    expect(await Storage.getItem(`sessionBearer:${url}`)).toBe(null);
    await Storage.setItem(`sessionBearer:${url}`, "plain");
    expect(await loadSessionBearer(url)).toBe(null);
    expect(await Storage.getItem(`sessionBearer:${url}`)).toBe("plain");
    await Storage.removeItem(`sessionBearer:${url}`);
  } finally {
    useSecureStorageForTest(null);
  }
});
