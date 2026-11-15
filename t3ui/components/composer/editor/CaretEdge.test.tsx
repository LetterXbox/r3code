import { expect, open, test } from "nsh/test";

test("prompt history keys follow the caret's visual edge on a multiline prompt", async () => {
  const app = await open("./CaretEdgeFixture.tsx", { width: 500, height: 300 });
  await app.press("label:Caret start");
  await app.waitFor("text:up:true down:false");
  await app.press("label:Caret middle");
  await app.waitFor("text:up:false down:false");
  await app.press("label:Caret end");
  await app.waitFor("text:up:false down:true");
});

