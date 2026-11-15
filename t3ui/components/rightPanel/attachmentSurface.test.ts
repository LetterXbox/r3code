import { expect, test } from "nsh/test";
import { initialPanelState, navigateFolderSurface, openAttachmentSurface, openFileSurface, openSurface, readPanelState, surfaceTitle } from "./panelLogic";
import { attachmentKind } from "../files/AttachmentFileView";

const attachment = { id: "att-1", name: "notes.md", mimeType: "text/markdown", sizeBytes: 12 };

test("an attachment opens as a file tab named for it and replaces the standalone explorer", () => {
  const withFiles = openSurface(initialPanelState, "files");
  const next = openAttachmentSurface(withFiles, attachment);
  expect(next.surfaces.map((surface) => surface.id)).toEqual(["attachment:att-1"]);
  expect(next.activeId).toBe("attachment:att-1");
  expect(surfaceTitle(next.surfaces[0]!)).toBe("notes.md");
  expect(openAttachmentSurface(next, attachment).surfaces.length).toBe(1);
});

test("an attachment tab survives a restart as an attachment, not as a workspace file", () => {
  const next = openAttachmentSurface(initialPanelState, attachment);
  const restored = readPanelState(JSON.parse(JSON.stringify(next)), 900);
  expect(restored.surfaces[0]).toEqual({ id: "attachment:att-1", kind: "file", relativePath: "notes.md", attachment });
});

test("a restored attachment retains the conversation that owns its bytes", () => {
  const linked = { ...attachment, threadId: "saved:box:thread-1" };
  const opened = openAttachmentSurface(initialPanelState, linked);
  const restored = readPanelState(JSON.parse(JSON.stringify(opened)), 900);
  expect(restored.surfaces[0]?.attachment).toEqual(linked);
});

test("moving a file tab up keeps the deepest path as its folder trail", () => {
  const opened = openFileSurface(initialPanelState, "src/lib/util.ts");
  const up = navigateFolderSurface(opened, "file:src/lib/util.ts", "src/lib", "src/lib/util.ts");
  expect(up.surfaces.map((surface) => surface.id)).toEqual(["file:src/lib"]);
  expect(up.surfaces[0]?.folderTrail).toBe("src/lib/util.ts");
  const root = navigateFolderSurface(up, "file:src/lib", "", "src/lib/util.ts");
  expect(root.surfaces[0]).toEqual({ id: "files", kind: "files", folderTrail: "src/lib/util.ts" });
  const beside = navigateFolderSurface(opened, "file:src/lib/util.ts", "src", "src", true);
  expect(beside.surfaces.map((surface) => surface.id)).toEqual(["file:src/lib/util.ts", "file:src"]);
  expect(beside.surfaces[1]?.folderTrail).toBeUndefined();
});

test("an attachment picks its viewer from its name, then its type", () => {
  expect(attachmentKind({ name: "a.zip", mimeType: "application/octet-stream" })).toBe("archive");
  expect(attachmentKind({ name: "clip", mimeType: "video/mp4" })).toBe("video");
  expect(attachmentKind({ name: "data.csv", mimeType: "text/csv" })).toBe("table");
  expect(attachmentKind({ name: "run.log", mimeType: "" })).toBe("text");
  expect(attachmentKind({ name: "blob", mimeType: "application/octet-stream" })).toBe("unsupported");
});
