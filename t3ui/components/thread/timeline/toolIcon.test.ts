import { expect, test } from "nsh/test";
import { toolIconFromWire, toolIconImageUrl } from "./toolIcon";

test("a website icon prefers its explicit favicon for the appearance, then a themed one, then the origin's favicon.ico", () => {
  const plain = toolIconFromWire({ _tag: "website", pageUrl: "https://example.com/a/b" });
  expect(toolIconImageUrl(plain, false)).toBe("https://example.com/favicon.ico");
  const both = toolIconFromWire({ _tag: "website", pageUrl: "https://example.com/", faviconUrl: "https://cdn.test/l.png", faviconUrlDark: "https://cdn.test/d.png" });
  expect(toolIconImageUrl(both, false)).toBe("https://cdn.test/l.png");
  expect(toolIconImageUrl(both, true)).toBe("https://cdn.test/d.png");
  const github = toolIconFromWire({ _tag: "website", pageUrl: "https://github.com/t3/code" });
  expect(toolIconImageUrl(github, true)).toBe("https://github.githubassets.com/favicons/favicon-dark.svg");
  expect(toolIconImageUrl(github, false)).toBe("https://github.githubassets.com/favicons/favicon.svg");
});

test("a themed logo follows the appearance, and unusable icons resolve to nothing", () => {
  const logo = toolIconFromWire({ _tag: "themed-logo", logoUrl: "https://x.test/l.svg", logoUrlDark: "https://x.test/d.svg" });
  expect(toolIconImageUrl(logo, true)).toBe("https://x.test/d.svg");
  expect(toolIconImageUrl(logo, false)).toBe("https://x.test/l.svg");
  expect(toolIconImageUrl(toolIconFromWire({ _tag: "native-app", app: { _tag: "app-id", appId: "com.apple.finder" } }), false)).toBe(null);
  expect(toolIconImageUrl(toolIconFromWire({ _tag: "website", pageUrl: "file:///etc/passwd" }), false)).toBe(null);
  expect(toolIconFromWire({ _tag: "website" })).toBeUndefined();
  expect(toolIconFromWire(null)).toBeUndefined();
});

test("a native app's icon is minted once from the native-app-icon asset", async () => {
  const { nativeAppIconUrl } = await import("./ToolActivityIcon");
  expect(toolIconFromWire({ _tag: "native-app", app: { _tag: "app-id", appId: "com.apple.finder" } })).toEqual({ tag: "native-app", app: { _tag: "app-id", appId: "com.apple.finder" } });
  const calls: unknown[] = [];
  const request = (_method: string, payload: unknown) => { calls.push(payload); return Promise.resolve({ relativeUrl: "/api/assets/icon?sig=1" }); };
  const app = { _tag: "app-id", appId: "com.example.native" };
  expect(await nativeAppIconUrl(app, request, () => "ws://127.0.0.1:9/")).toBe("http://127.0.0.1:9/api/assets/icon?sig=1");
  await nativeAppIconUrl(app, request, () => "ws://127.0.0.1:9/");
  expect(calls).toEqual([{ resource: { _tag: "native-app-icon", app } }]);
});
