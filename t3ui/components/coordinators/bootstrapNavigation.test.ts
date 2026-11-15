import { expect, test } from "nsh/test";
import { applyShellEventForTest, isCollapsed, openThread, toggleProject } from "../../store";
import { handleBootstrapWelcome, resetBootstrapNavigation } from "./bootstrapNavigation";
import type { ServerWelcome } from "./serverStreams";

const welcome = (threadId: string): ServerWelcome => ({ environmentId: "e", cwd: "/w", projectName: "w", bootstrapStatus: "complete",
  bootstrapProjectId: "p", bootstrapThreadId: threadId, bootstrapProjectCreated: true, bootstrapThreadCreated: true });

test("a welcome expands the bootstrap project and opens its thread once on the root view", () => {
  resetBootstrapNavigation();
  const thread = (id: string) => ({ id, projectId: "p", title: id, status: "idle", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "w" }], threads: [thread("first"), thread("boot")] } });
  if (!isCollapsed("p")) toggleProject("p");
  expect(handleBootstrapWelcome(welcome("boot"), { onRoot: false })).toBe("expanded");
  expect(isCollapsed("p")).toBe(false);
  expect(handleBootstrapWelcome(welcome("boot"), { onRoot: true })).toBe("opened");
  expect(openThread()?.id).toBe("boot");
  expect(handleBootstrapWelcome(welcome("boot"), { onRoot: true })).toBe("expanded");
  expect(handleBootstrapWelcome({ ...welcome("boot"), bootstrapThreadId: null }, { onRoot: true })).toBe(null);
});
