// Every select shows the reference's option labels, never the raw stored value.
import { expect, test } from "nsh/test";
import { SETTINGS_PANELS } from "../../settingsPanels";
import { resolveControl } from "./controlSpecs";

// Each label as the reference component renders it (field -> value -> label).
const REFERENCE: Record<string, Record<string, string>> = {
  // threadNotifications.ts NOTIFICATION_MODE_LABELS
  notificationMode: { off: "Off", notifications: "Notifications only", sound: "Sound only", "notifications-and-sound": "Notifications with sound" },
  // sidebarProjectGrouping.ts PROJECT_GROUPING_MODE_LABELS
  sidebarProjectGroupingMode: { repository: "Group by repository", repository_path: "Group by repository path", separate: "Keep separate" },
  // BranchNamingSettings.tsx MODES
  branchNamingMode: { static: "Static prefix", semantic: "Semantic prefix", custom: "Custom instructions" },
  // SettingsPanels.tsx sendShortcutOptions (macOS)
  sendShortcut: { enter: "Enter", "mod-enter-multiline": "⌘ + Enter for multiline prompts", "mod-enter": "⌘ + Enter always" },
  // AppearanceSettingsPanel.tsx environmentIdentificationOptions(null)
  environmentIdentificationMode: { artwork: "None", "nightly-artwork": "Nightly artwork", "dev-artwork": "Dev artwork" },
  // BackgroundActivitySettings.tsx BACKGROUND_ACTIVITY_PROFILE_LABELS
  backgroundActivityProfile: { balanced: "Balanced", performance: "Performance", "battery-saver": "Battery saver" },
  // SettingsPanels.tsx TIMESTAMP_FORMAT_LABELS
  timestampFormat: { locale: "System default", "12-hour": "12-hour", "24-hour": "24-hour" },
  // SettingsPanels.tsx QUIT_CONFIRMATION_MODE_LABELS
  confirmQuit: { direct: "Direct", hold: "Hold", "double-click": "Double press" },
};

function selects() {
  const out: { path: string; title: string; field: string; options: { value: string; label: string }[] }[] = [];
  for (const panel of SETTINGS_PANELS)
    for (const section of panel.sections)
      for (const row of section.rows) {
        const spec = resolveControl(row);
        if (spec?.kind === "select") out.push({ path: panel.path, title: row.title, field: spec.field, options: spec.options });
      }
  return out;
}

test("every select option carries the reference's label", () => {
  for (const select of selects()) {
    const table = REFERENCE[select.field];
    if (!table) continue;
    for (const option of select.options) {
      if (option.value in table) expect(`${select.title}/${option.value}: ${option.label}`).toBe(`${select.title}/${option.value}: ${table[option.value]}`);
    }
  }
});

test("no select option is labelled with its raw value unless the reference does the same", () => {
  const offenders: string[] = [];
  for (const select of selects())
    for (const option of select.options)
      if (option.label === option.value && REFERENCE[select.field]?.[option.value] !== option.label)
        offenders.push(`${select.path} ${select.title}: ${option.value}`);
  expect(offenders).toEqual([]);
});

test("the selects the reference defines are all present", () => {
  const fields = new Set(selects().map((s) => s.field));
  for (const field of ["notificationMode", "sendShortcut", "branchNamingMode", "timestampFormat", "confirmQuit", "backgroundActivityProfile", "environmentIdentificationMode"])
    expect(fields.has(field)).toBe(true);
});
