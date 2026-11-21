import { expect, test } from "nsh/test";
import { nativeLanguageName, resolveLocale, resolveLocaleSelection, SYSTEM_LANGUAGE } from "./i18n/locales";
import { getActiveLocale, getFormattingLocale, m, setActiveLocale } from "./i18n/messages";
import { applyLanguageSetting } from "./i18n/runtime";
import { confirmTerminalClose } from "./components/terminal/terminalCommands";
import {
  attachConfirmDialogHost,
  confirmDialogState,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "./components/toast/confirmDialog";
import { updateSetting } from "./store";

test("resolveLocaleSelection keeps regional formatting tag for system preference", () => {
  expect(resolveLocaleSelection(SYSTEM_LANGUAGE, ["en_GB", "en-US"], ["en", "de"], "en")).toEqual({
    catalogLocale: "en",
    formattingLocale: "en-GB",
  });
  expect(resolveLocale(SYSTEM_LANGUAGE, ["zh-Hant-TW", "ja"], ["en", "zh", "ja"], "en")).toBe("ja");
  expect(resolveLocale("fr", ["en-US"], ["en", "fr"], "en")).toBe("fr");
  expect(nativeLanguageName("pt-BR")).toBe("Português (Brasil)");
});

test("runtime loads translated catalog and resolves interpolated and plural strings", async () => {
  await applyLanguageSetting("de");
  expect(getActiveLocale()).toBe("de");
  expect(getFormattingLocale()).toBe("de");
  expect(m("Side chat")).toBe("Nebenchat");
  expect(m("This environment is managed by {organization}. Some settings and features follow its policy.", { organization: "Acme" })).toContain("Acme");
  setActiveLocale("en");
  expect(m("Side chat")).toBe("Side chat");
  expect(m("{count, plural, =0 {none} one {# item} other {# items}}", { count: 1 })).toBe("1 item");
  expect(m("{count, plural, =0 {none} one {# item} other {# items}}", { count: 3 })).toBe("3 items");
});

test("confirmTerminalClose skips dialog when setting is disabled", async () => {
  const detach = attachConfirmDialogHost();
  try {
    updateSetting("confirmTerminalClose", false);
    expect(await confirmTerminalClose(["zsh"])).toBe(true);
    expect(confirmDialogState().status).toBe("idle");

    updateSetting("confirmTerminalClose", true);
    const pending = confirmTerminalClose(["zsh"]);
    expect(confirmDialogState().status).toBe("confirming");
    respondToConfirmDialog(false);
    expect(await pending).toBe(false);
  } finally {
    updateSetting("confirmTerminalClose", true);
    detach();
    resetConfirmDialogForTests();
  }
});
