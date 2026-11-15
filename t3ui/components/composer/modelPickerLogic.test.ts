import { expect, test } from "nsh/test";
import { emptyLabel, initialTab, modelKey, moveHighlight, pickerRows, visibleRows } from "./modelPickerLogic";

const models = [
  { provider: "codex", model: "gpt-a", label: "Codex: GPT A" },
  { provider: "claude", model: "opus", label: "Claude: Opus" },
  { provider: "claude", model: "sonnet", label: "Claude: Sonnet" },
];

test("a tab shows its own provider and favorites shows starred rows", () => {
  const rows = pickerRows(models);
  expect(visibleRows(rows, "claude", "", new Set()).map((row) => row.model)).toEqual(["opus", "sonnet"]);
  expect(visibleRows(rows, "favorites", "", new Set([modelKey("codex", "gpt-a")])).map((row) => row.model)).toEqual(["gpt-a"]);
  expect(emptyLabel("favorites", "")).toBe("No favorites yet");
  expect(emptyLabel("claude", "")).toBe("No models found");
});

test("searching spans providers and matches every word", () => {
  const rows = pickerRows(models);
  expect(visibleRows(rows, "codex", "claude son", new Set()).map((row) => row.model)).toEqual(["sonnet"]);
  expect(visibleRows(rows, "codex", "zzz", new Set())).toEqual([]);
  expect(emptyLabel("claude", "zzz")).toBe("No models found");
});

test("the picker opens on the selected model's provider and the highlight clamps", () => {
  const rows = pickerRows(models);
  expect(initialTab(rows, { provider: "claude" })).toBe("claude");
  expect(initialTab(rows, null)).toBe("codex");
  expect(moveHighlight(0, -1, 3)).toBe(0);
  expect(moveHighlight(2, 1, 3)).toBe(2);
  expect(moveHighlight(0, 1, 0)).toBe(0);
});
