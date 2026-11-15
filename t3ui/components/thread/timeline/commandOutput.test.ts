import { expect, test } from "nsh/test";
import { applyCommandOutputFrame, EMPTY_COMMAND_OUTPUT, readCommandOutputFrame, TERMINAL_PALETTES, terminalOutputSpans } from "./commandOutput";

test("replace resets the tail, append extends it, running:false ends it (OrchestrationV2CommandOutputFrame)", () => {
  let view = applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, { kind: "replace", text: "a\r\n", truncated: true, running: true });
  expect(view).toEqual({ text: "a\n", truncated: true, running: true });
  view = applyCommandOutputFrame(view, { kind: "append", text: "b", truncated: false, running: false });
  expect(view).toEqual({ text: "a\nb", truncated: true, running: false });
  view = applyCommandOutputFrame(view, { kind: "replace", text: "fresh", truncated: false, running: false });
  expect(view.text).toBe("fresh");
  expect(view.truncated).toBe(false);
  expect(readCommandOutputFrame({ kind: "bogus", text: "" })).toBe(null);
});

test("a bare carriage return rewrites the line and cursor escapes are dropped", () => {
  const view = applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, { kind: "replace", text: "10%\r50%\r100%\u001b[K\n", truncated: false, running: true });
  expect(view.text).toBe("100%\n");
});

test("SGR colours become spans from the terminal palette", () => {
  const spans = terminalOutputSpans("ok \u001b[31mfail\u001b[0m done", TERMINAL_PALETTES.dark);
  expect(spans).toEqual([
    { text: "ok ", style: null, color: null, bold: false },
    { text: "fail", style: { color: "#f47067" }, color: "#f47067", bold: false },
    { text: " done", style: null, color: null, bold: false },
  ]);
});

test("SGR attributes, backgrounds, 256-colour and inverse resolve like terminalOutput.ts spanStyle", () => {
  const styles = (text: string, scheme: "dark" | "light" = "dark") => terminalOutputSpans(text, TERMINAL_PALETTES[scheme]).map((span) => span.style);
  expect(styles("\u001b[1;2;3;4;9mx")).toEqual([{ fontWeight: "600", opacity: 0.65, fontStyle: "italic", textDecorationLine: "underline line-through" }]);
  expect(styles("\u001b[38;5;196mx")).toEqual([{ color: "rgb(255,0,0)" }]);
  expect(styles("\u001b[38;5;244mx")).toEqual([{ color: "rgb(128,128,128)" }]);
  expect(styles("\u001b[38;2;1;2;3mx")).toEqual([{ color: "rgb(1,2,3)" }]);
  expect(styles("\u001b[94mx", "light")).toEqual([{ color: "#0969da" }]);
  // Readable text on a badge stays; text too close to its background is replaced (contrast < 3); inverse swaps the pair.
  expect(styles("\u001b[42;30mPASS")).toEqual([{ color: "#3b4048", backgroundColor: "#57ab5a" }]);
  expect(styles("\u001b[44;34mlow")).toEqual([{ color: "#ffffff", backgroundColor: "#539bf5" }]);
  expect(styles("\u001b[7mx")).toEqual([{ backgroundColor: "#adbac7", color: "#1f2328" }]);
  expect(styles("\u001b[1mx\u001b[22my")).toEqual([{ fontWeight: "600" }, null]);
});
