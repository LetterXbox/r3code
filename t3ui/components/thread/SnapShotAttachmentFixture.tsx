import { mount, signal, View } from "nsh";
import { createThread } from "../../store";
import { markSnapShotCapture } from "../../desktop/snapShotArrival";
import { AttachmentList, type AttachmentDisplay } from "./AttachmentControls";

createThread(null);
markSnapShotCapture("window-2026-01-01T00-00-00.000Z.png", new Date().toISOString());
const items = signal<AttachmentDisplay[]>([
  { id: "snap", name: "window-2026-01-01T00-00-00.000Z.png", mimeType: "image/png", sizeBytes: 70, kind: "image", status: "uploaded" },
  { id: "photo", name: "photo.png", mimeType: "image/png", sizeBytes: 70, kind: "image", status: "uploaded" },
]);
function Fixture() {
  return <View class="p-2">
    <AttachmentList items={items} disabled={() => false} onRemove={(id) => items.update((all) => all.filter((item) => item.id !== id))} onRetry={async () => {}} />
  </View>;
}
mount(Fixture);
