// The generated General panel follows the reference's JSX order and copy (tools/gen_settings_panels.py).
import { expect, test } from "nsh/test";
import { SETTINGS_PANELS } from "./settingsPanels";

const general = SETTINGS_PANELS.find((panel) => panel.path === "/settings/general")!;
const rows = (section: string) => general.sections.find((entry) => entry.title === section)!.rows;

test("Notifications lists Thread notifications before In-app notifications, each with its description", () => {
  const notifications = rows("Notifications");
  expect(notifications.map((row) => row.title)).toEqual(["Thread notifications", "In-app notifications"]);
  expect(notifications[0]!.description).toBe("System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while R3 Code is open.");
  expect(notifications[1]!.description).toBe("Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.");
});

test("Project order carries only the reference's description", () => {
  const order = rows("Sidebar").find((row) => row.title === "Project order")!;
  expect(order.description).toBe("Order of projects in the sidebar project picker and command palette.");
});

test("no generated row title repeats within a panel and rows keep a description or a control", () => {
  for (const panel of SETTINGS_PANELS) {
    const seen = new Set<string>();
    for (const section of panel.sections) for (const row of section.rows) {
      if (panel.path === "/settings/keybindings") continue;
      expect(seen.has(row.title)).toBe(false);
      seen.add(row.title);
    }
  }
});
