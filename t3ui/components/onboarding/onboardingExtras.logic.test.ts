import { expect, test } from "nsh/test";
import {
  groupOnboardingProjects,
  importWarning,
  isNewOnboardingProject,
  partitionOnboardingProjects,
  readAgentSessionScan,
  resolveOnboardingProjectId,
  splitOnboardingProjectPath,
  startLabel,
} from "./projectImport.logic";
import { hasCloudPublicConfig, welcomeOffersPhone } from "./phoneOffer";
import { installTerminalNote, quoteProviderBinary, resolveOnboardingProviderInstallCommand, resolveOnboardingProviderLoginCommand } from "./installCommands";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
// AgentSessionScanResult as the server sends it.
const scan = {
  scannedAt: day(0),
  truncated: true,
  candidates: [
    { path: "/work/alpha", title: "alpha", sources: ["claudeAgent"], threadCount: 5, lastActiveAt: day(1), alreadyImported: false, git: { remoteKey: "github.com/me/alpha", repository: "me/alpha" } },
    { path: "/work/alpha-wt", title: "alpha-wt", sources: ["codex"], threadCount: 2, lastActiveAt: day(3), alreadyImported: false, git: { remoteKey: "github.com/me/alpha", repository: "me/alpha" } },
    { path: "/work/old", title: "old", sources: ["pi", "bogus"], threadCount: 9, lastActiveAt: day(90), alreadyImported: true, projectId: "project-9", git: { remoteKey: null, repository: null } },
    { path: "/work/notes", title: "notes", sources: ["pi"], threadCount: 1, lastActiveAt: null, alreadyImported: false, git: null },
    { title: "broken" },
  ],
};

test("a scan reads into candidates, dropping unreadable ones and unknown sources", () => {
  const read = readAgentSessionScan(scan)!;
  expect(read.truncated).toBe(true);
  expect(read.candidates.map((candidate) => candidate.path)).toEqual(["/work/alpha", "/work/alpha-wt", "/work/old", "/work/notes"]);
  expect(read.candidates[2]).toMatchObject({ sources: ["pi"], projectId: "project-9", alreadyImported: true });
  expect(read.candidates[3]!.git).toBe(null);
  expect(readAgentSessionScan({})).toBe(null);
});

test("the default picks are repositories with 3+ threads active in the last 30 days", () => {
  const { available, recent } = partitionOnboardingProjects(readAgentSessionScan(scan)!.candidates, NOW);
  expect(available.length).toBe(4);
  expect(recent.map((candidate) => candidate.path)).toEqual(["/work/alpha"]);
});

test("repositories group by remote, newest first, and folders that are not repositories stay apart", () => {
  const { repositories, other } = groupOnboardingProjects(readAgentSessionScan(scan)!.candidates);
  expect(repositories.map((group) => [group.label, group.candidates.length, group.threadCount])).toEqual([["me/alpha", 2, 7], ["old", 1, 9]]);
  expect(other.map((candidate) => candidate.path)).toEqual(["/work/notes"]);
});

test("a candidate is new unless the server matched it or a live project has its path", () => {
  const isNew = isNewOnboardingProject([{ workspaceRoot: "/work/alpha/" }]);
  expect(isNew({ path: "/work/alpha" })).toBe(false);
  expect(isNew({ path: "/work/beta" })).toBe(true);
  expect(isNew({ path: "/work/beta", projectId: "project-1" })).toBe(false);
  expect(resolveOnboardingProjectId([{ id: "p1", workspaceRoot: "/work/alpha" }], { path: "/work/alpha" })).toBe("p1");
  expect(resolveOnboardingProjectId([], { path: "/work/alpha", projectId: "p2" })).toBe("p2");
  expect(resolveOnboardingProjectId([], { path: "/work/alpha" })).toBe(null);
});

test("paths split into a muted parent and a name; the Start label and the warning follow the web", () => {
  expect(splitOnboardingProjectPath("/work/alpha/")).toEqual({ name: "alpha", parent: "/work/" });
  expect(splitOnboardingProjectPath("alpha")).toEqual({ name: "alpha", parent: "" });
  expect(startLabel({ importing: false, selected: 0, newCount: 0 })).toBe("Start");
  expect(startLabel({ importing: false, selected: 2, newCount: 1 })).toBe("Import 1 project and start");
  expect(startLabel({ importing: false, selected: 2, newCount: 2 })).toBe("Import 2 projects and start");
  expect(startLabel({ importing: false, selected: 2, newCount: 0 })).toBe("Import threads and start");
  expect(startLabel({ importing: true, selected: 2, newCount: 2 })).toBe("Importing…");
  expect(startLabel({ importing: true, selected: 0, newCount: 0 })).toBe("Starting…");
  expect(importWarning({ importedThreads: 3, skippedThreads: 1 })).toBe("Imported 3 threads. 1 thread could not be imported.");
  expect(importWarning({ importedThreads: 0, skippedThreads: 2 })).toBe("2 threads could not be imported.");
  expect(importWarning({ importedThreads: 1, skippedThreads: 0 })).toBe("Imported 1 thread. Some thread history could not be imported.");
  expect(importWarning({ importedThreads: 0, skippedThreads: 0 })).toBe("Could not import thread history.");
});

test("the Phone band needs the primary computer, T3 Connect, share access and a policy that allows both", () => {
  const input = { isPrimary: true, cloud: true, canShare: true, policy: undefined };
  expect(hasCloudPublicConfig()).toBe(true);
  expect(welcomeOffersPhone(input)).toBe(true);
  expect(welcomeOffersPhone({ ...input, isPrimary: false })).toBe(false);
  expect(welcomeOffersPhone({ ...input, cloud: false })).toBe(false);
  expect(welcomeOffersPhone({ ...input, canShare: false })).toBe(false);
  expect(welcomeOffersPhone({ ...input, policy: { limits: { clients: ["local"] } } })).toBe(false);
  expect(welcomeOffersPhone({ ...input, policy: { limits: { connect: false } } })).toBe(false);
  expect(welcomeOffersPhone({ ...input, policy: { limits: { clients: ["local", "remote"] } } })).toBe(true);
});

test("the setup terminal types the native install command, or the login command with the configured binary", () => {
  expect(resolveOnboardingProviderInstallCommand("claudeAgent", "darwin")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  expect(resolveOnboardingProviderInstallCommand("codex", "windows")).toBe("irm https://chatgpt.com/codex/install.ps1 | iex");
  expect(resolveOnboardingProviderLoginCommand({ instanceId: "claudeAgent", driver: "claudeAgent" }, null, "darwin")).toBe("claude auth login");
  expect(resolveOnboardingProviderLoginCommand({ instanceId: "codex", driver: "codex" }, null, "linux")).toBe("codex login");
  expect(resolveOnboardingProviderLoginCommand({ instanceId: "codex", driver: "codex" }, { providerInstances: { codex: { config: { binaryPath: "/opt/my codex/bin" } } } }, "darwin")).toBe("'/opt/my codex/bin' login");
  expect(quoteProviderBinary("~/bin/codex x", "codex", "darwin")).toBe("~/'bin/codex x'");
  expect(quoteProviderBinary("C:\\Program Files\\codex.exe", "codex", "windows")).toBe("& 'C:\\Program Files\\codex.exe'");
  expect(installTerminalNote("ready", true)).toBe("Review the command, then press Enter to run it.");
  expect(installTerminalNote("ready", false)).toBe("This connection cannot control terminals.");
});
