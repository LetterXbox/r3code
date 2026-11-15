import { mount, signal, Text, View } from "nsh";
import type { Message } from "../../store";
import { MessageRow } from "./MessageRow";
import { AnchoredToastHost } from "../toast/AnchoredToastHost";
import { loadShikiLanguage } from "./markdown/shikiHighlight";

// The first ts block compiles its Shiki grammar on a timer after mount (~330ms, blocking): warm it up front so presses land.
loadShikiLanguage("ts");

const message = signal<Message>({
  id: "m1",
  role: "assistant",
  body: "# Result\n\nUse **the cache**.\n\n```ts\nconst ready = true;\n```",
});
const previewed = signal("");
const forked = signal("");
const rewound = signal("");

function Fixture() {
  return (
    <View>
      <MessageRow message={message} onOpenAttachment={(attachment) => previewed.set(attachment.id)} onForkResponse={(id) => forked.set(id)} forkEnabled={() => true} forkBusy={() => false} onRewind={(id) => rewound.set(id)} rewindAvailable={() => true} rewindBusy={() => false} loadAttachment={() => Promise.reject(new Error("offline"))} />
      {previewed() ? <Text>{`Preview attachment ${previewed()}`}</Text> : null}
      {rewound() ? <Text>{`Rewind to ${rewound()}`}</Text> : null}
      {forked() ? <Text>{`Fork response ${forked()}`}</Text> : null}
      <View onPress={() => message.set({ id: "m3", role: "user", body: "Look at [@a.ts](t3-context://v1/mention/m_1) please", context: { version: 1, records: [{ contextId: "m_1", kind: "mention", label: "@a.ts", path: "/w/src/a.ts" }] } })} accessibilityLabel="Show context message">
        <Text>Context</Text>
      </View>
      <View onPress={() => message.set({ id: "m6", role: "user", body: "See [image.png](t3-context://v1/image/i_1)", context: { version: 1, records: [{ contextId: "i_1", kind: "image", label: "image.png", attachmentId: "img1" }] }, attachments: [{ id: "img1", name: "image.png", type: "image", mimeType: "image/png", sizeBytes: 2048 }] })} accessibilityLabel="Show image context">
        <Text>Image context</Text>
      </View>
      <View onPress={() => message.set({ id: "m7", role: "user", body: "Check [report.pdf](t3-context://v1/file/f_1)", context: { version: 1, records: [{ contextId: "f_1", kind: "file", label: "report.pdf", attachmentId: "file1" }] }, attachments: [{ id: "file1", name: "report.pdf", type: "file", mimeType: "application/pdf", sizeBytes: 2048 }] })} accessibilityLabel="Show file context">
        <Text>File context</Text>
      </View>
      <View onPress={() => message.set({ id: "m8", role: "user", body: "[report.pdf](t3-context://v1/file/f_1)", context: { version: 1, records: [{ contextId: "f_1", kind: "file", label: "report.pdf", attachmentId: "file1" }] }, attachments: [{ id: "file1", name: "report.pdf", type: "file", mimeType: "application/pdf", sizeBytes: 2048 }] })} accessibilityLabel="Show file only">
        <Text>File only</Text>
      </View>
      <View onPress={() => message.set({ id: "m4", role: "assistant", body: "Partial answer", status: "failed", updatedAt: 1700000000000 })} accessibilityLabel="Show failed message">
        <Text>Failed</Text>
      </View>
      <View onPress={() => message.set({ id: "m5", role: "assistant", body: "Done answer", status: "completed" })} accessibilityLabel="Show completed message">
        <Text>Completed</Text>
      </View>
      <View onPress={() => message.set({ id: "m2", role: "user", body: "Second prompt", attachments: [{ id: "f1", name: "report.pdf", type: "file", mimeType: "application/pdf", sizeBytes: 123 }] })} accessibilityLabel="Replace message">
        <Text>Replace</Text>
      </View>
      <AnchoredToastHost />
    </View>
  );
}

mount(Fixture);
