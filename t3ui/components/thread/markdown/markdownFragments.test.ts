import { expect, test } from "nsh/test";
import { decodeFragmentId, findFragmentTarget, githubHeadingSlug, headingIds, normalizeFragmentId, openMarkdownFragment, registerFragmentScroller, registerHeading } from "./markdownFragments";
import type { ViewRef } from "nsh";

test("headings get GitHub slugs with the user-content- prefix and -1 / -2 for repeats", () => {
  expect(githubHeadingSlug("  Hello, World! ")).toBe("hello-world");
  expect(githubHeadingSlug("Über café_2 (draft)")).toBe("über-café_2-draft");
  expect(headingIds(["Setup", "Setup", "Usage", "Setup", "!!!"])).toEqual(["user-content-setup", "user-content-setup-1", "user-content-usage", "user-content-setup-2", null]);
  // An id already taken in the document is skipped.
  expect(headingIds(["Setup"], ["user-content-setup"])).toEqual(["user-content-setup-1"]);
});

test("a fragment matches with or without the prefix, percent-decoded", () => {
  expect(decodeFragmentId("#caf%C3%A9")).toBe("café");
  expect(decodeFragmentId("#%E0%A4%A")).toBe("%E0%A4%A");
  expect(normalizeFragmentId("user-content-user-content-x")).toBe("x");
  expect(findFragmentTarget("#usage", ["user-content-setup", "user-content-usage"])).toBe("user-content-usage");
  expect(findFragmentTarget("#user-content-setup-1", ["user-content-setup", "user-content-setup-1"])).toBe("user-content-setup-1");
  expect(findFragmentTarget("#missing", ["user-content-setup"])).toBeNull();
});

test("a #heading link scrolls to the message's own heading first, then any heading on screen", () => {
  const scrolled: string[] = [];
  const view = (name: string) => ({ name } as unknown as ViewRef);
  const local = view("local");
  const other = view("other");
  const stop = registerFragmentScroller((target) => scrolled.push((target as unknown as { name: string }).name));
  const off = registerHeading(other, "user-content-usage");
  expect(openMarkdownFragment("#usage", new Map([["user-content-usage", local]]))).toBe(true);
  expect(openMarkdownFragment("#usage")).toBe(true);
  expect(openMarkdownFragment("#nope")).toBe(false);
  expect(scrolled).toEqual(["local", "other"]);
  off();
  stop();
});
