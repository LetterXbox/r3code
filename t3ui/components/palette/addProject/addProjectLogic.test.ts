import { expect, test } from "nsh/test";
import {
  buildPaletteReadiness, buildSourceRows, filterBrowseEntries, getAddProjectInitialQuery, getBrowseTabCompletion, getCloneDestinationPath, getCloneDirectoryPath, getFilesystemBrowsePath,
  getNewProjectPathPreview, githubIncompleteOwnerRepositoryMessage, normalizePastedCloneUrl, newProjectFolderName, sortProviderSources,
} from "./addProjectLogic";

const github = { kind: "github", label: "GitHub", status: "available", installHint: "Install gh.", auth: { status: "authenticated", account: "octo", detail: null } };

test("Add Project starts a bare relative directory under home", () => {
  expect(getAddProjectInitialQuery("Desktop/dev")).toBe("~/Desktop/dev/");
  expect(getAddProjectInitialQuery("~/Desktop")).toBe("~/Desktop/");
  expect(getAddProjectInitialQuery("~")).toBe("~/");
  expect(getAddProjectInitialQuery("./work")).toBe("./work/");
  expect(getAddProjectInitialQuery("/srv/code")).toBe("/srv/code/");
  expect(getAddProjectInitialQuery("C:\\dev")).toBe("C:\\dev\\");
});

test("folder search ranks exact, prefix, substring and fuzzy matches", () => {
  const entries = ["slow-tools", "mytools", ".tools", "tools-server", "tools"].map(
    (name) => ({ name, fullPath: `/work/${name}` }),
  );
  const result = filterBrowseEntries(entries, "tools");
  expect(result.visibleEntries.map((entry) => entry.name)).toEqual(["tools", "tools-server", "slow-tools", "mytools"]);
  expect(result.exactEntry?.name).toBe("tools");
  expect(filterBrowseEntries(entries, "tls").visibleEntries.some((entry) => entry.name === "tools")).toBe(true);
  expect(filterBrowseEntries(entries, ".tools").exactEntry?.name).toBe(".tools");
});

test("readiness: only a signed-in provider is ready, and the hint names the palette's settings path", () => {
  const readiness = buildPaletteReadiness([github, { ...github, kind: "gitlab", label: "GitLab", auth: { status: "unauthenticated", account: null, detail: null } }]);
  expect(readiness("url").ready).toBe(true);
  expect(readiness("github").ready).toBe(true);
  expect(readiness("gitlab")).toEqual({ ready: false, hint: "GitLab is not authenticated. Open Source Control settings for setup guidance." });
  expect(readiness("bitbucket").hint).toBe("Provider status unavailable. Open Source Control settings and rescan.");
});

test("source rows: New project only with a projects root, ready hosts first", () => {
  const readiness = buildPaletteReadiness([github]);
  expect(sortProviderSources(readiness)[0]).toBe("github");
  const rows = buildSourceRows({ readiness, newProjectsRoot: null });
  expect(rows.map((row) => row.title).slice(0, 4)).toEqual(["Local folder", "Git URL", "GitHub repository", "Azure DevOps repository"]);
  expect(rows.find((row) => row.source === "azure-devops")?.setupRequired).toBeDefined();
  expect(buildSourceRows({ readiness, newProjectsRoot: "/p" })[0]!.title).toBe("New project");
});

test("clone destinations, shorthand and incomplete owner names", () => {
  expect(normalizePastedCloneUrl("octo/repo")).toBe("https://github.com/octo/repo.git");
  expect(githubIncompleteOwnerRepositoryMessage("github", "octo/")).toBe("Enter the full owner/repository name.");
  expect(getCloneDirectoryPath("git@github.com:octo/repo.git", true)).toBe("github.com/octo/repo");
  expect(getCloneDestinationPath("~/code", "repo")).toBe("~/code/repo");
  expect(getNewProjectPathPreview("/p", "My App!")).toBe("/p/my-app");
  expect(newProjectFolderName("***")).toBe("project");
});

test("browsing: a path with a leaf filters, Tab completes the common prefix", () => {
  const path = getFilesystemBrowsePath("~/co", "MacIntel");
  expect(path.directoryPath).toBe("~/");
  expect(path.filterQuery).toBe("co");
  const entries = [{ name: "code", fullPath: "/c" }, { name: "codex", fullPath: "/x" }];
  expect(getBrowseTabCompletion(entries, "co")).toEqual({ name: "code", isComplete: false });
});
