import { expect, test } from "nsh/test";
import { serializeAssistantCitation } from "./assistantCitations";
import { userMessageCopyText } from "./messageCopy";

test("context links copy as their labels and citations as their quote and comment", () => {
  const quote = serializeAssistantCitation({ version: 1, environmentId: "e", threadId: "t", messageId: "m", text: "quoted", start: 0, end: 6, prefix: "", suffix: "", comment: "why" });
  expect(userMessageCopyText(`See [a.ts](t3-context://v1/mention/abc) and ${quote} [x](https://e.com)`)).toBe("See a.ts and quoted\nComment: why [x](https://e.com)");
  expect(userMessageCopyText("[](t3-context://v1/file/f1)", { f1: "report.pdf" })).toBe("report.pdf");
});
