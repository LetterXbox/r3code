import { expect, test } from "nsh/test";
import { detectBrowserImportSources, parseFirefoxProfiles, type DetectFs } from "./browserImportDetect";

const H = "/Users/u";
const S = `${H}/Library/Application Support`;
function fakeFs(files: Record<string, string>, links: Record<string, string> = {}): DetectFs {
  const paths = Object.keys(files);
  return {
    home: H,
    exists: async (p) => p in files || paths.some((f) => f.startsWith(`${p}/`)),
    readText: async (p) => { if (!(p in files)) throw Object.assign(new Error("nope"), { code: "ENOENT" }); return files[p]!; },
    readdir: async (p) => [...new Set(paths.filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))].sort(),
    readlink: async (p) => { if (!(p in links)) throw Object.assign(new Error("nope"), { code: "ENOENT" }); return links[p]!; },
  };
}

test("Chrome profiles come from Local State; a held SingletonLock reports the browser running; missing ones are not installed", async () => {
  const fs = fakeFs({
    [`${S}/Google/Chrome/Local State`]: JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" }, "Profile 2": { name: "Work" }, "../x": {} } } }),
    [`${S}/Google/Chrome/Default/Network/Cookies`]: "",
    [`${S}/BraveSoftware/Brave-Browser/Default/Cookies`]: "",
    [`${S}/Firefox/profiles.ini`]: "[Install1]\nDefault=x\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n",
    [`${S}/Firefox/Profiles/abc.default-release/cookies.sqlite`]: "",
  }, { [`${S}/BraveSoftware/Brave-Browser/SingletonLock`]: "mac-123" });
  const sources = await detectBrowserImportSources(fs);
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
  expect(sources.map((s) => s.id)).toEqual(["chrome", "edge", "brave", "vivaldi", "opera", "arc", "helium", "safari", "firefox", "zen"]);
  expect(byId.chrome!.profiles).toEqual([{ directory: "Default", name: "Person 1" }, { directory: "Profile 2", name: "Work" }]);
  expect(byId.chrome!.unavailable).toBeUndefined();
  expect(byId.brave!.unavailable).toBe("browserRunning");
  expect(byId.edge!.unavailable).toBe("notInstalled");
  expect(byId.safari!.unavailable).toBe("notInstalled");
  expect(byId.firefox!.profiles).toEqual([{ directory: "Profiles/abc.default-release", name: "default-release" }]);
});

test("Firefox profiles.ini: only ProfileN blocks, no escaping the root", () => {
  expect(parseFirefoxProfiles("[Profile0]\nName=a\nPath=../evil\n[Profile1]\nName=b\nPath=Profiles/b\n[General]\nPath=x")).toEqual([{ directory: "Profiles/b", name: "b" }]);
});
