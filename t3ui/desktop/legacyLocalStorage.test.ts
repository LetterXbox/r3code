// Fixture-byte tests for the LevelDB reader: a minimal CURRENT + MANIFEST (no live tables; tags 2/3/4 required by the
// reader) + one `.log` file holding a single write batch, encoded by hand the same way LevelDB would. No real
// directory or home dir is touched: `LegacyFs` is a plain in-memory map.
import { expect, test } from "nsh/test";
import { ChromiumLocalStorageReadError, crc32c, maskCrc, readChromiumLocalStorage, type LegacyFs } from "./legacyLocalStorage";

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

function encodeLengthPrefixed(bytes: readonly number[]): number[] {
  return [...encodeVarint(bytes.length), ...bytes];
}

function encodeChromiumString(text: string): number[] {
  const utf16 = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    utf16[index * 2] = code & 0xff;
    utf16[index * 2 + 1] = (code >>> 8) & 0xff;
  }
  return [0, ...utf16]; // 0 = UTF-16LE, matching Chromium's own prefix.
}

function encodeLogRecord(type: number, payload: readonly number[]): number[] {
  const typeAndPayload = [type, ...payload];
  const bytes = new Uint8Array(typeAndPayload);
  const crc = maskCrc(crc32c(bytes));
  const header = [crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff, payload.length & 0xff, (payload.length >>> 8) & 0xff, type];
  return [...header, ...payload];
}

function u64le(value: number): number[] {
  // Values here are all small test sequence numbers; no need for the full 64-bit split the reader supports.
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff, 0, 0, 0, 0];
}
function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function buildManifest(logNumber: number): Uint8Array {
  const record = [...encodeVarint(2), ...encodeVarint(logNumber), ...encodeVarint(3), ...encodeVarint(1), ...encodeVarint(4), ...encodeVarint(1)];
  return new Uint8Array(encodeLogRecord(1, record));
}

/** One write-batch log record `PUT`ting `_${origin}\0<Chromium-string key>` -> a UTF-16LE Chromium string, for each
 * pair. The `_${origin}\0` part is raw ASCII (Chromium's own LevelDB key prefix); the key *after* it is itself a
 * Chromium string (type byte + encoded bytes), same as the value — easy to miss since only the value looks encoded
 * at a glance. */
function buildLog(origin: string, entries: ReadonlyArray<[string, string]>): Uint8Array {
  const prefix = [..."_" + origin + "\u0000"].map((char) => char.charCodeAt(0));
  const records: number[] = [];
  for (const [key, value] of entries) {
    const keyBytes = [...prefix, ...encodeChromiumString(key)];
    records.push(1, ...encodeLengthPrefixed(keyBytes), ...encodeLengthPrefixed(encodeChromiumString(value)));
  }
  const batch = [...u64le(0), ...u32le(entries.length), ...records];
  return new Uint8Array(encodeLogRecord(1, batch));
}

function fixtureFs(origin: string, entries: ReadonlyArray<[string, string]>): LegacyFs {
  const files = new Map<string, Uint8Array>([
    ["CURRENT", new TextEncoder().encode("MANIFEST-000001\n")],
    ["MANIFEST-000001", buildManifest(1)],
    ["000001.log", buildLog(origin, entries)],
  ]);
  return {
    readFile: async (name) => files.get(name) ?? null,
    readdir: async () => [...files.keys()],
  };
}

const ORIGIN = "t3code://app";

test("reads two keys out of a fixture LevelDB directory, scoped to the origin prefix", async () => {
  const fs = fixtureFs(ORIGIN, [
    ["t3code:prompt-stash:v2", JSON.stringify({ version: 2, state: { entries: [{ id: "a", createdAt: "2024-01-01", prompt: "hi" }] } })],
    ["t3code:theme", "dark"],
  ]);
  const items = await readChromiumLocalStorage(fs, "fixture-dir", ORIGIN);
  expect(items.size).toBe(2);
  expect(JSON.parse(items.get("t3code:prompt-stash:v2")!).state.entries[0].id).toBe("a");
  expect(items.get("t3code:theme")).toBe("dark");
});

test("ignores entries under a different origin", async () => {
  const fs = fixtureFs("t3code-dev://app", [["t3code:theme", "dark"]]);
  const items = await readChromiumLocalStorage(fs, "fixture-dir", ORIGIN);
  expect(items.size).toBe(0);
});

test("a missing CURRENT throws ChromiumLocalStorageReadError (caller decides retry vs. nothing-to-import)", async () => {
  const fs: LegacyFs = { readFile: async () => null, readdir: async () => [] };
  await expect(readChromiumLocalStorage(fs, "fixture-dir", ORIGIN)).rejects.toThrow(ChromiumLocalStorageReadError);
});

test("a corrupted log record is dropped (CRC mismatch), not thrown", async () => {
  const fs = fixtureFs(ORIGIN, [["t3code:theme", "dark"]]);
  const log = await fs.readFile("000001.log");
  const corrupted = new Uint8Array(log!);
  corrupted[0] ^= 0xff; // Flip a byte of the masked CRC.
  const corruptFs: LegacyFs = { ...fs, readFile: async (name) => (name === "000001.log" ? corrupted : fs.readFile(name)) };
  const items = await readChromiumLocalStorage(corruptFs, "fixture-dir", ORIGIN);
  expect(items.size).toBe(0);
});
