import { expect, test } from "nsh/test";
import type { Project } from "../store";
import { projectGroupMembers, updateProjectGroup, type ProjectGroupDeps } from "./projectGroupUpdate";

const identity = { canonicalKey: "github.com/acme/app", rootPath: "/repo" };
const project = (id: string, path: string, environmentId?: string, repositoryIdentity: unknown = { ...identity, rootPath: path }): Project =>
  ({ id, name: id, path, threads: [], repositoryIdentity, ...(environmentId ? { environmentId } : {}) }) as unknown as Project;

test("a project's group is every checkout sharing its logical key, itself first", () => {
  const local = project("p1", "/repo");
  const remote = project("saved:a:p2", "/home/me/app", "saved:a");
  const other = project("p3", "/elsewhere", undefined, null);
  const input = { primaryEnvironmentId: "env-1", globalMode: "repository", overrides: "{}" };
  expect(projectGroupMembers(remote, [local, remote, other], input).map((p) => p.id)).toEqual(["saved:a:p2", "p1"]);
  expect(projectGroupMembers(local, [local, remote, other], { ...input, globalMode: "separate" }).map((p) => p.id)).toEqual(["p1"]);
});

function deps(over: Partial<ProjectGroupDeps> = {}) {
  const calls: unknown[] = [];
  const toasts: string[][] = [];
  const base: ProjectGroupDeps = {
    label: (member) => (member.environmentId ? "Laptop" : "Studio"),
    connected: () => true,
    request: async (method, payload) => { calls.push([method, (payload as { projectId: string }).projectId, (payload as { pinned?: boolean }).pinned]); return {}; },
    toast: (title, description) => toasts.push([title, description]),
    ...over,
  };
  return { calls, toasts, deps: base };
}

test("the update goes to each checkout in turn; a disconnected machine or a failure stops it with a toast", async () => {
  const members = [project("p1", "/repo"), project("saved:a:p2", "/x", "saved:a")];
  const ok = deps();
  expect(await updateProjectGroup(members, { pinned: true }, "Failed to pin project", ok.deps)).toBe(true);
  expect(ok.calls).toEqual([["projects.mutate", "p1", true], ["projects.mutate", "saved:a:p2", true]]);

  const offline = deps({ connected: (member) => !member.environmentId });
  expect(await updateProjectGroup(members, { pinned: true }, "Failed to pin project", offline.deps)).toBe(false);
  expect(offline.calls).toEqual([]);
  expect(offline.toasts).toEqual([["Failed to pin project", "Connect Laptop and try again."]]);

  const failing = deps({ request: async () => { throw new Error("nope"); } });
  expect(await updateProjectGroup(members, { pinned: true }, "Failed to pin project", failing.deps)).toBe(false);
  expect(failing.toasts).toEqual([["Failed to pin project on Studio", "nope"]]);

  const single = deps({ request: async () => { throw new Error("nope"); } });
  await updateProjectGroup(members.slice(0, 1), { title: "x" }, "Failed to rename project", single.deps);
  expect(single.toasts).toEqual([["Failed to rename project", "nope"]]);
});
