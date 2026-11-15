import { expect, test } from "nsh/test";
import { focusPreviewUrl, previewResetZoom, previewZoomIn, previewZoomOut, registerPreviewControls, zoomedFactor } from "./previewControls";
import { overridePanelContext } from "./panelState";
import { overridePreviewScope } from "./previewScope";
import { describePreviewError, previewErrorLabel, previewHost } from "./previewLogic";

test("the preview commands answer for the browser tab in front and say when there is none", () => {
  // On a thread whose environment grants the preview operate scope (chatRouteCommands.ts canOperatePreview).
  overridePanelContext({ key: "thread-key", workspace: { threadId: "t1", cwd: "/p" } });
  overridePreviewScope("granted");
  expect(focusPreviewUrl()).toBe(false);
  expect(previewZoomIn()).toBe(false);
  const calls: string[] = [];
  let backgroundActive = false;
  const release = registerPreviewControls({ focusUrl: () => calls.push("focus"), zoomBy: (direction) => calls.push(direction) });
  const releaseBackground = registerPreviewControls({ focusUrl: () => calls.push("bg-focus"), zoomBy: (direction) => calls.push(`bg-${direction}`), isActive: () => backgroundActive });
  expect(focusPreviewUrl()).toBe(true);
  expect(previewZoomIn()).toBe(true);
  expect(previewZoomOut()).toBe(true);
  expect(previewResetZoom()).toBe(true);
  expect(calls).toEqual(["focus", "in", "out", "reset"]);
  backgroundActive = true;
  focusPreviewUrl();
  expect(calls[calls.length - 1]).toBe("bg-focus");
  releaseBackground();
  release();
  expect(focusPreviewUrl()).toBe(false);
  overridePanelContext(null);
  overridePreviewScope(null);
});

test("without the preview operate scope the commands claim their key and do nothing; off a thread they fall through", () => {
  const calls: string[] = [];
  const release = registerPreviewControls({ focusUrl: () => calls.push("focus"), zoomBy: (direction) => calls.push(direction) });
  overridePanelContext({ key: "thread-key", workspace: { threadId: "t1", cwd: "/p" } });
  overridePreviewScope("denied");
  expect(focusPreviewUrl()).toBe(true);
  expect(previewZoomIn()).toBe(true);
  expect(previewZoomOut()).toBe(true);
  expect(previewResetZoom()).toBe(true);
  expect(calls).toEqual([]);
  overridePreviewScope("unknown");
  expect(previewZoomIn()).toBe(true);
  expect(calls).toEqual([]);
  overridePanelContext({ key: null, workspace: null });
  expect(focusPreviewUrl()).toBe(false);
  overridePanelContext(null);
  overridePreviewScope(null);
  release();
});

test("zoom commands step through the preset factors", () => {
  expect(zoomedFactor(1, "in")).toBe(1.1);
  expect(zoomedFactor(1, "out")).toBe(0.9);
  expect(zoomedFactor(2, "reset")).toBe(1);
});

test("the unreachable page words a Chromium error code and names the host", () => {
  expect(describePreviewError("ERR_CONNECTION_REFUSED")).toBe("Connection refused");
  expect(describePreviewError("something odd")).toBe("something odd");
  expect(describePreviewError("")).toBe("Network error");
  expect(previewErrorLabel("")).toBe("ERR_FAILED");
  // fm13: ERR_<code> when the description is empty and a code came with the error.
  expect(previewErrorLabel("", "-105")).toBe("ERR_105");
  expect(previewErrorLabel("", "NSURLError")).toBe("ERR_FAILED");
  expect(previewHost("http://localhost:3000/app")).toBe("localhost:3000");
  expect(previewHost("not a url")).toBe("not a url");
});
