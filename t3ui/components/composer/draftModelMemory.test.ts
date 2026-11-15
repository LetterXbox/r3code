import { expect, test } from "nsh/test";
import { applyConfigEventForTest, configureBackend, createThread, openThread, openThreadById, selectedModel, setComposerDraft, setSelectedModel } from "../../store";

test("a draft reopens with the model picked in it (per-draft model selection)", () => {
  configureBackend("ws://127.0.0.1:37916/ws");
  const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
  applyConfigEventForTest({ type: "snapshot", config: { providers: [
    { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, status: "ready", auth: { status: "authenticated" }, models: [model("gpt-5"), model("gpt-6")] },
  ] } });
  createThread(null);
  const first = openThread()?.id ?? "";
  setComposerDraft("keep me");
  setSelectedModel("codex", "gpt-6");
  createThread(null);
  const second = openThread()?.id ?? "";
  expect(second).not.toBe(first);
  setSelectedModel("codex", "gpt-5");
  openThreadById(first);
  expect(selectedModel()?.model).toBe("gpt-6");
  openThreadById(second);
  expect(selectedModel()?.model).toBe("gpt-5");
});

test("a draft's model pick is written to storage (draftModels)", async () => {
  const { Storage } = await import("nsh");
  const saved = await Storage.getItem("draftModels");
  expect(saved ?? "").toContain("gpt-");
});
