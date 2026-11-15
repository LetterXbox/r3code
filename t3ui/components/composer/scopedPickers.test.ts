import { expect, test } from "nsh/test";
import { createThread, interactionModeFor, openThread, runtimeMode, runtimeModeFor, selectedModelFor, setRuntimeMode, withThreadScope } from "../../store";
import { RUNTIME_MODES } from "../../backend/launch";

test("a side chat's mode reads and writes its own thread, not the open one", async () => {
  // A draft with content is not reused (createThread reuses an empty draft of the same project).
  createThread(null, { prompt: "side chat" });
  const side = openThread()!.id;
  createThread(null);
  const main = openThread()!.id;
  expect(main).not.toBe(side);
  const other = RUNTIME_MODES.find((mode) => mode !== runtimeMode())!;
  await withThreadScope(side, () => setRuntimeMode(other));
  expect(runtimeModeFor(side)).toBe(other);
  expect(runtimeModeFor(main)).toBe(runtimeMode());
  expect(runtimeModeFor(main)).not.toBe(other);
  expect(interactionModeFor(side)).toBe("default");
  // No models are loaded in this test: a thread with no pick has no model rather than borrowing another's.
  expect(selectedModelFor(side)).toBeNull();
});
