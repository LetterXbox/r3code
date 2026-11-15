import { mount, signal, Text, View } from "nsh";
import { MessageMedia } from "./MessageMedia";
import type { MessageAttachment } from "./AttachmentPreview";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = (id: string, name = `${id}.png`): MessageAttachment => ({ id, name, type: "image", mimeType: "image/png", sizeBytes: 68 });
const loads = signal<string[]>([]);
const opened = signal("");
const attachments = signal<MessageAttachment[]>([image("one")]);

function Fixture() {
  return (
    <View>
      <MessageMedia
        attachments={attachments}
        load={(id) => {
          loads.update((all) => [...all, id]);
          if (id === "broken") return Promise.reject(new Error("offline"));
          return Promise.resolve(new Blob([Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0))], { type: "image/png" }));
        }}
        onOpen={(attachment) => opened.set(attachment.id)}
      />
      <Text>{`Loaded ${loads().join(",")}`}</Text>
      {opened() ? <Text>{`Opened ${opened()}`}</Text> : null}
      <View accessibilityLabel="Three images" onPress={() => attachments.set([image("a"), image("b"), image("c")])}><Text>Three images</Text></View>
      <View accessibilityLabel="Video and audio" onPress={() => attachments.set([{ id: "v1", name: "clip.mp4", type: "file", mimeType: "video/mp4", sizeBytes: 2048 }, { id: "a1", name: "note.m4a", type: "file", mimeType: "audio/mp4", sizeBytes: 2048 }, { id: "big", name: "huge.mov", type: "file", mimeType: "video/quicktime", sizeBytes: 900 * 1024 * 1024 }])}><Text>Video and audio</Text></View>
      <View accessibilityLabel="Broken and file" onPress={() => attachments.set([image("broken", "lost.png"), { id: "f", name: "report.pdf", type: "file", mimeType: "application/pdf", sizeBytes: 2048 }])}><Text>Broken and file</Text></View>
    </View>
  );
}

mount(Fixture);
