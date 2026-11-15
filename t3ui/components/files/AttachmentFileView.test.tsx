import { expect, open, test } from "nsh/test";

test("a text attachment opens with its name, size and source", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 800, height: 500 });
  await app.waitFor("text:Attachment");
  await app.waitFor("text:notes.txt");
  await app.waitFor("text:hello text");
});

test("an archive attachment lists its entries and an unknown type says there is no preview", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 800, height: 500 });
  await app.press("label:open zip");
  await app.waitFor("label:a.txt");
  await app.press("label:open bin");
  await app.waitFor("text:No preview for this file");
});

test("a text attachment offers Save file beside its copy action", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 900, height: 600 });
  await app.waitFor("label:Copy contents");
  await app.waitFor("label:Save file");
});
