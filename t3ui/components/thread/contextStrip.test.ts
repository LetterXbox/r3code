import { expect, test } from "nsh/test";
import { shouldShowComposerContextStrip } from "./contextStrip";

const base = { isDraftHeroState: false, persistInActiveThreads: false, hasActiveProject: true, isGitRepo: true, showEnvironmentIndicator: false };

test("shows on a draft", () => { expect(shouldShowComposerContextStrip({ ...base, isDraftHeroState: true })).toBe(true); });
test("hides on a started thread by default", () => { expect(shouldShowComposerContextStrip(base)).toBe(false); });
test("shows on a started thread when persisted in a git repo", () => { expect(shouldShowComposerContextStrip({ ...base, persistInActiveThreads: true })).toBe(true); });
test("needs a git repo or an environment indicator", () => {
  expect(shouldShowComposerContextStrip({ ...base, persistInActiveThreads: true, isGitRepo: false })).toBe(false);
  expect(shouldShowComposerContextStrip({ ...base, persistInActiveThreads: true, isGitRepo: false, showEnvironmentIndicator: true })).toBe(true);
  });
test("needs a project", () => { expect(shouldShowComposerContextStrip({ ...base, isDraftHeroState: true, hasActiveProject: false })).toBe(false); });
