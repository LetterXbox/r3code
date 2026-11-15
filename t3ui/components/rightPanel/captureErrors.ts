// preview/captureErrors.ts normalizeCaptureFailure + contracts previewCapture.ts PreviewCaptureFailure.message: a failed
// capture says why in the reference's words. The host's rejections (patches 0015 webview.capture, 0016 recordStart) are
// classified by their text, as the reference classifies its PreviewManagerError tags.
export type CaptureFailureReason = "renderer-unavailable" | "capture-unavailable" | "capture-timeout" | "recording-conflict" | "capture-failed";
export type CaptureFailureStage = "screenshot" | "capture-page" | "recording-start";

export function captureFailureMessage(reason: CaptureFailureReason, stage: CaptureFailureStage): string {
  switch (reason) {
    case "renderer-unavailable": return "The preview renderer is unavailable. Reopen the preview tab before retrying.";
    case "capture-unavailable": return "The preview capture surface is unavailable. Present the target tab and check that the preview host is unlocked, its display is on and its window is restored before retrying.";
    case "capture-timeout": return `Preview capture timed out during ${stage}. Check the preview host's lock, display and window state before retrying.`;
    case "recording-conflict": return "A recording capture is already starting, stopping or active. Wait for it to settle, or stop the active recording before retrying.";
    case "capture-failed": return `Preview capture failed during ${stage}. Check the preview host and target tab before retrying.`;
  }
}

/** normalizeCaptureFailure for a host rejection. */
export function normalizeCaptureFailure(error: unknown, stage: CaptureFailureStage): { reason: CaptureFailureReason; stage: CaptureFailureStage; message: string } {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  let reason: CaptureFailureReason = "capture-failed";
  if (/no web view is shown|no web ?view/i.test(text)) reason = "renderer-unavailable";
  else if (/already (active|recording)|already recording|another browser tab is already recording/i.test(text)) reason = "recording-conflict";
  else if (/timed? ?out|timeout/i.test(text)) reason = "capture-timeout";
  else if (/unknown (host )?call|not (a )?host call|no such call|unsupported|could not create image/i.test(text)) reason = "capture-unavailable";
  return { reason, stage, message: captureFailureMessage(reason, stage) };
}

/** The toast's description: the port's own refusals (no data folder) keep their words, a host failure is normalized. */
export function captureFailureDescription(error: unknown, stage: CaptureFailureStage): string {
  const text = error instanceof Error ? error.message : "";
  return /no data folder/i.test(text) ? text : normalizeCaptureFailure(error, stage).message;
}
