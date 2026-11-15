import { expect, test } from "nsh/test";
import { applyCloneSnapshots, projectCloneBannerItem, projectCloneSendBlockReason, setAddProjectBackend, submitCloneDestination } from "./addProjectState";
import { overrideSessionScope } from "../../../backend/sessionScopes";
import { clearToasts, visibleToasts } from "../../toast/toastState";
import { createThread, openThread } from "../../../store";
import { projectFileCopies } from "../../../environments/addProjectToMachine";

const snapshot = (phase: string, extra: Record<string, unknown> = {}) => ({ projectId: "p1", destinationPath: "/x/repo", repository: { nameWithOwner: "o/repo" }, phase, stage: "receiving", percent: 40, detail: null, stalled: false, error: null, ...extra });

test("a running clone shows Cloning <name> with its progress and Cancel, and blocks sending", () => {
  applyCloneSnapshots([snapshot("running")]);
  const item = projectCloneBannerItem("p1");
  expect(item?.title).toBe("Cloning o/repo");
  expect(item?.description).toBe("Receiving objects · 40%");
  expect(item?.actions.map((action) => action.label)).toEqual(["Cancel"]);
  expect(projectCloneSendBlockReason("p1")).toBe("Cloning repository");
  expect(projectCloneBannerItem("other")).toBe(null);
});

test("cancelled and failed clones offer Remove project and Retry; a done clone clears", () => {
  applyCloneSnapshots([snapshot("cancelled")]);
  expect(projectCloneBannerItem("p1")?.title).toBe("Cancelled cloning o/repo");
  expect(projectCloneBannerItem("p1")?.description).toBe("Retry to bring in the repository.");
  expect(projectCloneBannerItem("p1")?.variant).toBe("warning");
  applyCloneSnapshots([snapshot("failed", { error: "auth failed" })]);
  expect(projectCloneBannerItem("p1")?.title).toBe("Failed to clone o/repo");
  expect(projectCloneBannerItem("p1")?.actions.map((action) => action.label)).toEqual(["Remove project", "Retry"]);
  expect(projectCloneSendBlockReason("p1")).toBe("Repository not cloned");
  applyCloneSnapshots([snapshot("done")]);
  expect(projectCloneBannerItem("p1")).toBe(null);
  expect(projectCloneSendBlockReason("p1")).toBe(null);
  applyCloneSnapshots([]);
});

test("file copies block sending while copying and show a dismissible failure banner", () => {
  projectFileCopies.set({ "m1:p1": { phase: "copying" } });
  expect(projectCloneSendBlockReason("p1")).toBe("Copying files");
  projectFileCopies.set({ "m1:p1": { phase: "failed", title: "Could not copy 1 file to Mac", failures: [".env"] } });
  const item = projectCloneBannerItem("p1");
  expect(item?.id).toBe("project-file-copy:p1");
  expect(item?.description).toBe(".env");
  item?.onDismiss?.();
  expect(projectCloneBannerItem("p1")).toBe(null);
});

test("a failed clone toast lists Remove project before Retry", () => {
  clearToasts();
  applyCloneSnapshots([snapshot("failed", { projectId: "p3", error: "auth failed" })]);
  const toast = visibleToasts().find((item) => item.title === "Failed to clone o/repo");
  expect(toast?.actions.map((action) => action.label)).toEqual(["Remove project", "Retry"]);
  applyCloneSnapshots([]);
  clearToasts();
});

test("a clone whose project draft is on screen shows no progress toast, but a failure toasts once it is off screen", () => {
  clearToasts();
  createThread("p2");
  expect(openThread()?.projectId).toBe("p2");
  applyCloneSnapshots([snapshot("running", { projectId: "p2" })]);
  expect(visibleToasts()).toHaveLength(0);
  createThread("elsewhere");
  applyCloneSnapshots([snapshot("running", { projectId: "p2", percent: 50 })]);
  expect(visibleToasts()).toHaveLength(0);
  applyCloneSnapshots([snapshot("failed", { projectId: "p2", error: "boom" })]);
  expect(visibleToasts().map((item) => item.title)).toEqual(["Failed to clone o/repo"]);
  applyCloneSnapshots([]);
  clearToasts();
});

test("a clone without source-control:write is refused before any request, with the reference's copy", async () => {
  clearToasts();
  const asked: string[] = [];
  setAddProjectBackend({ connected: () => true, request: async (method) => { asked.push(method); return {}; } });
  overrideSessionScope("source-control:write", "denied");
  const ok = await submitCloneDestination({ step: "confirm", source: "url", repositoryInput: "x", repository: null, remoteUrl: "https://example.com/a.git" } as never, "/tmp/a", { platform: "macos", currentProjectCwd: null });
  expect(ok).toBe(false);
  expect(asked).toEqual([]);
  expect(visibleToasts().map((toast) => [toast.title, toast.description])).toEqual([["Clone unavailable", "This connection needs permission to write source control and add projects."]]);
  overrideSessionScope("source-control:write", null);
  setAddProjectBackend(null);
  clearToasts();
});
