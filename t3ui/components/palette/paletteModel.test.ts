import { expect, test } from "nsh/test";
import { replaceServerKeybindings, resetServerConfig } from "../../pages/settings/settingsState";
import { resolvedShortcutLabels } from "./paletteModel";

test("palette badges come from the defaults until the server reports bindings, then follow its overrides", () => {
  resetServerConfig();
  expect(resolvedShortcutLabels()["usage.open"]).toBe("⌘U");
  expect(resolvedShortcutLabels()["chat.newLocal"]).toBe("⇧⌘N");
  replaceServerKeybindings([
    { command: "usage.open", shortcut: { key: "u", modKey: true, shiftKey: true } },
    { command: "commandPalette.toggle", shortcut: { key: "p", modKey: true, altKey: true } },
  ]);
  const labels = resolvedShortcutLabels();
  expect(labels["usage.open"]).toBe("⇧⌘U");
  expect(labels["commandPalette.toggle"]).toBe("⌥⌘P");
  // A command the server no longer binds shows no badge.
  expect(labels["chat.newLocal"]).toBeUndefined();
  resetServerConfig();
});

test("Triage an issue says so when the server has no scratch workspace, and never asks it to prepare", async () => {
  const { setRequestBackendForTest } = await import("../../store");
  const { startTriage } = await import("./paletteModel");
  const { toasts } = await import("../toast/toastState");
  const calls: string[] = [];
  setRequestBackendForTest(async (method) => { calls.push(method); return { environment: { environmentId: "env" } }; });
  await startTriage();
  setRequestBackendForTest(null);
  expect(calls).toEqual(["server.getConfig"]);
  const toast = toasts().find((item) => item.title === "Could not start triage");
  expect(toast?.description).toBe("This machine cannot start threads without a project. Run npx t3 triage in a terminal on that machine instead.");
});

test("Triage an issue opens its draft in the Scratch project with the playbook prompt, so the draft hero knows it (useStartTriage)", async () => {
  const { setRequestBackendForTest, applyShellEventForTest, openThread, composerDraft } = await import("../../store");
  const { startTriage } = await import("./paletteModel");
  const { isTriageDraft } = await import("../thread/DraftHero");
  const prompt = "Help me triage. Read [triage-playbook.md](/tmp/t3/triage/triage-playbook.md) first.";
  applyShellEventForTest({ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [{ id: "p-scratch", title: "Scratch", workspaceRoot: "/tmp/t3/scratch/abc" }], threads: [] } });
  const calls: string[] = [];
  setRequestBackendForTest(async (method) => {
    calls.push(method);
    if (method === "server.getConfig") return { scratchWorkspaceRoot: "/tmp/t3/scratch" };
    if (method === "server.prepareTriage") return { prompt };
    if (method === "projects.ensureScratch") return { projectId: "p-scratch" };
    return {};
  });
  await startTriage();
  setRequestBackendForTest(null);
  // The new draft also reads the project's t3.json for its env mode (applyNewThreadWorkspaceDefault).
  expect(calls.filter((method) => method !== "projects.readFile")).toEqual(["server.getConfig", "server.prepareTriage", "projects.ensureScratch"]);
  expect(openThread()?.projectId).toBe("p-scratch");
  expect(composerDraft()).toBe(prompt);
  expect(isTriageDraft("p-scratch", prompt)).toBe(true);
});
