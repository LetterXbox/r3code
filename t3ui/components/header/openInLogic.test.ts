import { expect, test } from "nsh/test";
import { effectiveEditor, fileManagerName, openInButtonLabel, readAvailableEditors, resolveOpenInOptions, shouldShowOpenInPicker } from "./openInLogic";

test("options keep the web's order and label the file manager for the platform", () => {
  const options = resolveOpenInOptions("macos", ["file-manager", "vscode", "zed", "cursor", "unknown"]);
  expect(options.map((option) => option.label)).toEqual(["Cursor", "VS Code", "Zed", "Finder"]);
  expect(fileManagerName("windows")).toBe("File Explorer");
  expect(fileManagerName("linux")).toBe("Files");
});

test("the preferred editor is the last used while installed, else the first installed", () => {
  expect(effectiveEditor("zed", ["vscode", "zed"])).toBe("zed");
  expect(effectiveEditor("zed", ["vscode"])).toBe("vscode");
  expect(effectiveEditor(null, ["file-manager", "vscode"])).toBe("vscode");
  expect(effectiveEditor("zed", [])).toBe(null);
  expect(openInButtonLabel({ value: "zed", label: "Zed" })).toBe("Open in Zed");
  expect(openInButtonLabel(null)).toBe("Open in editor");
});

test("available editors are read defensively from the server config", () => {
  expect(readAvailableEditors({ availableEditors: ["vscode", 3, "zed"] })).toEqual(["vscode", "zed"]);
  expect(readAvailableEditors(null)).toEqual([]);
  expect(readAvailableEditors({})).toEqual([]);
});

test("shouldShowOpenInPicker needs a project name; another machine shows it only when it can open remotely", () => {
  const base = { activeProjectName: "app", activeThreadEnvironmentId: "env-a", primaryEnvironmentId: "env-a", remoteOpenMode: "local-exec" as const };
  expect(shouldShowOpenInPicker(base)).toBe(true);
  expect(shouldShowOpenInPicker({ ...base, activeProjectName: undefined })).toBe(false);
  expect(shouldShowOpenInPicker({ ...base, activeThreadEnvironmentId: "env-b" })).toBe(false);
  expect(shouldShowOpenInPicker({ ...base, activeThreadEnvironmentId: "env-b", remoteOpenMode: "remote-links" })).toBe(true);
  expect(shouldShowOpenInPicker({ ...base, activeThreadEnvironmentId: "env-b", remoteOpenMode: "remote-unavailable" })).toBe(true);
  expect(shouldShowOpenInPicker({ ...base, primaryEnvironmentId: null, remoteOpenMode: "remote-links" })).toBe(true);
});
