import { expect, test } from "nsh/test";
import type { Project } from "../store";
import type { Machine } from "./machines";
import { logicalProjectEnvironments } from "./logicalProjectEnvironments";

const identity = { canonicalKey: "github.com/acme/app" };
const project = (id: string, path: string, environmentId?: string, repositoryIdentity: unknown = { ...identity, rootPath: path }): Project =>
  ({ id, name: id, path, threads: [], repositoryIdentity, ...(environmentId ? { environmentId } : {}) }) as unknown as Project;
const labels: Record<string, string> = { primary: "Studio", "saved:b": "Alpha box", "saved:c": "Zeta box" };
const machineOf = (p: { environmentId?: string }) => (p.environmentId === "saved:off" ? null : ({ label: labels[p.environmentId ?? "primary"], machine: "server" } as unknown as Machine));
const grouping = { primaryEnvironmentId: "env-1", globalMode: "repository", overrides: "{}" };

test("a draft can run on every connected machine holding its logical project, primary first then by label", () => {
  const zeta = project("saved:c:p3", "/z", "saved:c");
  const local = project("p1", "/repo");
  const alpha = project("saved:b:p2", "/a", "saved:b");
  const alphaTwin = project("saved:b:p4", "/a2", "saved:b");
  const offline = project("saved:off:p5", "/o", "saved:off");
  const other = project("p6", "/elsewhere", undefined, null);
  const options = logicalProjectEnvironments(zeta, [zeta, local, alpha, alphaTwin, offline, other], machineOf, grouping);
  expect(options.map((o) => [o.environmentId, o.projectId, o.label, o.isPrimary])).toEqual([
    ["primary", "p1", "Studio", true],
    ["saved:b", "saved:b:p2", "Alpha box", false],
    ["saved:c", "saved:c:p3", "Zeta box", false],
  ]);
  expect(logicalProjectEnvironments(other, [zeta, local, other], machineOf, grouping).map((o) => o.environmentId)).toEqual(["primary"]);
  expect(logicalProjectEnvironments(null)).toEqual([]);
});

test("a scratch draft can run on every machine offering a scratch root, with that machine's scratch project when listed", async () => {
  const { scratchProjectEnvironments } = await import("./logicalProjectEnvironments");
  const local = project("p1", "/scratch");
  const remoteScratch = project("saved:b:s", "/home/s", "saved:b");
  const machines = [
    { key: "primary", label: "Studio", machine: "laptop" },
    { key: "saved:b", label: "Alpha box", machine: "server" },
    { key: "saved:c", label: "Zeta box", machine: "server" },
    { key: "saved:d", label: "No scratch", machine: "server" },
  ] as unknown as Machine[];
  const roots: Record<string, string | null> = { primary: "/scratch", "saved:b": "/home/s", "saved:c": "/z", "saved:d": null };
  const options = scratchProjectEnvironments(local, [local, remoteScratch], machines, (key) => roots[key] ?? null);
  expect(options.map((o) => [o.environmentId, o.projectId])).toEqual([["primary", "p1"], ["saved:b", "saved:b:s"], ["saved:c", null]]);
});
