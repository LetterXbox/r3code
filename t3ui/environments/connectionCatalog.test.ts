import { expect, test } from "nsh/test";
import { createFakeKeychain } from "../backend/fakeKeychain";
import { makeCatalogStore, makeSecureCatalogBackend } from "./connectionCatalog";

const credential = (id: string, token: string) => ({ connectionId: id, credential: { _tag: "BearerConnectionCredential" as const, token } });

test("the catalog keeps credentials in secure storage and serialises updates", async () => {
  const keychain = createFakeKeychain();
  const store = makeCatalogStore(makeSecureCatalogBackend(keychain.storage));
  expect((await store.read()).credentials).toEqual([]);
  await Promise.all([
    store.update((doc) => ({ ...doc, credentials: [...doc.credentials, credential("bearer:a", "ta")] })),
    store.update((doc) => ({ ...doc, credentials: [...doc.credentials, credential("bearer:b", "tb")] })),
  ]);
  expect((await store.read()).credentials.map((item) => item.connectionId)).toEqual(["bearer:a", "bearer:b"]);
  // A second store over the same keychain (a restart) reads what was saved.
  const reopened = makeCatalogStore(makeSecureCatalogBackend(keychain.storage));
  expect((await reopened.read()).credentials.map((item) => item.credential.token)).toEqual(["ta", "tb"]);
});

test("secure storage unavailable: a save fails with the reference's message, a read finds an empty catalog", async () => {
  const keychain = createFakeKeychain();
  keychain.unavailable = true;
  const store = makeCatalogStore(makeSecureCatalogBackend(keychain.storage));
  expect((await store.read()).credentials).toEqual([]);
  let message = "";
  await store.update((doc) => doc).catch((error: Error) => { message = error.message; });
  expect(message).toBe("Could not save the local connection catalog: Desktop secure storage is unavailable in this system context.");
});

test("an unreadable catalog stays in place until an update backs it up in the Keychain", async () => {
  const keychain = createFakeKeychain();
  const original = JSON.stringify({ schemaVersion: 2, credentials: [credential("bearer:a", "ta")] });
  await keychain.storage.set("connection-catalog", original);
  const store = makeCatalogStore(makeSecureCatalogBackend(keychain.storage));

  expect((await store.read()).credentials).toEqual([]);
  expect(await keychain.storage.get("connection-catalog")).toBe(original);
  expect(keychain.items.size).toBe(1);

  await store.update((doc) => ({ ...doc, credentials: [credential("bearer:b", "tb")] }));
  const backupKey = [...keychain.items.keys()].find((key) => key.startsWith("test-service\u0000connection-catalog.unreadable-"));
  expect(typeof backupKey).toBe("string");
  if (!backupKey) throw new Error("Missing Keychain backup");
  expect(await keychain.storage.get(backupKey.slice("test-service\u0000".length))).toBe(original);
  expect((await store.read()).credentials).toEqual([credential("bearer:b", "tb")]);
});

test("a failed backup leaves the original catalog available for retry", async () => {
  const keychain = createFakeKeychain();
  await keychain.storage.set("connection-catalog", "{not json");
  const store = makeCatalogStore(makeSecureCatalogBackend(keychain.storage));
  keychain.failNextWrite = true;
  const result = await store.update((doc) => doc).then(() => "saved", (error: unknown) => String(error));
  expect(result).toContain("Could not preserve the local connection catalog");
  expect(await keychain.storage.get("connection-catalog")).toBe("{not json");

  await store.update((doc) => doc);
  expect(JSON.parse(await keychain.storage.get("connection-catalog") ?? "null")).toEqual({ schemaVersion: 1, credentials: [] });
});

test("an incomplete Keychain item blocks replacement and leaves its remaining chunks intact", async () => {
  const keychain = createFakeKeychain();
  await keychain.storage.set("connection-catalog", "x".repeat(9000));
  expect(keychain.items.delete("test-service\u0000connection-catalog#1")).toBe(true);
  const before = [...keychain.items.entries()];
  const store = makeCatalogStore(makeSecureCatalogBackend(keychain.storage));
  const result = await store.update((doc) => doc).then(() => "saved", (error: unknown) => String(error));
  expect(result).toContain("Keychain item has incomplete data");
  expect([...keychain.items.entries()]).toEqual(before);
});
