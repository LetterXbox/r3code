import { expect, test } from "nsh/test";
import { completionOptionsInput, debouncedPullRequestCompletionSearch, detectPullRequestComposerTrigger, insertPullRequestCompletion, parseCompletionOptions, pullRequestCompletionKey, pullRequestCompletions } from "./pullRequestCompletion.logic";

const github = { mentions: true, referenceSigils: ["#"] };

test("a sigil token at the caret opens a trigger only when the host completes it", () => {
  expect(detectPullRequestComposerTrigger("thanks @oct", 11, github)).toMatchObject({ kind: "mention", sigil: "@", query: "oct", rangeStart: 7, rangeEnd: 11 });
  expect(detectPullRequestComposerTrigger("see #12", 7, github)).toMatchObject({ kind: "reference", sigil: "#", query: "12" });
  expect(detectPullRequestComposerTrigger("see !12", 7, github)).toBeNull();
  expect(detectPullRequestComposerTrigger("see !12", 7, { referenceSigils: ["!"] })).toMatchObject({ kind: "reference", sigil: "!" });
  expect(detectPullRequestComposerTrigger("hi @oct", 7, { mentions: false })).toBeNull();
  expect(detectPullRequestComposerTrigger("mail a@b", 8, github)).toBeNull();
  // The caret must sit at the token's end.
  expect(detectPullRequestComposerTrigger("hi @octo there", 6, github)).toBeNull();
});

test("a completion replaces the token and moves the caret past one space", () => {
  const trigger = detectPullRequestComposerTrigger("thanks @oc", 10, github)!;
  expect(insertPullRequestCompletion("thanks @oc", trigger, "@octocat")).toEqual({ text: "thanks @octocat ", cursor: 16 });
  const mid = detectPullRequestComposerTrigger("hi @oc there", 6, github)!;
  expect(insertPullRequestCompletion("hi @oc there", mid, "@octocat")).toEqual({ text: "hi @octocat there", cursor: 12 });
});

test("the host is asked for the unsearched list until the debounced key settles for the sigil", () => {
  const trigger = detectPullRequestComposerTrigger("fix #4", 6, github)!;
  expect(pullRequestCompletionKey(trigger)).toBe("#4");
  expect(debouncedPullRequestCompletionSearch(trigger, null)).toBeUndefined();
  expect(debouncedPullRequestCompletionSearch(trigger, "@x")).toBeUndefined();
  expect(debouncedPullRequestCompletionSearch(trigger, "#4")).toBe("4");
  expect(completionOptionsInput(trigger, "p1", "4")).toEqual({ kind: "references", projectId: "p1", sigil: "#", query: "4" });
  expect(completionOptionsInput(detectPullRequestComposerTrigger("@m", 2, github)!, "p1", undefined, "github.com")).toEqual({ kind: "authors", projectId: "p1", host: "github.com" });
});

test("filter options from the server are narrowed to what is typed, mentions by login or name and references by number or title", () => {
  const options = parseCompletionOptions({
    labels: [], truncated: false,
    authors: [{ login: "octocat", name: "The Octocat", avatarUrl: null }, { login: "mona", name: "Mona Lisa", avatarUrl: null }],
    references: [{ reference: "#41", kind: "issue", number: 41, title: "Crash on start", state: "open" }, { reference: "#42", kind: "change-request", number: 42, title: "Fix the crash", state: "merged" }],
  });
  expect(pullRequestCompletions(detectPullRequestComposerTrigger("@lisa", 5, github), options, 8).map((entry) => entry.token)).toEqual(["@mona"]);
  expect(pullRequestCompletions(detectPullRequestComposerTrigger("#4", 2, github), options, 8).map((entry) => entry.token)).toEqual(["#41", "#42"]);
  expect(pullRequestCompletions(detectPullRequestComposerTrigger("#crash", 6, github), options, 1).map((entry) => entry.token)).toEqual(["#41"]);
  expect(pullRequestCompletions(null, options, 8)).toEqual([]);
});

test("a video on a line of its own plays inline; one in a code fence stays text", async () => {
  const { splitPullRequestBody } = await import("./PullRequestMarkdown");
  expect(splitPullRequestBody("Before\nhttps://x.test/demo.mp4\nAfter")).toEqual([
    { kind: "markdown", text: "Before" }, { kind: "video", url: "https://x.test/demo.mp4" }, { kind: "markdown", text: "After" },
  ]);
  expect(splitPullRequestBody('<video src="https://x.test/a.webm">\n</video>')).toEqual([{ kind: "video", url: "https://x.test/a.webm" }]);
  expect(splitPullRequestBody("```\nhttps://x.test/demo.mp4\n```")).toEqual([{ kind: "markdown", text: "```\nhttps://x.test/demo.mp4\n```" }]);
});
