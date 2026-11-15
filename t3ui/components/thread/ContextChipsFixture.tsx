import { mount, signal, View } from "nsh";
import type { Message } from "../../store";
import { MessageRow } from "./MessageRow";

const message = signal<Message>({
  id: "u1", role: "user",
  body: "see [@term-1:3-4](t3-context://v1/terminal/terminal_t1) and [#9](t3-context://v1/review-comment/gone)",
  context: { version: 1, records: [{ version: 1, contextId: "terminal_t1", kind: "terminal", label: "@term-1:3-4", terminalId: "t1", terminalLabel: "Terminal 1", lineStart: 3, lineEnd: 4, text: "npm test\nok" }] },
});
mount(() => <View class="w-[800px]"><MessageRow message={message} /></View>);
