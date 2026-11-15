import { expect, test } from "nsh/test";
import { captureFailureDescription, normalizeCaptureFailure } from "./captureErrors";

test("host rejections read as the reference's capture failures", () => {
  expect(normalizeCaptureFailure(new Error("no web view is shown"), "screenshot").reason).toBe("renderer-unavailable");
  expect(normalizeCaptureFailure(new Error("a preview recording is already active"), "recording-start").message).toBe("A recording capture is already starting, stopping or active. Wait for it to settle, or stop the active recording before retrying.");
  expect(normalizeCaptureFailure(new Error("host call timed out"), "capture-page").message).toBe("Preview capture timed out during capture-page. Check the preview host's lock, display and window state before retrying.");
  expect(normalizeCaptureFailure(new Error("boom"), "screenshot").message).toBe("Preview capture failed during screenshot. Check the preview host and target tab before retrying.");
  expect(captureFailureDescription(new Error("This app has no data folder to save the screenshot in."), "screenshot")).toBe("This app has no data folder to save the screenshot in.");
});
