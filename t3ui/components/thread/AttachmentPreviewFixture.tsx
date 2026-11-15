import { mount, signal, Text, View } from "nsh";
import { AttachmentPreview, type MessageAttachment } from "./AttachmentPreview";

const textAttachment: MessageAttachment = { id: "text", name: "notes.txt", type: "file", mimeType: "text/plain", sizeBytes: 11 };
const imageAttachment: MessageAttachment = { id: "slow", name: "photo.png", type: "image", mimeType: "image/png", sizeBytes: 10 };
const readyImage: MessageAttachment = { id: "image", name: "pixel.png", type: "image", mimeType: "image/png", sizeBytes: 68 };
const selected = signal<MessageAttachment | null>(null);
const aborted = signal(false);
function Fixture() {
  return <View class="flex-1">
    <View accessibilityLabel="Open text preview" onPress={() => selected.set(textAttachment)}><Text>Open text</Text></View>
    <View accessibilityLabel="Open slow preview" onPress={() => selected.set(imageAttachment)}><Text>Open slow</Text></View>
    <View accessibilityLabel="Open image preview" onPress={() => selected.set(readyImage)}><Text>Open image</Text></View>
    {aborted() ? <Text>Load cancelled</Text> : null}
    <If when={selected()}>{(attachment) => <AttachmentPreview
      attachment={attachment}
      onClose={() => selected.set(null)}
      load={(id, options) => id === "text" ? Promise.resolve(new Blob(["hello world"], { type: "text/plain" })) : id === "image" ? Promise.resolve(new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), (character) => character.charCodeAt(0))], { type: "image/png" })) : new Promise<Blob>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => { aborted.set(true); reject(new Error("Cancelled")); });
      })}
    />}</If>
  </View>;
}
mount(Fixture);
