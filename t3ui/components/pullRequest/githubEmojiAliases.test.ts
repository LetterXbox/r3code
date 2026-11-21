import { expect, test } from "nsh/test";
import { expandGithubEmojiAliases, expandGithubEmojiInMarkdown } from "./githubEmojiAliases";

test("renders GitHub emoji shortcodes in prose and leaves code spans and fences literal (#39315)", () => {
  expect(expandGithubEmojiAliases("Ship it :tada: :+1: :tada:tada:")).toBe("Ship it 🎉 👍 🎉tada:");
  expect(expandGithubEmojiInMarkdown("Ship it :tada: `keep :tada:`\n```\n:tada:\n```")).toBe("Ship it 🎉 `keep :tada:`\n```\n:tada:\n```");
});
