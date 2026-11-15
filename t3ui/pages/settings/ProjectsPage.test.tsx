import { expect, open, test } from "nsh/test";
import { projectIconDescription, projectTitleNeedsUpdate, removeProjectMessage } from "./projectsLogic";

test("project helpers describe the icon, decide renames and word the removal", () => {
  expect(projectIconDescription(null, null)).toBe("Automatic");
  expect(projectIconDescription(null, "public/favicon.ico")).toBe("public/favicon.ico");
  expect(projectIconDescription({ kind: "emoji", emoji: "x" }, null)).toBe("x");
  expect(projectIconDescription({ kind: "lucide", name: "folder-code", color: "blue" }, null)).toBe("folder-code · blue");
  expect(projectIconDescription({ kind: "monogram", text: "LG", color: "red" }, null)).toBe("LG · red");
  expect(projectTitleNeedsUpdate("legion", " legion ", true)).toBe(false);
  expect(projectTitleNeedsUpdate("legion", "other", false)).toBe(false);
  expect(projectTitleNeedsUpdate("legion", "other", true)).toBe(true);
  expect(removeProjectMessage("legion", 2)).toContain("its 2 threads");
});

test("Projects asks for a project, then shows it with its pin, archive and removal", async () => {
  const app = await open("./ProjectsFixture.tsx", { width: 1100, height: 3000 });
  await expect(app.texts()).toContain("Choose a project to manage its name, icon, checkouts and actions.");
  await app.press("label:Project scope: All projects");
  await app.press("label:legion >> nth=1");
  for (const text of ["Can't find a setting? Keep this project picked above and hop to any other settings page.", "Name", "Project icon", "Automatic", "Pin", "Archive", "New threads", "Model for new threads in this project.", "Actions", "No actions configured.", "Checkouts", "/work/legion", "Danger", "Remove project"]) {
    await expect(app.texts()).toContain(text);
  }
  await app.press("label:Pin project");
  await app.wait(80);
  await expect(app.texts()).toContain(`call projects.mutate {"type":"project.update","projectId":"project:1","pinned":true}`);
  await app.press("label:Archive");
  await app.wait(80);
  await expect(app.texts()).toContain(`call projects.mutate {"type":"project.update","projectId":"project:1","archived":true}`);
});

import { checkoutKey, groupingLabel, parseGroupingOverrides, withGroupingOverride } from "./groupingRules";

test("a checkout's grouping rule is stored per checkout and falls back to the global mode", () => {
  expect(parseGroupingOverrides('{"e:/work/a":"separate","e:/work/b":"bogus"}')).toEqual({ "e:/work/a": "separate" });
  expect(parseGroupingOverrides("nope")).toEqual({});
  expect(withGroupingOverride({}, checkoutKey("e", "/work/a"), "separate")).toEqual({ "e:/work/a": "separate" });
  expect(withGroupingOverride({ "e:/work/a": "separate" }, "e:/work/a", "inherit")).toEqual({});
  expect(groupingLabel("inherit", "repository_path")).toBe("Default (Group by repository path)");
  expect(groupingLabel("separate", "repository")).toBe("Keep separate");
});

test("the Checkouts row sets and clears the grouping rule", async () => {
  const app = await open("./ProjectsFixture.tsx", { width: 1100, height: 3000 });
  await app.press("label:Project scope: All projects");
  await app.press("label:legion >> nth=1");
  await app.press("label:Grouping rule for /work/legion = inherit");
  await app.press("label:Keep separate");
  await expect(app.shows("label:Grouping rule for /work/legion = separate")).toBe(true);
});

import { faviconEmptyMessage, filterIconNames, firstEmoji, iconToSave, isValidMonogram, normalizeMonogram, parseImageEntries, relativeToWorkspace } from "./projectIconLogic";

test("the icon picker validates monograms and emoji and says what Save sends", () => {
  expect(normalizeMonogram(" lg ")).toBe("LG");
  expect(isValidMonogram("LG")).toBe(true);
  expect(isValidMonogram("")).toBe(false);
  expect(isValidMonogram("-x")).toBe(false);
  expect(firstEmoji("  🚀 go")).toBe("🚀");
  expect(firstEmoji("hello")).toBe(null);
  expect(filterIconNames("")).toHaveLength(24);
  expect(filterIconNames("")[0]).toBe("folder-code");
  expect(filterIconNames("git branch")).toEqual(["git-branch"]);
  expect(filterIconNames("o")).toContain("rocket");
  const draft = { mode: "monogram" as const, iconName: "pin", color: "red" as const, letters: "ab", emoji: "💻" };
  expect(iconToSave(draft)).toEqual({ kind: "monogram", text: "AB", color: "red" });
  expect(iconToSave({ ...draft, letters: "" })).toBe(null);
  expect(iconToSave({ ...draft, mode: "lucide" })).toEqual({ kind: "lucide", name: "pin", color: "red" });
  expect(iconToSave({ ...draft, mode: "emoji" })).toEqual({ kind: "emoji", emoji: "💻" });
});

test("the favicon picker lists image files and only takes files of the project folder", () => {
  expect(parseImageEntries({ entries: [{ path: "public/favicon.ico", kind: "file" }, { path: "assets", kind: "directory" }] })).toEqual([{ path: "public/favicon.ico", name: "favicon.ico" }]);
  expect(parseImageEntries(null)).toEqual([]);
  expect(relativeToWorkspace("/work/legion/", "/work/legion/public/logo.png")).toBe("public/logo.png");
  expect(relativeToWorkspace("/work/legion", "/Users/me/logo.png")).toBe(null);
  expect(faviconEmptyMessage("", null, true)).toBe("Indexing project files…");
  expect(faviconEmptyMessage("x", null, false)).toBe("No matching image files.");
  expect(faviconEmptyMessage("x", "boom", false)).toBe("boom");
});

test("Choose icon saves a monogram through project.update", async () => {
  const app = await open("./ProjectsFixture.tsx", { width: 1100, height: 3000 });
  await app.press("label:Project scope: All projects");
  await app.press("label:legion >> nth=1");
  await app.press("label:Choose a project icon");
  await app.press("label:Monogram");
  await app.press("label:Red");
  await app.press("label:Save icon");
  await app.wait(80);
  await expect(app.texts()).toContain(`call projects.mutate {"type":"project.update","projectId":"project:1","faviconPath":null,"projectIcon":{"kind":"monogram","text":"LE","color":"red"}}`);
});

test("a session that cannot operate the environment says it cannot change the project", async () => {
  const app = await open("./ProjectsFixture.tsx", { width: 1100, height: 3000 });
  await app.press("label:Project scope: All projects");
  await app.press("label:legion >> nth=1");
  await app.press("label:Deny writes");
  await expect(app.texts()).toContain("This connection cannot change this project.");
});
