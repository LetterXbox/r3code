import { expect, test } from "nsh/test";
import { attachResumeFlags, noteAttachAnswered } from "./terminalAttachResume";

test("an unanswered attach retries unchanged; an answered one resumes", () => {
  expect(attachResumeFlags("a", false)).toEqual({ resume: false, restartIfNotRunning: false });
  expect(attachResumeFlags("a", false)).toEqual({ resume: false, restartIfNotRunning: false });
  noteAttachAnswered("a");
  expect(attachResumeFlags("a", false)).toEqual({ resume: true, restartIfNotRunning: false });
  // A restart that the server never answered keeps asking for the restart on the next session.
  expect(attachResumeFlags("a", true)).toEqual({ resume: false, restartIfNotRunning: true });
  expect(attachResumeFlags("a", false)).toEqual({ resume: false, restartIfNotRunning: true });
  noteAttachAnswered("a");
  expect(attachResumeFlags("a", false)).toEqual({ resume: true, restartIfNotRunning: false });
});
