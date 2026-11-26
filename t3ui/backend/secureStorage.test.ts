import { expect, test } from "nsh/test";
import { createHostSecureStorage } from "./secureStorage";

test("createHostSecureStorage stores, reads, and removes values through host.call", async () => {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const storage = createHostSecureStorage({
    service: "T3 Code connection catalog (abcd1234)",
    available: () => true,
    call: async (name, data) => {
      calls.push(name);
      const payload = (data ?? {}) as { service?: string; account?: string; value?: string };
      const key = `${payload.service}\0${payload.account}`;
      if (name === "secureStorage.available") return true;
      if (name === "secureStorage.get") return store.get(key) ?? null;
      if (name === "secureStorage.set") {
        store.set(key, String(payload.value ?? ""));
        return null;
      }
      if (name === "secureStorage.remove") {
        store.delete(key);
        return null;
      }
      throw new Error(`unexpected call: ${name}`);
    },
  });

  expect(await storage.isEncryptionAvailable()).toBe(true);
  expect(await storage.get("connection-catalog")).toBeNull();
  await storage.set("connection-catalog", '{"schemaVersion":1,"credentials":[]}');
  expect(await storage.get("connection-catalog")).toBe('{"schemaVersion":1,"credentials":[]}');
  await storage.remove("connection-catalog");
  expect(await storage.get("connection-catalog")).toBeNull();
  expect(calls.filter((name) => name === "secureStorage.available").length).toBe(1);
});

test("createHostSecureStorage reports unavailable when host bridge is absent or rejects", async () => {
  const noHost = createHostSecureStorage({
    service: "svc",
    available: () => false,
    call: async () => true,
  });
  expect(await noHost.isEncryptionAvailable()).toBe(false);

  const failingHost = createHostSecureStorage({
    service: "svc",
    available: () => true,
    call: async () => { throw new Error("unsupported"); },
  });
  expect(await failingHost.isEncryptionAvailable()).toBe(false);
});
