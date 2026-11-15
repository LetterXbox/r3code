// No prompt editor is taken out while it reports focus (a focused RichEditor removed from the tree leaves its key table
// behind: workspace/nsh-runtime-bugs.md, defect 1), and the main composer's editor mounts once across the paths.
import { expect, open, test } from "nsh/test";

test("draft send, thread switch, maximise and the panel toggle never remove a focused editor", async () => {
  const app = await open("./EditorLifecycleFixture.tsx");
  const shows = (part: string) => app.waitUntil(() => app.texts().some((text) => text.includes(part)));
  await shows("mounts=2 unmounts=0 focusedUnmounts=0");
  await app.press("label:Focus main");
  await shows("focused=1");
  // The first send: the draft becomes a server thread while the composer holds the keyboard.
  await app.press("label:Send first");
  await app.waitFor("text:timeline:thread:1");
  await expect(app.texts()).toContain("main:thread:1");
  // A thread switch.
  await app.press("label:Switch thread");
  await app.waitFor("text:main:thread:2");
  // The chat maximised away and back: hidden, never unmounted.
  await app.press("label:Toggle maximise");
  await app.press("label:Toggle maximise");
  await shows("mounts=2 unmounts=0 focusedUnmounts=0");
  // The side chat's composer focused, then the panel closed by its toggle.
  await app.press("label:Focus side");
  await app.press("label:Toggle panel");
  await app.waitFor("text:panel closed");
  await shows("mounts=2 unmounts=1 focusedUnmounts=0");
});
