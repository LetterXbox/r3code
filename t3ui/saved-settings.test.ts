import { expect, test } from "nsh/test";
import { validSavedSettings } from "./store";

test("a saved setting is restored only with the type of its field", () => {
  const defaults = { sidebarProjectGroupingMode: "repository", boringSidebarEnabled: false, fontSize: 16 };
  const saved = { sidebarProjectGroupingMode: false, boringSidebarEnabled: true, fontSize: "16", colorScheme: "dark", junk: { a: 1 } };
  expect(validSavedSettings(saved, defaults)).toEqual({ boringSidebarEnabled: true, colorScheme: "dark" });
});

import { acceptsSavedSetting, clientDefaults, defaultOfSetting, scopeOfSetting, settingOverrides, validSavedValues } from "./pages/settings/settingsDefaults";
import { readSetting } from "./pages/settings/settingsSync";
import { resetServerConfig } from "./pages/settings/settingsState";
import { restoreSavedSettings, settingValue, updateSetting } from "./store";

test("only values that differ from their default are persisted", () => {
  const defaults = { chatWidth: "standard", wordWrap: false, fontSize: 14 };
  expect(settingOverrides({ chatWidth: "standard", wordWrap: true, fontSize: 14, colorScheme: "dark" }, defaults))
    .toEqual({ wordWrap: true, colorScheme: "dark" });
});

test("a saved value equal to its default is not restored as an override", () => {
  expect(validSavedValues({ wordWrap: false, chatWidth: "wide" }, { wordWrap: false, chatWidth: "standard" })).toEqual({ chatWidth: "wide" });
});

test("scope follows the contracts: client keys are local, server keys belong to the server", () => {
  expect(scopeOfSetting("chatWidth")).toBe("client");
  expect(scopeOfSetting("followUpBehavior")).toBe("client");
  expect(scopeOfSetting("responseStreamingMode")).toBe("server");
  expect(scopeOfSetting("sidebarAutoSettleAfterDays")).toBe("server");
  expect(scopeOfSetting("defaultRuntimeMode")).toBe("server");
  expect(Object.keys(clientDefaults()).includes("responseStreamingMode")).toBe(false);
  expect(clientDefaults().timestampFormat).toBe("locale");
});

test("a saved server setting is not restored from the local blob", () => {
  expect(acceptsSavedSetting("responseStreamingMode", "turn")).toBe(false);
  expect(validSavedValues({ responseStreamingMode: "turn", chatWidth: "wide" }, {})).toEqual({ chatWidth: "wide" });
});

test("a saved select value must be one of the row's options", () => {
  expect(acceptsSavedSetting("timestampFormat", "12-hour")).toBe(true);
  expect(acceptsSavedSetting("timestampFormat", "sideways")).toBe(false);
  expect(acceptsSavedSetting("sidebarProjectGroupingMode", "repository_path")).toBe(true);
  expect(acceptsSavedSetting("sidebarProjectGroupingMode", "nonsense")).toBe(false);
});

test("a server setting reads its default, not the local blob, until the server reports", () => {
  resetServerConfig();
  restoreSavedSettings(JSON.stringify({ responseStreamingMode: "turn", timestampFormat: "24-hour", sidebarAutoSettleAfterDays: "7" }));
  expect(readSetting("responseStreamingMode", "server")).toBe(defaultOfSetting("responseStreamingMode"));
  expect(settingValue("responseStreamingMode")).toBe(defaultOfSetting("responseStreamingMode"));
  expect(settingValue("timestampFormat")).toBe("24-hour");
  // The wrong scope from a caller is corrected by the field's own scope.
  expect(readSetting("timestampFormat", "server")).toBe("24-hour");
  updateSetting("timestampFormat", "locale");
  expect(settingValue("timestampFormat")).toBe("locale");
});

import { Storage } from "nsh";

test("updateSetting persists the overrides only", async () => {
  updateSetting("chatWidth", "wide");
  updateSetting("diffIgnoreWhitespace", false);
  updateSetting("diffIgnoreWhitespace", true);
  const blob = JSON.parse((await Storage.getItem("settings")) ?? "{}");
  expect(blob.chatWidth).toBe("wide");
  expect("diffIgnoreWhitespace" in blob).toBe(false);
  expect("timestampFormat" in blob).toBe(false);
});
