import { expect, test } from "nsh/test";
import { parseSnapShotProbe, recordSnapShotSource, snapShotAccessibilityDetails, snapShotAccessibilityNotice, snapShotIncludesAccessibility, snapShotSourceFor, snapShotWindowLabel } from "./snapShotSource";

const icon = "data:image/png;base64,AAAA";

test("a probe line becomes a source, with limits", () => {
  const source = parseSnapShotProbe(JSON.stringify({ appName: " Safari ", windowTitle: "Docs", appIdentifier: "com.apple.Safari", appIconDataUrl: icon, accessibleText: "Window: Docs\n  Button: Go", truncated: true }));
  expect(source).toEqual({ appName: "Safari", windowTitle: "Docs", appIconDataUrl: icon, appIdentifier: "com.apple.Safari", accessibleText: "Window: Docs\n  Button: Go", truncated: true });
  expect(parseSnapShotProbe("null")).toBeNull();
  expect(parseSnapShotProbe("not json")).toBeNull();
  expect(parseSnapShotProbe(JSON.stringify({ appName: "A", windowTitle: null, appIconDataUrl: "http://x" }))).toEqual({ appName: "A", windowTitle: "" });
});

test("overlay and popover copy follow the reference", () => {
  const bare = { appName: "Notes", windowTitle: "" };
  expect(snapShotWindowLabel(bare)).toBe("Captured window");
  expect(snapShotWindowLabel({ ...bare, windowTitle: "Todo" })).toBe("Todo");
  expect(snapShotIncludesAccessibility(bare)).toBe(false);
  expect(snapShotAccessibilityDetails(bare)).toBeUndefined();
  expect(snapShotAccessibilityNotice(bare)).toBe("The app or capture backend did not provide verified accessibility data.");
  expect(snapShotAccessibilityDetails({ ...bare, accessibleText: " hello " })).toEqual({ content: "hello", format: "text" });
  expect(snapShotAccessibilityNotice({ ...bare, accessibleText: " hello " })).toBeNull();
});

test("sources are remembered by capture name", () => {
  recordSnapShotSource("window-1.png", { appName: "Notes", windowTitle: "" });
  expect(snapShotSourceFor("window-1.png")?.appName).toBe("Notes");
  expect(snapShotSourceFor("other.png")).toBeUndefined();
});
