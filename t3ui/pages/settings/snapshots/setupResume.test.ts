import { signal } from "nsh";
import { expect, test } from "nsh/test";
import { installSnapShotSetupResume, resetSnapShotSetupResumeStartupForTest, saveSnapShotSetupResume } from "./setupResume";

test("a saved setup resume opens /settings/snap-shot once the environment connects, once per startup", async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  saveSnapShotSetupResume(true);
  resetSnapShotSetupResumeStartupForTest();
  const connected = signal(false);
  const opened: string[] = [];
  installSnapShotSetupResume({ connected: () => connected(), currentPath: () => null, open: (path) => opened.push(path) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(opened).toEqual([]);
  connected.set(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(opened).toEqual(["/settings/snap-shot"]);
  connected.set(false);
  connected.set(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(opened).toEqual(["/settings/snap-shot"]);
});
