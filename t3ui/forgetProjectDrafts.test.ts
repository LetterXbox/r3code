import { expect, test } from "nsh/test";
import { createThread, forgetProjectDrafts, openThread } from "./store";

test("fm13: removing a failed-clone project drops its draft and leaves the view of it", () => {
  createThread("p-removed");
  expect(openThread()?.projectId).toBe("p-removed");
  forgetProjectDrafts("p-removed");
  expect(openThread()?.projectId === "p-removed").toBe(false);
});
