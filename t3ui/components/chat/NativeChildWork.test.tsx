import { expect, open, test } from "nsh/test";
import { readNativeChildWork, stepHeading } from "./nativeChildWork";

test("step headings read like the reference's stepLabel", () => {
  expect(stepHeading({ index: 0, type: "TOOL_CALL", status: "RUNNING", text: null, toolCalls: [] })).toBe("Tool call · Running");
  expect(stepHeading({ index: 0, type: "MESSAGE", status: "DONE", text: null, toolCalls: [] })).toBe("Message");
  expect(readNativeChildWork({ children: [] })).toEqual([]);
  expect(readNativeChildWork(null)).toBe(null);
});

test("Subagent work opens a read-only dialog that reads orchestration.getNativeChildWork", async () => {
  const app = await open("./NativeChildWorkFixture.tsx", { width: 900, height: 700 });
  await app.press("label:Subagent work");
  await app.waitFor("label:Researcher");
  const texts = app.texts();
  await expect(texts).toContain("Read only. These subagents cannot take messages.");
  await expect(texts).toContain("Earlier steps are not shown.");
  await expect(texts).toContain("Tool call · Running");
  await expect(texts).toContain("grep foo");
  await expect(texts).toContain("Found it");
});
