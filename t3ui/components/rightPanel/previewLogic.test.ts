import { expect, test } from "nsh/test";
import { normalizePreviewUrl, previewChrome } from "./previewLogic";

test("the address bar opens URLs, localhost ports and bare hosts, and refuses searches it cannot open", () => {
  expect(normalizePreviewUrl("https://example.com/a")).toBe("https://example.com/a");
  expect(normalizePreviewUrl("localhost:3000")).toBe("http://localhost:3000");
  expect(normalizePreviewUrl("127.0.0.1:5173/x")).toBe("http://127.0.0.1:5173/x");
  expect(normalizePreviewUrl("example.com")).toBe("https://example.com");
  expect(normalizePreviewUrl("two words")).toBe(null);
  expect(normalizePreviewUrl("   ")).toBe(null);
  expect(normalizePreviewUrl("nodots")).toBe(null);
});

test("without a page the chrome has nothing to go back to", () => {
  expect(previewChrome({ url: "", loading: true, canGoBack: true, canGoForward: true, hasPage: false })).toEqual({ address: "", loading: false, canGoBack: false, canGoForward: false });
  expect(previewChrome({ url: "http://a", loading: true, canGoBack: true, canGoForward: false, hasPage: true }).canGoBack).toBe(true);
});

import { boundConfiguredLocalServerUrls, isNavigationDownload, configuredPreviewUrls, evictExcessProjects, faviconUrl, mergeServers, normalizeHistoryUrl, readDiscoveredServers, recentEntries, recentLabel, recordVisit } from "./previewLogic";

test("history keeps one entry per URL, newest first, and only remembers web pages", () => {
  let list = recordVisit([], "http://localhost:3000/", 1);
  list = recordVisit(list, "https://example.com/a?b=1", 2);
  list = recordVisit(list, "http://localhost:3000/", 3);
  list = recordVisit(list, "about:blank", 4);
  expect(recentEntries(list).map((entry) => entry.url)).toEqual(["http://localhost:3000/", "https://example.com/a?b=1"]);
  expect(recentLabel("https://example.com/a?b=1")).toBe("example.com/a?b=1");
  expect(recentLabel("http://localhost:3000/")).toBe("localhost:3000");
});

test("discovered servers are read defensively and configured ones sort first", () => {
  const read = readDiscoveredServers({ servers: [{ host: "127.0.0.1", port: 5173, url: "http://127.0.0.1:5173/", processName: "vite" }, { host: "localhost", port: 3000, url: "http://localhost:3000/", processName: null }, { nope: 1 }], configuredUrlProbing: true });
  expect(read.servers.length).toBe(2);
  expect(mergeServers(read.servers, ["http://localhost:5173/"]).map((server) => `${server.source}:${server.port}`)).toEqual(["configured:5173", "scanner:3000"]);
});

test("a page's favicon is its origin's, for web pages only", () => {
  expect(faviconUrl("http://localhost:3000/app")).toBe("http://localhost:3000/favicon.ico");
  expect(faviconUrl("about:blank")).toBeNull();
});

import { nextZoom } from "./previewMore";
test("zoom steps through the presets and resets to 100%", () => {
  expect(nextZoom(1, "in")).toBe(1.1);
  expect(nextZoom(1, "out")).toBe(0.9);
  expect(nextZoom(5, "in")).toBe(5);
  expect(nextZoom(0.25, "out")).toBe(0.25);
  expect(nextZoom(2, "reset")).toBe(1);
});

test("fm13: history URLs drop credentials, cap at 2048 and keep only http(s)", () => {
  expect(normalizeHistoryUrl("https://user:pw@example.com/a")).toBe("https://example.com/a");
  expect(normalizeHistoryUrl("localhost:3000")).toBe("http://localhost:3000/");
  expect(normalizeHistoryUrl(`https://example.com/${"a".repeat(2050)}`)).toBeNull();
  expect(normalizeHistoryUrl("about:blank")).toBeNull();
});

test("fm13: one server under localhost, 127.0.0.1 or the environment host is one recent; the loopback address is kept; titles stick", () => {
  let list = recordVisit([], "http://localhost:5173/", 1, "Vite App");
  list = recordVisit(list, "http://127.0.0.1:5173/", 2);
  list = recordVisit(list, "http://devbox.lan:5173/", 3, undefined, "devbox.lan");
  expect(list).toEqual([{ url: "http://localhost:5173/", lastVisitedAt: 3, title: "Vite App" }]);
  list = recordVisit(list, "http://localhost:5174/", 4);
  expect(list.map((entry) => entry.url)).toEqual(["http://localhost:5174/", "http://localhost:5173/"]);
});

test("fm13: only the 20 most recently visited projects keep recents", () => {
  const byProject: Record<string, { url: string; lastVisitedAt: number }[]> = {};
  for (let i = 0; i < 22; i++) byProject[`p${i}`] = [{ url: "https://e.com/", lastVisitedAt: i }];
  const kept = evictExcessProjects(byProject);
  expect(Object.keys(kept).length).toBe(20);
  expect(kept.p0).toBeUndefined();
  expect(kept.p21).toBeDefined();
});

test("fm13: configured preview URLs come from the project's scripts and are bounded to loopback http(s), deduped without the hash", () => {
  expect(configuredPreviewUrls([{ previewUrl: "http://localhost:3000/" }, {}, { previewUrl: "" }])).toEqual(["http://localhost:3000/"]);
  expect(boundConfiguredLocalServerUrls(["http://localhost:3000/#a", "http://localhost:3000/#b", " http://localhost:4000/", "https://example.com/", "ftp://127.0.0.1/", "http://127.0.0.1:5000/x"]))
    .toEqual(["http://localhost:3000/#a", "http://127.0.0.1:5000/x"]);
  expect(boundConfiguredLocalServerUrls(Array.from({ length: 40 }, (_, i) => `http://localhost:${3000 + i}/`)).length).toBe(32);
});

test("fm13: without configured-URL probing a configured server opens at its configured URL", () => {
  const scanner = [{ host: "127.0.0.1", port: 3000, url: "http://127.0.0.1:3000/", processName: "vite" }];
  expect(mergeServers(scanner, ["http://localhost:3000/app"], false)[0]).toMatchObject({ source: "configured", requestedUrl: "http://localhost:3000/app" });
  expect(mergeServers(scanner, ["http://localhost:3000/app"], true)[0]).toMatchObject({ source: "configured", requestedUrl: "http://127.0.0.1:3000/" });
});

test("fm13: only a download that is the tab's own navigation replaces the page; an in-page download does not", () => {
  expect(isNavigationDownload("http://localhost:3000/report.pdf#p=2", ["http://localhost:3000/report.pdf", ""])).toBe(true);
  expect(isNavigationDownload("http://localhost:3000/export.csv", ["http://localhost:3000/app", "http://localhost:3000/app"])).toBe(false);
  expect(isNavigationDownload("blob:http://localhost:3000/abc", ["http://localhost:3000/app"])).toBe(false);
});
