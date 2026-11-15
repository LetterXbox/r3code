// The page the terminal loads is generated (tools/build-terminal.mjs from third_party/t3-ghostty/entry.ts): a stale build would
// silently lack the menu, link and key handling, so the document is checked for the messages the app understands.
import { expect, open, test } from "nsh/test";

test("the bundled terminal page carries the menu, link, key and theme handling of entry.ts", async () => {
  const app = await open("./TerminalDocumentFixture.tsx", { width: 400, height: 200 });
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("page:")), { timeout: 8000 });
  expect(app.texts()).toContain("page:complete");
});
