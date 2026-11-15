import { expect, test } from "nsh/test";
import { applyShellEventForTest, updateSetting } from "../../store";
import { groupSidebarProjects, logicalKey, parseOverrides, physicalProjectKey } from "./projectGrouping";
import { sidebarSections } from "./sidebarModel";

const identity = { canonicalKey: "github.com/acme/shop", displayName: "acme/shop", rootPath: "/work/shop" };
const project = (id: string, path: string, name = "shop") => ({ id, name, path, threads: [], repositoryIdentity: { ...identity }, createdAt: 1, updatedAt: 2 });
const env = "environment-live";

test("checkouts of one repository share a folder, and a rule can keep one apart or split by path", () => {
  const projects = [project("a", "/work/shop"), project("b", "/work/shop/apps/web", "web"), project("c", "/elsewhere/shop")];
  expect(logicalKey(projects[0]!, env, "repository")).toBe("github.com/acme/shop");
  expect(logicalKey(projects[1]!, env, "repository_path")).toBe("github.com/acme/shop::apps/web");
  expect(logicalKey(projects[0]!, env, "separate")).toBe(`${env}:/work/shop`);
  expect(logicalKey({ path: "/x", repositoryIdentity: undefined }, env, "repository")).toBe(`${env}:/x`);
  expect(groupSidebarProjects(projects, { environmentId: env, globalMode: "repository", overrides: {} })).toHaveLength(1);
  expect(groupSidebarProjects(projects, { environmentId: env, globalMode: "repository_path", overrides: {} }).map((group) => group.id)).toEqual(["a", "b"]);
  expect(groupSidebarProjects(projects, { environmentId: env, globalMode: "separate", overrides: {} })).toHaveLength(3);
  const own = JSON.stringify({ [physicalProjectKey(env, "/elsewhere/shop")]: "separate" });
  expect(groupSidebarProjects(projects, { environmentId: env, globalMode: "repository", overrides: own }).map((group) => group.id)).toEqual(["a", "c"]);
  expect(parseOverrides('{"k":"separate","j":"bogus"}')).toEqual({ k: "separate" });
});

test("the sidebar's folders follow the grouping rule of each checkout", () => {
  applyShellEventForTest({ kind: "snapshot", snapshot: {
    projects: [
      { id: "p1", title: "shop", workspaceRoot: "/work/shop", repositoryIdentity: identity, pinnedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: "p2", title: "shop", workspaceRoot: "/other/shop", repositoryIdentity: identity, pinnedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ],
    threads: [],
  } });
  updateSetting("boringSidebarEnabled", true);
  updateSetting("sidebarProjectGroupingMode", "repository");
  updateSetting("sidebarProjectGroupingOverrides", "{}");
  const folders = () => sidebarSections().projects.map((folder) => folder.id);
  // Pinned folders stay listed while empty, so the model shows them all.
  expect(folders()).toEqual(["p1"]);
  updateSetting("sidebarProjectGroupingOverrides", JSON.stringify({ [physicalProjectKey("", "/other/shop")]: "separate" }));
  expect(folders().sort()).toEqual(["p1", "p2"]);
  updateSetting("sidebarProjectGroupingOverrides", "{}");
  updateSetting("sidebarProjectGroupingMode", "separate");
  expect(folders().sort()).toEqual(["p1", "p2"]);
});

test("multi-environment groups: per-checkout environment keys, presence, badge copy and picker entries", async () => {
  const { environmentPresence, projectGroupEnvironmentDescription, projectGroupsSpanEnvironments, projectPickerEntries } = await import("./projectGrouping");
  const id = { canonicalKey: "github.com/acme/app" };
  const p = (pid: string, path: string, environmentId?: string, repositoryIdentity: unknown = { ...id, rootPath: path }) =>
    ({ id: pid, name: pid, path, threads: [], repositoryIdentity, ...(environmentId ? { environmentId } : {}) }) as never;
  const local = p("p1", "/repo");
  const remote = p("saved:a:p2", "/srv/app", "saved:a");
  const same = p("saved:b:p3", "/repo", "saved:b", null);
  const sameLocal = p("p4", "/repo", undefined, null);
  const input = { environmentId: "env-1", globalMode: "repository", overrides: "{}" };
  // Two checkouts without a repository at the same folder on different machines stay apart.
  expect(groupSidebarProjects([same, sameLocal], input).length).toBe(2);
  expect(environmentPresence([local, remote])).toBe("mixed");
  expect(environmentPresence([remote])).toBe("remote-only");
  expect(environmentPresence([local])).toBe("local-only");
  expect(projectGroupsSpanEnvironments([local, sameLocal])).toBe(false);
  expect(projectGroupsSpanEnvironments([local, remote])).toBe(true);
  const label = (env: string) => (env === "saved:a" ? "Box" : null);
  expect(projectGroupEnvironmentDescription([local, remote], label)).toBe("Also on Box");
  expect(projectGroupEnvironmentDescription([remote, same], label)).toBe("On Box, Remote");
  expect(projectGroupEnvironmentDescription([local], label)).toBe(null);
  const entries = projectPickerEntries([sameLocal, local, remote], input, "saved:a:p2");
  expect(entries.map((e) => [e.target.id, e.isPreferred, e.members.length])).toEqual([["saved:a:p2", true, 2], ["p4", false, 1]]);
});
