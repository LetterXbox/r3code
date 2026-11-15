import { expect, test } from "nsh/test";
import { bridgedServerTabIds, bridgedTabIdFor, closeNativeTab, nativeTabIdForTest, reportNativeTab, resizeNativeTab } from "./desktopPreviewSessions";
import { buildReportInput, createProfileReporter, desktopTabReporter, profileReport, registerDesktopTab } from "./desktopPreviewSessions";

const recorder = (answer: unknown = {}) => {
  const calls: { method: string; payload: unknown }[] = [];
  return { calls, request: async (method: string, payload: unknown) => { calls.push({ method, payload }); return answer; } };
};

test("a native tab registers as a desktop session (runtime omitted) and takes the server's tab id", async () => {
  const r = recorder({ threadId: "t1", tabId: "tab-9", runtime: "desktop" });
  expect(await registerDesktopTab({ threadId: "t1", url: "http://localhost:3000/" }, r.request)).toBe("tab-9");
  expect(r.calls).toEqual([{ method: "preview.open", payload: { threadId: "t1", url: "http://localhost:3000/" } }]);
});

test("status reports are deduped on url and kind; failures always report", () => {
  const base = { canGoBack: false, canGoForward: false, title: "T" };
  expect(buildReportInput("t1", "x", { ...base, kind: "Idle", url: "" }, { url: null, kind: null })).toBe(null);
  expect(buildReportInput("t1", "x", { ...base, kind: "Success", url: "http://a/" }, { url: "http://a/", kind: "Success" })).toBe(null);
  expect(buildReportInput("t1", "x", { ...base, kind: "LoadFailed", url: "http://a/", code: -105, description: "x" }, { url: "http://a/", kind: "LoadFailed" })?.navStatus)
    .toEqual({ _tag: "LoadFailed", url: "http://a/", title: "T", code: -105, description: "x" });
  const r = recorder();
  const tab = desktopTabReporter("t1", "x", r.request);
  tab.report({ ...base, kind: "Loading", url: "http://a/" });
  tab.report({ ...base, kind: "Loading", url: "http://a/" });
  tab.report({ ...base, kind: "Success", url: "http://a/" });
  void tab.resize({ _tag: "fill" });
  tab.close();
  tab.close();
  tab.report({ ...base, kind: "Success", url: "http://b/" });
  expect(r.calls.map((c) => c.method)).toEqual(["preview.reportStatus", "preview.reportStatus", "preview.resize", "preview.close"]);
  expect(r.calls[3]!.payload).toEqual({ threadId: "t1", tabId: "x" });
});

test("profiles are reported once per connection and settings, only with preview:operate on a server browser", () => {
  const r = recorder();
  const report = createProfileReporter(r.request);
  const input = profileReport((key) => (key === "browserProfiles" ? [{ id: "work", name: "Work" }] : undefined));
  expect(input).toEqual({ profiles: [{ id: "work", name: "Work" }], defaultProfileId: "default", recordingFrameRate: 30 });
  expect(report("c1", false, true, input)).toBe(false);
  expect(report("c1", true, true, input)).toBe(true);
  expect(report("c1", true, true, input)).toBe(false);
  expect(report("c2", true, true, input)).toBe(true);
  expect(r.calls.map((c) => c.method)).toEqual(["preview.reportProfiles", "preview.reportProfiles"]);
});

test("a native surface registers on its first address, reports after, and closes its session", async () => {
  const r = recorder({ tabId: "srv-1" });
  const base = { canGoBack: false, canGoForward: false, title: "" };
  reportNativeTab("s1", "t1", { ...base, kind: "Idle", url: "" }, undefined, r.request);
  reportNativeTab("s1", "t1", { ...base, kind: "Loading", url: "http://a/" }, undefined, r.request);
  for (let i = 0; i < 50 && nativeTabIdForTest("s1") === null; i += 1) await new Promise((res) => setTimeout(res, 2));
  reportNativeTab("s1", "t1", { ...base, kind: "Success", url: "http://a/" }, undefined, r.request);
  closeNativeTab("s1");
  expect(r.calls.map((c) => c.method)).toEqual(["preview.open", "preview.reportStatus", "preview.reportStatus", "preview.close"]);
  expect(r.calls[3]!.payload).toEqual({ threadId: "t1", tabId: "srv-1" });
});

test("with the browser bridge a native surface is a server-runtime session: no status reports, its tab id in the marker", async () => {
  const r = recorder({ tabId: "srv-2" });
  const base = { canGoBack: false, canGoForward: false, title: "" };
  reportNativeTab("s2", "t1", { ...base, kind: "Loading", url: "http://b/" }, undefined, r.request, () => true);
  for (let i = 0; i < 50 && bridgedTabIdFor("s2") === null; i += 1) await new Promise((res) => setTimeout(res, 2));
  expect(bridgedTabIdFor("s2")).toBe("srv-2");
  expect(bridgedServerTabIds().has("srv-2")).toBe(true);
  reportNativeTab("s2", "t1", { ...base, kind: "Success", url: "http://b/" }, undefined, r.request, () => true);
  closeNativeTab("s2");
  expect(bridgedTabIdFor("s2")).toBe(null);
  expect(r.calls.map((c) => c.method)).toEqual(["preview.open", "preview.close"]);
  expect(r.calls[0]!.payload).toEqual({ threadId: "t1", url: "http://b/", runtime: "server" });
  expect(r.calls[1]!.payload).toEqual({ threadId: "t1", tabId: "srv-2" });
});

test("a failed viewport commit raises the reference's error toast", async () => {
  const toasts: unknown[] = [];
  const request = async (method: string) => {
    if (method === "preview.open") return { tabId: "srv-3" };
    if (method === "preview.resize") throw new Error("tab gone");
    return null;
  };
  const base = { canGoBack: false, canGoForward: false, title: "" };
  reportNativeTab("s3", "t1", { ...base, kind: "Loading", url: "http://c/" }, undefined, request, () => false);
  for (let i = 0; i < 50 && nativeTabIdForTest("s3") === null; i += 1) await new Promise((res) => setTimeout(res, 2));
  resizeNativeTab("s3", { _tag: "fill" }, (input) => toasts.push(input));
  for (let i = 0; i < 50 && toasts.length === 0; i += 1) await new Promise((res) => setTimeout(res, 2));
  expect(toasts).toEqual([{ type: "error", title: "Unable to resize browser viewport", description: "tab gone" }]);
  closeNativeTab("s3");
});

test("without the bridge (a host without 0014) a native tab stays a desktop session: no runtime, reports, no marker", async () => {
  const r = recorder({ tabId: "srv-3" });
  const base = { canGoBack: false, canGoForward: false, title: "" };
  reportNativeTab("s3", "t1", { ...base, kind: "Loading", url: "http://c/" }, undefined, r.request, () => false);
  for (let i = 0; i < 50 && nativeTabIdForTest("s3") === null; i += 1) await new Promise((res) => setTimeout(res, 2));
  reportNativeTab("s3", "t1", { ...base, kind: "Success", url: "http://c/" }, undefined, r.request, () => false);
  closeNativeTab("s3");
  expect(bridgedTabIdFor("s3")).toBe(null);
  expect(r.calls[0]!.payload).toEqual({ threadId: "t1", url: "http://c/" });
  expect(r.calls.map((c) => c.method)).toEqual(["preview.open", "preview.reportStatus", "preview.reportStatus", "preview.close"]);
});
