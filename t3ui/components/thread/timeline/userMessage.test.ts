import { expect, test } from "nsh/test";
import { shouldCollapseUserMessage } from "./userMessage";

test("short messages stay open, long or tall ones fold", () => {
  expect(shouldCollapseUserMessage("hello")).toBe(false);
  expect(shouldCollapseUserMessage("")).toBe(false);
  expect(shouldCollapseUserMessage("a".repeat(601))).toBe(true);
  expect(shouldCollapseUserMessage(Array(9).fill("x").join("\n"))).toBe(true);
  expect(shouldCollapseUserMessage(Array(8).fill("x").join("\n"))).toBe(false);
});

test("the collapse rule measures what the message reads as: link labels, not their long targets", async () => {
  const { shouldCollapseUserMessage, visibleUserMessageText } = await import("./userMessage");
  const link = `[notes](https://example.com/${"x".repeat(700)})`;
  expect(visibleUserMessageText(`see ${link}`)).toBe("see notes");
  expect(shouldCollapseUserMessage(`see ${link}`)).toBe(false);
  expect(shouldCollapseUserMessage("y".repeat(601))).toBe(true);
});
