import { mount, signal, Text, View } from "nsh";
import { AttachmentFileView } from "./AttachmentFileView";
import { base64Bytes, ZIP_BASE64 } from "./binaryFixtures";

const files = { text: { id: "t", name: "notes.txt", mimeType: "text/plain", sizeBytes: 11 }, zip: { id: "z", name: "x.zip", mimeType: "application/zip", sizeBytes: 316 }, bin: { id: "b", name: "blob", mimeType: "application/octet-stream", sizeBytes: 3 } };
const current = signal<keyof typeof files>("text");
const load = async (id: string) => new Blob([id === "z" ? base64Bytes(ZIP_BASE64) : new TextEncoder().encode("hello text")]);
mount(() => (
  <View class="flex-1">
    <View class="flex-row">{(Object.keys(files) as (keyof typeof files)[]).map((key) => <View role="button" accessibilityLabel={`open ${key}`} onPress={() => current.set(key)}><Text>{key}</Text></View>)}</View>
    <AttachmentFileView attachment={files[current()]} load={load} />
  </View>
));
