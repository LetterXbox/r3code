// The cases of apps/web/src/openVsxThemes.test.ts. The network is a stub (`fetch` is replaced for the test): nothing
// here reaches open-vsx.org. Packages are built in the test with a small ZIP writer.
import { expect, test } from "nsh/test";
import { createHash } from "crypto";
import { deflateRawSync } from "zlib";
import { importOpenVsxThemeExtension, searchOpenVsxThemes, type OpenVsxThemeExtension } from "./openVsxThemes";
import { getThemeColorsForMode, themeColorToHex } from "./themePalette";

const ASSET_ROOT = "https://open-vsx.org/api/demo/theme/1.0.0/file";

function extensionDetail(overrides: Record<string, unknown> = {}) {
  return {
    namespace: "demo", name: "theme", displayName: "Demo Theme", description: "A nice theme", version: "1.0.0", downloadCount: 123456, license: "MIT",
    repository: "https://github.com/demo/theme",
    files: { icon: `${ASSET_ROOT}/icon.png`, manifest: `${ASSET_ROOT}/package.json`, sha256: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`, download: `${ASSET_ROOT}/demo.theme-1.0.0.vsix` },
    ...overrides,
  };
}

async function withFetch<T>(handler: (input: string, init?: RequestInit) => Response | Promise<Response>, body: (calls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    return handler(String(input), init);
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** A ZIP with deflated entries (the CRC is not read by the importer), optionally with a trailing comment. */
function makeZip(files: Record<string, string>, comment = ""): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const data = raw.length === 0 ? raw : new Uint8Array(deflateRawSync(raw));
    const method = raw.length === 0 ? 0 : 8;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const entry = new Uint8Array(46 + nameBytes.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(10, method, true);
    ev.setUint32(20, data.length, true);
    ev.setUint32(24, raw.length, true);
    ev.setUint16(28, nameBytes.length, true);
    ev.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const directorySize = central.reduce((sum, item) => sum + item.length, 0);
  const commentBytes = encoder.encode(comment);
  const end = new Uint8Array(22 + commentBytes.length);
  const dv = new DataView(end.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, central.length, true);
  dv.setUint16(10, central.length, true);
  dv.setUint32(12, directorySize, true);
  dv.setUint32(16, offset, true);
  dv.setUint16(20, commentBytes.length, true);
  end.set(commentBytes, 22);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, item) => sum + item.length, 0));
  let at = 0;
  for (const item of all) { out.set(item, at); at += item.length; }
  return out;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const EXTENSION: OpenVsxThemeExtension = {
  collectionId: "open-vsx:demo.theme", id: "demo.theme", name: "Demo Theme", publisher: "demo", description: "", downloadCount: 1, iconUrl: null, sourceUrl: null,
  license: "MIT", manifestUrl: `${ASSET_ROOT}/package.json`, sha256Url: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`, version: "1.0.0", vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
};

test("search keeps only supported open-source licenses and asks Open VSX the way the web does", async () => {
  const other = (name: string) => ASSET_ROOT.replace("demo/theme", `${name}/theme`);
  const results = await withFetch((url) => {
    if (url.includes("/-/search?")) return new Response(JSON.stringify({ extensions: ["demo", "icons", "oversized", "unlicensed", "unavailable", "closed", "huge"].map((namespace) => ({ namespace, name: "theme" })) }), { status: 200 });
    if (url.endsWith("/icons/theme")) return new Response(JSON.stringify(extensionDetail({ namespace: "icons", files: { ...extensionDetail().files, manifest: `${other("icons")}/package.json` } })), { status: 200 });
    if (url.endsWith("/oversized/theme")) return new Response(JSON.stringify(extensionDetail({ namespace: "oversized", files: { ...extensionDetail().files, download: `${other("oversized")}/oversized.vsix` } })), { status: 200 });
    if (url.endsWith("/unlicensed/theme")) return new Response(JSON.stringify(extensionDetail({ namespace: "unlicensed", files: { ...extensionDetail().files, manifest: `${other("unlicensed")}/package.json` } })), { status: 200 });
    if (url.endsWith("/unavailable/theme")) return new Response(JSON.stringify(extensionDetail({ namespace: "unavailable", files: { ...extensionDetail().files, download: `${other("unavailable")}/unavailable.vsix`, manifest: `${other("unavailable")}/package.json` } })), { status: 200 });
    if (url.endsWith("/closed/theme")) return new Response(JSON.stringify(extensionDetail({ namespace: "closed", license: "All Rights Reserved" })), { status: 200 });
    if (url.endsWith("/huge/theme")) return new Response(JSON.stringify({ padding: "x".repeat(256 * 1024) }), { status: 200 });
    if (url.endsWith("/oversized/theme/1.0.0/file/oversized.vsix")) return new Response(null, { headers: { "content-length": String(20 * 1024 * 1024 + 1) }, status: 200 });
    if (url.endsWith("/unavailable/theme/1.0.0/file/unavailable.vsix")) return new Response(null, { status: 404 });
    if (url.endsWith(".vsix")) return new Response(null, { headers: { "content-length": "1024" }, status: 200 });
    if (url.endsWith("/icons/theme/1.0.0/file/package.json")) return new Response(JSON.stringify({ contributes: { iconThemes: [{}] } }), { status: 200 });
    if (url.endsWith("/unlicensed/theme/1.0.0/file/package.json")) return new Response(JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }), { status: 200 });
    if (url.endsWith("/unavailable/theme/1.0.0/file/package.json") || url.endsWith("/demo/theme/1.0.0/file/package.json")) return new Response(JSON.stringify({ license: "MIT", contributes: { themes: [{ path: "./theme.json" }] } }), { status: 200 });
    return new Response(JSON.stringify(extensionDetail()), { status: 200 });
  }, async (calls) => {
    const found = await searchOpenVsxThemes("  dracula  ");
    const searchUrl = new URL(calls[0]!);
    expect(searchUrl.origin + searchUrl.pathname).toBe("https://open-vsx.org/api/-/search");
    expect(searchUrl.searchParams.get("query")).toBe("dracula");
    expect(searchUrl.searchParams.get("category")).toBe("Themes");
    expect(searchUrl.searchParams.get("sortBy")).toBe("downloadCount");
    expect(searchUrl.searchParams.get("sortOrder")).toBe("desc");
    expect(searchUrl.searchParams.get("size")).toBe("16");
    // Only the search text is sent: no other query parameter and nothing about the user or the project.
    expect([...searchUrl.searchParams.keys()].sort()).toEqual(["category", "query", "size", "sortBy", "sortOrder"]);
    return found;
  });
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ id: "demo.theme", name: "Demo Theme", publisher: "demo", downloadCount: 123456, iconUrl: `${ASSET_ROOT}/icon.png`, sourceUrl: "https://github.com/demo/theme", license: "MIT" });
});

test("an empty query asks nothing, and a sort order is passed through", async () => {
  await withFetch(() => { throw new Error("no request expected"); }, async () => {
    expect(await searchOpenVsxThemes("   ")).toEqual([]);
  });
  await withFetch(() => new Response(JSON.stringify({ extensions: [] }), { status: 200 }), async (calls) => {
    expect(await searchOpenVsxThemes("nord", { sortBy: "rating" })).toEqual([]);
    expect(new URL(calls[0]!).searchParams.get("sortBy")).toBe("rating");
  });
});

test("search errors use the web's messages", async () => {
  await withFetch(() => new Response(null, { status: 500 }), async () => {
    await expect(searchOpenVsxThemes("x")).rejects.toThrow("Open VSX search is unavailable right now.");
  });
  await withFetch(() => new Response("not json", { status: 200 }), async () => {
    await expect(searchOpenVsxThemes("x")).rejects.toThrow("Open VSX returned an unreadable response.");
  });
  await withFetch(() => new Response(JSON.stringify({ nope: 1 }), { status: 200 }), async () => {
    await expect(searchOpenVsxThemes("x")).rejects.toThrow("Open VSX returned an unreadable search response.");
  });
  await withFetch((url) => (url.includes("/-/search?") ? new Response(JSON.stringify({ extensions: [{ namespace: "demo", name: "theme" }] }), { status: 200 }) : new Response(null, { status: 429 })), async () => {
    await expect(searchOpenVsxThemes("dracula")).rejects.toThrow("Open VSX theme details are unavailable");
  });
});

test("an install downloads a verified VSIX, reads JSONC includes and pairs contributed variants", async () => {
  const files: Record<string, string> = {
    "extension/.gitkeep": "",
    "extension/themes/base.jsonc": `{
      // inherited workbench colors
      "colors": { "editor.foreground": "#eeeeee", "focusBorder": "#8b5cf6", "editor.findMatchBackground": "#663399", "editor.findMatchForeground": "#ffffff",
        "editor.findMatchHighlightBackground": "#445566", "editor.findMatchHighlightForeground": "#ffffff", },
    }`,
    "extension/themes/demo-dark.json": `{ "include": "./base.jsonc", "colors": { "editor.background": "#111111", "editor.findMatchHighlightBackground": "#ffffff20" } }`,
    "extension/themes/demo-light.json": `{ "colors": { "editor.background": "#fafafa", "editor.foreground": "#222222", "focusBorder": "#8b5cf6", "editor.findMatchBackground": "#335577",
      "editor.findMatchForeground": "#ffffff", "editor.findMatchHighlightBackground": "#bbddff", "editor.findMatchHighlightForeground": "#112233" } }`,
    "extension/themes/demo.json": `{ "colors": { "editor.background": "#181818", "editor.foreground": "#eeeeee" } }`,
  };
  const packagedManifest: Record<string, unknown> & { contributes: { themes: { label: string; uiTheme: string; path: string }[] } } = {
    publisher: "demo", name: "theme", version: "1.0.0", license: "MIT",
    contributes: { themes: [
      { label: "Demo Dark", uiTheme: "vs-dark", path: "./themes/demo-dark.json" },
      { label: "Demo Light", uiTheme: "vs", path: "./themes/demo-light.json" },
      { label: "Demo", uiTheme: "vs-dark", path: "./themes/demo.json" },
    ] },
  };
  let packageBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let checksum = "";
  const rebuild = () => {
    // A comment that looks like an end-of-directory record must not confuse the reader.
    packageBytes = makeZip({ ...files, "extension/package.json": JSON.stringify(packagedManifest) }, `PK\u0005\u0006${"x".repeat(26)}`);
    checksum = sha(packageBytes);
  };
  rebuild();
  const handler = (url: string) => {
    if (url === EXTENSION.manifestUrl) return new Response(JSON.stringify({ contributes: { themes: [{ label: "Wrong", path: "./themes/missing.json" }] } }), { status: 200 });
    if (url === EXTENSION.sha256Url) return new Response(`${checksum}  demo.vsix`);
    return new Response(packageBytes, { status: 200, headers: { "Content-Length": String(packageBytes.byteLength) } });
  };
  await withFetch(handler, async () => {
    const themes = await importOpenVsxThemeExtension(EXTENSION);
    expect(themes).toHaveLength(2);
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(2);
    expect(themes.every((theme) => /^ovx-theme-[0-9a-f]{12}$/.test(theme.id))).toBe(true);
    expect(themes.every((theme) => theme.collection.id === "open-vsx:demo.theme" && theme.collection.label === "Demo Theme")).toBe(true);
    const paired = themes.find((theme) => getThemeColorsForMode(theme, "light") !== null && getThemeColorsForMode(theme, "dark") !== null)!;
    expect(paired.label).toBe("Demo");
    expect(themeColorToHex(paired.colors.canvas)).toBe("#fafafa");
    const dark = getThemeColorsForMode(paired, "dark")!;
    expect(themeColorToHex(dark.canvas)).toBe("#111111");
    expect(themeColorToHex(dark.text)).toBe("#eeeeee");
    expect(themeColorToHex(dark.searchMatchActiveBackground)).toBe("#663399");
    expect(themeColorToHex(dark.searchMatchActiveForeground)).toBe("#ffffff");
    expect(themeColorToHex(dark.searchMatchBackground)).toBe("#2f2f2f");
    expect(themeColorToHex(paired.colors.searchMatchActiveBackground)).toBe("#335577");
    expect(themeColorToHex(paired.colors.searchMatchBackground)).toBe("#bbddff");
    expect(themeColorToHex(paired.colors.searchMatchForeground)).toBe("#112233");

    // Renaming the labels keeps the ids: they come from the source paths.
    packagedManifest.contributes.themes[0]!.label = "Renamed Dark";
    packagedManifest.contributes.themes[1]!.label = "Renamed Light";
    packagedManifest.contributes.themes[2]!.label = "Renamed Solo";
    rebuild();
    expect((await importOpenVsxThemeExtension(EXTENSION)).map((theme) => theme.id)).toEqual(themes.map((theme) => theme.id));

    // A second contribution of the same file is told apart and the existing ids are kept.
    packagedManifest.contributes.themes.push({ label: "Duplicate Demo", uiTheme: "vs-dark", path: "./themes/demo.json" });
    rebuild();
    const duplicates = await importOpenVsxThemeExtension(EXTENSION);
    expect(new Set(duplicates.map((theme) => theme.id)).size).toBe(duplicates.length);
    expect(themes.every(({ id }) => duplicates.some((theme) => theme.id === id))).toBe(true);
    packagedManifest.contributes.themes.pop();

    packagedManifest.contributes.themes[2]!.path = "./themes/missing.json";
    rebuild();
    await expect(importOpenVsxThemeExtension(EXTENSION)).rejects.toThrow("could not be imported safely");
    packagedManifest.contributes.themes[2]!.path = "./themes/demo.json";

    packagedManifest.license = "Proprietary";
    rebuild();
    await expect(importOpenVsxThemeExtension(EXTENSION)).rejects.toThrow("does not match its advertised license");
    delete packagedManifest.license;
    rebuild();
    await expect(importOpenVsxThemeExtension(EXTENSION)).rejects.toThrow("does not match its advertised license");
  });
});

test("a package that is not the selected extension, or escapes its folder, is refused", async () => {
  const build = (manifest: Record<string, unknown>, extra: Record<string, string> = {}) => makeZip({ "extension/package.json": JSON.stringify(manifest), "extension/t.json": '{"colors":{"editor.background":"#111111"}}', ...extra });
  const good = { publisher: "demo", name: "theme", version: "1.0.0", license: "MIT", contributes: { themes: [{ path: "./t.json", uiTheme: "vs-dark" }] } };
  const serve = (bytes: Uint8Array) => (url: string) =>
    url === EXTENSION.manifestUrl ? new Response(JSON.stringify(good), { status: 200 }) : url === EXTENSION.sha256Url ? new Response(sha(bytes)) : new Response(bytes, { status: 200 });
  for (const [manifest, message] of [[{ ...good, version: "2.0.0" }, "does not match the selected Open VSX theme"], [{ ...good, name: "other" }, "does not match the selected Open VSX theme"]] as const) {
    await withFetch(serve(build(manifest)), async () => { await expect(importOpenVsxThemeExtension(EXTENSION)).rejects.toThrow(message); });
  }
  await withFetch(serve(build(good, { "extension/../../escape.txt": "x" })), async () => {
    await expect(importOpenVsxThemeExtension(EXTENSION)).rejects.toThrow("Theme path escapes the extension package.");
  });
  const garbage = new Uint8Array([1, 2, 3, 4]);
  await withFetch(serve(garbage), async () => { await expect(importOpenVsxThemeExtension(EXTENSION)).rejects.toThrow("That extension package has no ZIP directory."); });
});

test("an install stops when the request is cancelled", async () => {
  const packageBytes = new Uint8Array([1, 2, 3]);
  const controller = new AbortController();
  await withFetch((url) => {
    if (url === EXTENSION.manifestUrl) return new Response(JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }));
    if (url === EXTENSION.sha256Url) { controller.abort(); return new Response(sha(packageBytes)); }
    return new Response(packageBytes);
  }, async () => {
    await expect(importOpenVsxThemeExtension(EXTENSION, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

test("a package whose Open VSX checksum does not match fails its integrity check", async () => {
  await withFetch((url) => {
    if (url === EXTENSION.manifestUrl) return new Response(JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }));
    if (url === EXTENSION.sha256Url) return new Response("0".repeat(64));
    return new Response(new Uint8Array([1, 2, 3]));
  }, async () => {
    await expect(importOpenVsxThemeExtension(EXTENSION)).rejects.toThrow("integrity check");
  });
});
