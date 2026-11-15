import { expect, test } from "nsh/test";
import type { SensitiveDocument } from "./recordingInput";
import { recordingKeyLabel, recordingKeysAreSensitive } from "./recordingInput";

const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

test("fm13: recordingKeyLabel renders plain keys, named keys and modifier combinations per platform", () => {
  expect(recordingKeyLabel(press("a"), true)).toBe("A");
  expect(recordingKeyLabel(press("a"), false)).toBe("A");
  expect(recordingKeyLabel(press("Enter"), true)).toBe("↵");
  expect(recordingKeyLabel(press(" "), true)).toBe("Space");
  expect(recordingKeyLabel(press("ArrowUp"), true)).toBe("↑");
  expect(recordingKeyLabel(press("k", { metaKey: true }), true)).toBe("⌘K");
  expect(recordingKeyLabel(press("k", { metaKey: true }), false)).toBe("Win + K");
  expect(recordingKeyLabel(press("k", { metaKey: true, shiftKey: true }), true)).toBe("⇧⌘K");
  expect(recordingKeyLabel(press("Meta"), true)).toBe("⌘");
  expect(recordingKeyLabel(press("Dead"), true)).toBe(null);
  expect(recordingKeyLabel(press("Unidentified"), true)).toBe(null);
  expect(recordingKeyLabel(press(""), true)).toBe(null);
});

function fakeDocument(active: { tagName: string; type?: string; shadowRoot?: unknown } | null): SensitiveDocument {
  return { activeElement: active ? { ...active, getAttribute: (name: string) => (name === "type" ? active.type ?? null : null) } : null } as SensitiveDocument;
}

test("fm13: recordingKeysAreSensitive excludes iframes, custom elements and password fields", () => {
  expect(recordingKeysAreSensitive(fakeDocument(null))).toBe(false);
  expect(recordingKeysAreSensitive(fakeDocument({ tagName: "INPUT" }))).toBe(false);
  expect(recordingKeysAreSensitive(fakeDocument({ tagName: "IFRAME" }))).toBe(true);
  expect(recordingKeysAreSensitive(fakeDocument({ tagName: "MY-WIDGET" }))).toBe(true);
  expect(recordingKeysAreSensitive(fakeDocument({ tagName: "INPUT", type: "password" }))).toBe(true);
  expect(recordingKeysAreSensitive(fakeDocument({ tagName: "INPUT", type: "PASSWORD" }))).toBe(true);
});
