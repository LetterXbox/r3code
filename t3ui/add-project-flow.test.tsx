// The Add project flow in the palette, against faked server RPCs: Sources, Local folder, New project, Git URL, GitHub.
import { expect, open, test } from "nsh/test";

const FIELD = "label:Search commands, projects, and threads";
const called = (app: Awaited<ReturnType<typeof open>>, method: string) => app.texts().some((text) => text.startsWith(`call ${method}`));

async function sources() {
  const app = await open("./AddProjectFixture.tsx", { width: 1280, height: 800 });
  await app.press("label:Open add project");
  await app.waitFor("text:Sources");
  return app;
}

test("Add project lists the sources with their copy and Setup Required badges", async () => {
  const app = await sources();
  for (const text of [
    "New project", "Start a new Git repository from a name", "Local folder", "Browse a folder on disk", "Git URL", "Clone from a remote URL",
    "GitHub repository", "Clone GitHub owner/repo", "Bitbucket repository", "Clone Bitbucket workspace/repository", "Azure DevOps repository",
    "Clone Azure DevOps project/repository", "Backspace", "Back",
  ]) await expect(app.texts()).toContain(text);
  // Discovery: GitHub is signed in, Bitbucket is missing, Azure DevOps is absent from the answer.
  await app.waitFor("label:Setup Required");
  await expect(app.count("label:Setup Required")).toBe(6);
});

test("typed keys land in the Add project field, and Escape closes", async () => {
  const app = await sources();
  await app.waitFor("label:Setup Required");
  await app.keyboard.press("g");
  await app.waitUntil(() => app.value(FIELD) === "g");
  await app.keyboard.press("i");
  await app.waitUntil(() => app.value(FIELD) === "gi");
  await expect(app.value(FIELD)).toBe("gi");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.texts().includes("Sources"));
  await expect(app.texts()).not.toContain("Sources");
});

test("Local folder browses folders and Add creates the project at the path", async () => {
  const app = await sources();
  await app.press("text:Local folder");
  await expect(app.value(FIELD)).toBe("~/");
  await app.waitFor("text:code");
  await expect(app.texts()).toContain("docs");
  await expect(app.texts()).not.toContain(".hidden");
  await expect(app.shows("label:Add (Enter)")).toBe(true);
  await app.submit(FIELD);
  await app.waitUntil(() => called(app, "projects.mutate"));
  await expect(called(app, "projects.mutate")).toBe(true);
});

test("Backspace on an empty Add project step returns to Sources", async () => {
  const app = await sources();
  await app.press("text:New project");
  await expect(app.texts()).toContain("Add existing project");
  await app.keyboard.press("backspace");
  await expect(app.texts()).toContain("Sources");
});

test("New project creates the named project in the projects root", async () => {
  const app = await sources();
  await app.press("text:New project");
  await app.type(FIELD, "my-app");
  await expect(app.texts()).toContain("Creates /home/u/projects/my-app");
  await app.submit(FIELD);
  await app.waitFor("text:Created my-app");
  await expect(called(app, "projects.createNew")).toBe(true);
});

test("Git URL continues to a destination step and clones", async () => {
  const app = await sources();
  await app.press("text:Git URL");
  await expect(app.shows("label:Continue (Enter)")).toBe(true);
  await expect(app.texts()).toContain("Enter a Git clone URL and press Enter to continue.");
  await app.type(FIELD, "https://github.com/octo/repo.git");
  await app.submit(FIELD);
  await expect(app.texts()).toContain("Repository");
  await expect(app.value(FIELD)).toBe("~/repo");
  await app.submit(FIELD);
  await app.waitUntil(() => called(app, "projectClone.start"));
  await expect(called(app, "projectClone.start")).toBe(true);
});

test("GitHub repository looks the owner/repo up before choosing a destination", async () => {
  const app = await sources();
  await app.press("text:GitHub repository");
  await expect(app.shows("label:Lookup (Enter)")).toBe(true);
  await app.type(FIELD, "octo/repo");
  await app.submit(FIELD);
  await app.waitFor("text:octo/repo");
  await expect(called(app, "sourceControl.lookupRepository")).toBe(true);
  await expect(app.texts()).toContain("https://github.com/octo/repo");
});

test("an unready source is disabled and its badge is the way to Source control settings", async () => {
  const app = await sources();
  await app.waitFor("label:Setup Required");
  await app.press("text:Bitbucket repository");
  await expect(app.texts()).toContain("Sources");
});

test("adding the folder of an archived project unarchives it instead of creating another", async () => {
  const app = await sources();
  await app.press("text:Local folder");
  await app.waitFor("text:code");
  await app.type(FIELD, "attic");
  await app.submit(FIELD);
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("call projects.mutate") && text.includes('"project:archived"') && text.includes('"archived":false')));
  await expect(app.texts().some((text) => text.includes('"type":"project.create"'))).toBe(false);
});

test("Local folder offers Open in Finder when the host can show a folder dialog, and adds the folder it picks", async () => {
  const app = await open("./AddProjectFixture.tsx", { width: 1280, height: 800, platform: "macos", host: { handlers: { "dialogs.pickFolder": () => "/Users/me/picked" } } });
  await app.press("label:Open add project");
  await app.waitFor("text:Sources");
  await expect(app.shows("label:Open in Finder")).toBe(false);
  await app.press("text:Local folder");
  await app.waitFor("label:Open in Finder");
  await app.press("label:Open in Finder");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("call projects.mutate") && text.includes('"workspaceRoot":"/Users/me/picked"')));
  await expect(app.host.calls().map((call) => call.name)).toEqual(["dialogs.pickFolder"]);
});

test("without an embedding app there is no Open in Finder", async () => {
  const app = await sources();
  await app.press("text:Local folder");
  await app.waitFor("text:code");
  await expect(app.shows("label:Open in Finder")).toBe(false);
});

test("a path typed on the Sources step browses the server's folders, filtered by what follows the last separator", async () => {
  const app = await sources();
  await app.type(FIELD, "/");
  await expect(app.value(FIELD)).toBe("/");
  // One segment per call: each directory entered loads and redraws, and the harness drops the rest of a call typed across that.
  for (const segment of ["Users/", "me/", "co"]) {
    await app.type(FIELD, segment);
    await app.waitUntil(() => app.value(FIELD)?.endsWith(segment) === true);
  }
  await expect(app.value(FIELD)).toBe("/Users/me/co");
  await app.waitUntil(() => app.texts().includes("code") && !app.texts().includes("docs"));
  await expect(app.texts()).not.toContain("No matching options.");
  await expect(app.texts()).toContain("Directories");
  await expect(app.shows("label:Create & Add (Enter)")).toBe(true);
  await expect(called(app, "filesystem.browse")).toBe(true);
  await app.submit(FIELD);
  await app.waitUntil(() => called(app, "projects.mutate"));
});

test("a ~ path typed in the root palette browses folders too", async () => {
  const app = await open("./AddProjectFixture.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.waitFor(FIELD);
  await app.type(FIELD, "~/");
  await expect(app.value(FIELD)).toBe("~/");
  await app.waitFor("text:docs");
  await app.type(FIELD, "do");
  await app.waitUntil(() => app.value(FIELD) === "~/do");
  await expect(app.value(FIELD)).toBe("~/do");
  await app.waitUntil(() => app.texts().includes("docs") && !app.texts().includes("code"));
});

// No app binding takes Backspace from the field (the headless keyboard has no caret keys, so Left is not expressible here).
test("Backspace edits the Add project field's text and no binding takes it", async () => {
  const app = await sources();
  for (const key of ["a", "b", "c", "d"]) await app.keyboard.press(key);
  await app.keyboard.press("backspace");
  await expect(app.value(FIELD)).toBe("abc");
  await expect(app.texts()).not.toContain("Sources");
});
