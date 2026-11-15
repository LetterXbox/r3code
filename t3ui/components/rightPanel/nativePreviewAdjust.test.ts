import { expect, test } from "nsh/test";
import { resetDesktopHostCapabilities } from "../../desktop/desktopHost";
import { clearNativeCache, clearNativeCookies, forgetNativeColorScheme, nativeTabSchemeFor, resolveNativePartition, setNativeColorScheme } from "./nativePreviewAdjust";

// There is no host in the test runner, so desktopHostCapabilities() always resolves an empty set: every call below
// takes callGated's "missing capability" branch, the one every build ships behind until 0022/0024 land. That branch
// is exactly what needs covering -- it is the one real hosts hit too, until those patches are built -- so these tests
// assert it never calls the host and always names the missing patch, not a silent no-op.
test("resolveNativePartition mirrors resolvePartitionScope's default-profile and named-profile keys", () => {
  expect(resolveNativePartition("env-1", undefined)).toBe("env-1");
  expect(resolveNativePartition("env-1", "default")).toBe("env-1");
  expect(resolveNativePartition("env-1", "work")).toBe(JSON.stringify(["env-1", "work"]));
});

test("clearing cookies without the 0022 capability reports the missing patch, not a silent no-op", async () => {
  resetDesktopHostCapabilities();
  const toasts: unknown[] = [];
  const ok = await clearNativeCookies("env-1", undefined, (input) => toasts.push(input), async () => { throw new Error("should not be called"); });
  expect(ok).toBe(false);
  expect(toasts).toHaveLength(1);
  expect((toasts[0] as { description: string }).description).toContain("webview.cookies.clear");
  expect((toasts[0] as { description: string }).description).toContain("0022-gpui-webview-cookie-store.patch");
});

test("clearing cache without the 0022 capability reports the missing patch", async () => {
  resetDesktopHostCapabilities();
  const toasts: unknown[] = [];
  const ok = await clearNativeCache("env-1", "work", (input) => toasts.push(input), async () => { throw new Error("should not be called"); });
  expect(ok).toBe(false);
  expect((toasts[0] as { description: string }).description).toContain("webview.cache.clear");
});

test("setNativeColorScheme without 0024 reports the missing patch and leaves the remembered scheme at system", async () => {
  resetDesktopHostCapabilities();
  forgetNativeColorScheme("surface-1");
  const toasts: unknown[] = [];
  const ok = await setNativeColorScheme("surface-1", "env-1", undefined, "dark", (input) => toasts.push(input), async () => { throw new Error("should not be called"); });
  expect(ok).toBe(false);
  expect(nativeTabSchemeFor("surface-1")).toBe("system");
  expect((toasts[0] as { description: string }).description).toContain("webview.appearance.set");
  expect((toasts[0] as { description: string }).description).toContain("0024-gpui-webview-appearance.patch");
});
