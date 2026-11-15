import { expect, test } from "nsh/test";
import { createPullRequestRowIntent } from "./pullRequestRowIntent";

test("pull request prefetch intent persists until both focus and hover leave", () => {
  const events: (number | null)[] = [];
  const intent = createPullRequestRowIntent(3, (value) => events.push(value));
  intent.focus();
  intent.enter();
  intent.leave();
  expect(events).toEqual([3, 3]);
  intent.blur();
  expect(events).toEqual([3, 3, null]);
  intent.enter();
  intent.focus();
  intent.blur();
  expect(events).toEqual([3, 3, null, 3, 3]);
  intent.leave();
  expect(events).toEqual([3, 3, null, 3, 3, null]);
});
