// useResizeDrag.ts: the window losing the focus mid-drag commits the size the drag shows.
import { open, test } from "nsh/test";

test("an inactive window ends a live drag at its current size", async () => {
  const app = await open("./LiveResizeBlurFixture.tsx");
  await app.press("label:Drag");
  await app.waitFor("text:committed=400 live=440");
  await app.setLifecycle("inactive");
  await app.waitFor("text:committed=440 live=none");
});
