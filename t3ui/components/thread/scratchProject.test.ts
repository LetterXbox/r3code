import { expect, test } from "nsh/test";
import { setRequestBackendForTest } from "../../store";
import { clearToasts, visibleToasts } from "../toast/toastState";
import { SCRATCH_NOT_LOADED_MESSAGE, scratchProjectId, startWithoutProject } from "./scratchProject";

test("the scratch project id is read from the ensureScratch reply", () => {
  expect(scratchProjectId({ projectId: "project-1" })).toBe("project-1");
  expect(scratchProjectId({ projectId: "" })).toBe(null);
  expect(scratchProjectId(null)).toBe(null);
});

test("a failed start toasts the reference's title with the reason and opens nothing", async () => {
  clearToasts();
  setRequestBackendForTest(async () => { throw new Error("no scratch root"); });
  expect(await startWithoutProject()).toBe(false);
  expect(visibleToasts().map((toast) => [toast.type, toast.title, toast.description])).toEqual([["error", "Could not start without a project", "no scratch root"]]);
  clearToasts();
  setRequestBackendForTest(async () => ({ projectId: "scratch-never-arrives" }));
  expect(await startWithoutProject({ attempts: 2, delayMs: 1 })).toBe(false);
  expect(visibleToasts().map((toast) => toast.description)).toEqual([SCRATCH_NOT_LOADED_MESSAGE]);
  clearToasts();
  setRequestBackendForTest(null);
});
