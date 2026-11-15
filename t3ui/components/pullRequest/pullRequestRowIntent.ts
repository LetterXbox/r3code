/** Keep the prefetch intent while either keyboard focus or pointer hover remains on the row. */
export function createPullRequestRowIntent<T>(entry: T, notify: (entry: T | null) => void) {
  let hovered = false;
  let focused = false;
  return {
    enter() { hovered = true; notify(entry); },
    leave() { hovered = false; if (!focused) notify(null); },
    focus() { focused = true; notify(entry); },
    blur() { focused = false; if (!hovered) notify(null); },
  };
}
