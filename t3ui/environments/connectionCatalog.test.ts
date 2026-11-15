import { expect, test } from "nsh/test";
import { createFakeKeychain } from "../backend/fakeKeychain";
import { makeCatalogStore, makeSecureCatalogBackend, type CatalogBackend } from "./connectionCatalog";

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

test("a corrupt catalog is discarded: warned, replaced by the empty catalog, persisted, read as empty", async () => {
  const keychain = createFakeKeychain();
  await keychain.storage.set("connection-catalog", "{not json");
  const warned: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    const store = makeCatalogStore(makeSecureCatalogBackend(keychain.storage));
    expect((await store.read()).credentials).toEqual([]);
  } finally {
    console.warn = original;
  }
  expect(warned.length).toBe(1);
  expect(warned[0]![0]).toBe("Discarding a corrupt web connection catalog.");
  expect(JSON.parse((await keychain.storage.get("connection-catalog"))!)).toEqual({ schemaVersion: 1, credentials: [] });
  // A valid JSON of the wrong shape is corrupt too; the backend with a quarantine keeps the raw text aside.
  const kept: string[] = [];
  let stored: string | null = JSON.stringify({ schemaVersion: 2, credentials: [] });
  const backend: CatalogBackend = { read: async () => stored, write: async (raw) => { stored = raw; }, quarantine: async (raw) => { kept.push(raw); } };
  const quiet = console.warn;
  console.warn = () => undefined;
  try { expect((await makeCatalogStore(backend).read()).credentials).toEqual([]); } finally { console.warn = quiet; }
  expect(kept).toEqual([JSON.stringify({ schemaVersion: 2, credentials: [] })]);
  expect(stored).toBe(JSON.stringify({ schemaVersion: 1, credentials: [] }));
});

test("a recovery write that fails is only warned about", async () => {
  const backend: CatalogBackend = { read: async () => "garbage", write: async () => { throw new Error("disk full"); } };
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(String(args[0])); };
  try { expect((await makeCatalogStore(backend).read()).credentials).toEqual([]); } finally { console.warn = original; }
  expect(warned).toEqual(["Discarding a corrupt web connection catalog.", "Could not persist the recovered web connection catalog."]);
});
