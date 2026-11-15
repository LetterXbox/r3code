import { mount, platform, signal, Text, View } from "nsh";
import { draftPreview } from "../composer/draftPreview";
import { expandedMediaPreview } from "./markdown/ExpandedMedia";
import { configureDesktop } from "../../desktop/runtime";
import { createThread } from "../../store";
import { AttachmentControl, AttachmentList, type AttachmentDisplay } from "./AttachmentControls";

createThread(null);
// The system file dialog (osascript `choose file`) answers with two picked paths.
configureDesktop({ os: () => platform.os, run: async () => ({ code: 0, stdout: "/tmp/report.txt\n/tmp/notes.md\n", stderr: "" }) });
const items = signal<AttachmentDisplay[]>([
  { id: "photo", name: "photo.png", mimeType: "image/png", sizeBytes: 70, kind: "image", status: "uploaded" },
  { id: "failed", name: "failed.txt", mimeType: "text/plain", sizeBytes: 25, kind: "file", status: "failed", error: "Upload failed" },
  { id: "clip", name: "clip.mp4", mimeType: "video/mp4", sizeBytes: 9, kind: "file", status: "uploaded" },
  { id: "notes", name: "notes.txt", mimeType: "text/plain", sizeBytes: 11, kind: "file", status: "uploaded" },
  { id: "restored", name: "restored.md", mimeType: "text/markdown", sizeBytes: 40, kind: "file", status: "failed", error: "Choose this file again to retry the upload." },
]);
function Fixture() {
  return <View>
    <Text>{`draft-preview:${draftPreview()?.attachment.name ?? ""}`}</Text>
    <Text>{`gallery:${(expandedMediaPreview()?.items ?? []).map((item) => item.name).join(",")}@${expandedMediaPreview()?.index ?? -1}`}</Text>
    <AttachmentList items={items} disabled={() => false}
      fileFor={(id) => id === "clip" ? new File([new Uint8Array(9)], "clip.mp4", { type: "video/mp4" }) : id === "notes" ? new File(["hello there"], "notes.txt", { type: "text/plain" }) : id === "photo" ? new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], "photo.png", { type: "image/png" }) : undefined}
      onRemove={(id) => items.update((all) => all.filter((item) => item.id !== id))}
      onRetry={async (id) => items.update((all) => all.map((item) => item.id === id ? { ...item, status: "uploaded" } : item))}
    />
    <AttachmentControl enabled={() => true} filesAllowed={() => true}
      onAddFile={async (file) => items.update((all) => [...all, { id: file.name, name: file.name, mimeType: file.type, sizeBytes: file.size, kind: "image", status: "uploaded" }])}
      onAddPath={async (path) => items.update((all) => [...all, { id: path, name: path, mimeType: "text/plain", sizeBytes: 1, kind: "file", status: "uploaded" }])}
    />
  </View>;
}
mount(Fixture);
