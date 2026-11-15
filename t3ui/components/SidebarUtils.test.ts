import { expect, test } from "nsh/test";
import { sidebarProjectIdentity, sidebarRelativeTime, sidebarTimestampTooltip, sortSidebarProjects } from "./SidebarUtils";

test("project identity follows the reference monogram rules", async () => {
  await expect(sidebarProjectIdentity("T3code").label).toBe("T3");
  await expect(sidebarProjectIdentity("Alpha Beta").label).toBe("AB");
  await expect(sidebarProjectIdentity("alpha").label).toBe("AA");
  await expect(sidebarProjectIdentity("---").label).toBe("PR");
  await expect(sidebarProjectIdentity("  Alpha Beta ").colors[0]).toBe(sidebarProjectIdentity("alpha beta").colors[0]);
  const dark = sidebarProjectIdentity("Alpha", "dark", "#000000ff");
  const ocean = sidebarProjectIdentity("Alpha", "dark", "#223344ff");
  const light = sidebarProjectIdentity("Alpha", "light", "#fafafaff");
  await expect(dark.colors[1] === ocean.colors[1]).toBe(false);
  await expect(dark.colors[0] === light.colors[0]).toBe(false);
});

test("projects sort by the latest user message or by thread creation", async () => {
  const projects = [
    { id: "a", name: "Alpha", createdAt: 50, updatedAt: 60, threads: [{ updatedAt: 100, createdAt: 10, latestUserMessageAt: 90 }] },
    { id: "b", name: "Beta", createdAt: 20, updatedAt: 30, threads: [{ updatedAt: 80, createdAt: 20, latestUserMessageAt: 70 }] },
    { id: "c", name: "Gamma", createdAt: 5, updatedAt: 6, threads: [] },
  ];
  await expect(sortSidebarProjects(projects, "updated_at").map((project) => project.id).join(",")).toBe("a,b,c");
  await expect(sortSidebarProjects(projects, "created_at").map((project) => project.id).join(",")).toBe("b,a,c");
  await expect(sortSidebarProjects(projects, "manual").map((project) => project.id).join(",")).toBe("a,b,c");
  const pinned = projects.map((project) => ({ ...project, pinned: project.id === "c" }));
  await expect(sortSidebarProjects(pinned, "updated_at").map((project) => project.id).join(",")).toBe("c,a,b");
  await expect(sortSidebarProjects(pinned, "manual").map((project) => project.id).join(",")).toBe("c,a,b");
});

test("timestamp tooltips honor twelve and twenty four hour formats", async () => {
  const time = new Date(2026, 0, 21, 15, 9).getTime();
  await expect(sidebarTimestampTooltip(time, "12-hour").includes("3:09")).toBe(true);
  await expect(sidebarTimestampTooltip(time, "24-hour").includes("15:09")).toBe(true);
  await expect(sidebarTimestampTooltip(time, "24-hour").includes("21st January 2026")).toBe(true);
});

test("thread timestamps use elapsed time and ignore missing sort keys", async () => {
  const now = 1_800_000_000_000;
  await expect(sidebarRelativeTime(0, now)).toBe("");
  await expect(sidebarRelativeTime(42, now)).toBe("");
  await expect(sidebarRelativeTime(now + 1000, now)).toBe("now");
  await expect(sidebarRelativeTime(now - 60_000, now)).toBe("1m");
  await expect(sidebarRelativeTime(now - 3_600_000, now)).toBe("1h");
  await expect(sidebarRelativeTime(now - 86_400_000, now)).toBe("1d");
  await expect(sidebarRelativeTime(now - 7 * 86_400_000, now)).toBe("7d");
  await expect(sidebarRelativeTime(now - 60 * 86_400_000, now)).toBe("60d");
  await expect(sidebarRelativeTime(now - 364 * 86_400_000, now)).toBe("364d");
  await expect(sidebarRelativeTime(now - 365 * 86_400_000, now)).toBe("365d");
});
