import { expect, test } from "nsh/test";
import { collectPromptTokens, promptToDoc, docToPrompt } from "./editor/promptDocument";
import { attachExtraContext, attachedExtraContexts, contextDetailFor, extraContextMarker, sendExtrasFor, settleSendContext, terminalContextRecord, threadContextRecord, clearSendContext } from "./contextChips";
import { threadMentionItems } from "./commandItems";
import { promptWithReference } from "./terminalContext";

const context = { skills: new Map<string, string>() };

test("a thread record is one per thread, labelled by its title, and its marker chips as a thread token", () => {
  const record = threadContextRecord({ environmentId: "env-1", threadId: "thread-9" }, "Fix [the] login\nflow");
  expect(record).toMatchObject({ kind: "thread", contextId: "thread_thread-9", label: "Fix the login flow", environmentId: "env-1", threadId: "thread-9" });
  expect(threadContextRecord({ environmentId: "env-1", threadId: "thread-9" }, "Renamed").contextId).toBe(record.contextId);
  const marker = extraContextMarker(record);
  expect(marker).toBe("[Fix the login flow](t3-context://v1/thread/thread_thread-9)");
  const tokens = collectPromptTokens(`see ${marker} `, context);
  expect(tokens.map((token) => [token.kind, token.value])).toEqual([["thread", "Fix the login flow"]]);
  expect(docToPrompt(promptToDoc(`see ${marker} `, context))).toBe(`see ${marker} `);
});

test("a terminal selection becomes a terminal record with its lines, and its marker chips as a terminal token", () => {
  const record = terminalContextRecord({ terminalId: "terminal-1", terminalLabel: "Terminal 1", lineStart: 3, lineEnd: 9, text: "error: boom" });
  expect(record).toMatchObject({ kind: "terminal", label: "Terminal 1 lines 3-9", terminalId: "terminal-1", lineStart: 3, lineEnd: 9, text: "error: boom" });
  expect(terminalContextRecord({ terminalId: "terminal-1", terminalLabel: "Terminal 1", lineStart: 4, lineEnd: 4, text: "x" }).label).toBe("Terminal 1 line 4");
  expect(collectPromptTokens(`${extraContextMarker(record)} `, context)[0]?.kind).toBe("terminal");
});

test("attached references travel with the send until their token is deleted, and unplaced ones are appended", () => {
  const thread = "thread:send-test";
  const a = threadContextRecord({ environmentId: "env-1", threadId: "a" }, "Alpha");
  const b = terminalContextRecord({ terminalId: "t", terminalLabel: "Terminal 1", lineStart: 1, lineEnd: 2, text: "out" });
  attachExtraContext(thread, a);
  attachExtraContext(thread, a);
  attachExtraContext(thread, b);
  expect(attachedExtraContexts(thread).length).toBe(2);
  expect(sendExtrasFor(thread).context?.records.map((record) => record.kind)).toEqual(["thread", "terminal"]);
  // Only `a` was placed inline, and its token is still in the text; `b` was never placed, so its marker is appended.
  const text = `look at ${extraContextMarker(a)} `;
  expect(settleSendContext(thread, text, new Set([a.contextId]))).toBe(extraContextMarker(b));
  // The user deletes `a`'s token: the record goes.
  expect(settleSendContext(thread, "nothing", new Set([a.contextId]))).toBe(extraContextMarker(b));
  expect(attachedExtraContexts(thread).map((record) => record.kind)).toEqual(["terminal"]);
  expect(contextDetailFor(thread, "terminal", b.label)).toBe("Terminal Terminal 1, lines 1-2: out");
  clearSendContext(thread);
  expect(sendExtrasFor(thread)).toEqual({});
});

test("the @ menu offers recent matching threads, never the open one, at most five", () => {
  const threads = [
    { id: "t1", title: "Fix login", updatedAt: 10 }, { id: "t2", title: "Login page polish", updatedAt: 30 },
    { id: "open", title: "Login open", updatedAt: 99 }, { id: "t3", title: "Unrelated", updatedAt: 50 },
    ...[4, 5, 6, 7, 8].map((n) => ({ id: `t${n}`, title: `login ${n}`, updatedAt: n })),
  ];
  const items = threadMentionItems(threads, { environmentId: "env-1", excludeThreadId: "open", query: "login" });
  expect(items.length).toBe(5);
  expect(items.every((item) => item.type === "thread")).toBe(true);
  expect(items.map((item) => item.label)[0]).toBe("Login page polish");
  expect(items.some((item) => item.id.includes("open"))).toBe(false);
  expect(threadMentionItems(threads, { environmentId: "env-1", excludeThreadId: "open", query: "" })).toEqual([]);
  expect(threadMentionItems(threads, { environmentId: undefined, excludeThreadId: undefined, query: "login" })).toEqual([]);
});

test("a reference goes after the prompt's text with one space either side", () => {
  expect(promptWithReference("", "[m](x)")).toBe("[m](x) ");
  expect(promptWithReference("fix this", "[m](x)")).toBe("fix this [m](x) ");
  expect(promptWithReference("fix this ", "[m](x)")).toBe("fix this [m](x) ");
});

import { tokenDetailAt } from "./tokenDetail";

test("the token beside the caret describes itself in the status line", () => {
  const thread = "thread:detail-test";
  const record = terminalContextRecord({ terminalId: "t", terminalLabel: "Terminal 1", lineStart: 5, lineEnd: 5, text: "npm ERR! code 1" });
  attachExtraContext(thread, record);
  const text = `see ${extraContextMarker(record)} and @README.md `;
  const ctx = { skills: new Map<string, string>() };
  expect(tokenDetailAt(text, 6, thread, ctx)).toBe("Terminal Terminal 1, line 5: npm ERR! code 1");
  expect(tokenDetailAt(text, text.length - 1, thread, ctx)).toBe("README.md");
  expect(tokenDetailAt(text, 1, thread, ctx)).toBeNull();
});

import { restorePastedContexts } from "./contextChips";

test("a token copied from one thread's prompt brings its record into the thread it is pasted in", () => {
  const record = threadContextRecord({ environmentId: "env-1", threadId: "src" }, "Source thread");
  attachExtraContext("thread:one", record);
  restorePastedContexts("thread:two", `see ${extraContextMarker(record)} `);
  expect(attachedExtraContexts("thread:two").map((item) => item.contextId)).toEqual([record.contextId]);
  restorePastedContexts("thread:three", "[x](t3-context://v1/thread/unknown-id) ");
  expect(attachedExtraContexts("thread:three")).toEqual([]);
});

import { attachPullRequest, attachedPullRequests, pullRequestMarker, pullRequestContextRecord } from "./contextChips";

test("pasted markers bring back pull request and terminal records, and report how many came back (undo of a chip removal)", () => {
  const pr = { number: 7, title: "Fix it", url: "https://github.com/a/b/pull/7", headBranch: "h", baseBranch: "main", state: "open" as const, isDraft: false };
  attachPullRequest("thread:pr-src", pr);
  const marker = pullRequestMarker(pullRequestContextRecord(pr));
  expect(restorePastedContexts("thread:pr-dst", `look ${marker} `)).toBe(1);
  expect(attachedPullRequests("thread:pr-dst").map((item) => item.pullRequest.number)).toEqual([7]);
  // already attached: nothing to restore
  expect(restorePastedContexts("thread:pr-dst", `again ${marker} `)).toBe(0);
  const terminal = terminalContextRecord({ terminalId: "t9", terminalLabel: "Terminal 9", lineStart: 1, lineEnd: 2, text: "boom" });
  attachExtraContext("thread:t-src", terminal);
  expect(restorePastedContexts("thread:t-dst", extraContextMarker(terminal))).toBe(1);
  expect(restorePastedContexts("thread:t-dst", "plain text")).toBe(0);
});

import { markerAtCaret, placeContextReference, setContextInsertionHandler } from "./terminalContext";

test("a mounted editor takes a reference at its caret; with none mounted the draft takes it at the end", () => {
  expect(markerAtCaret("", "[m](x)")).toBe("[m](x) ");
  expect(markerAtCaret("fix", "[m](x)")).toBe(" [m](x) ");
  expect(markerAtCaret("fix ", "[m](x)")).toBe("[m](x) ");
  const seen: string[] = [];
  const off = setContextInsertionHandler((marker) => { seen.push(marker); return true; });
  placeContextReference("[a](t3-context://v1/thread/a)");
  expect(seen).toEqual(["[a](t3-context://v1/thread/a)"]);
  off();
  const second = setContextInsertionHandler(() => false);
  placeContextReference("[b](t3-context://v1/thread/b)");
  second();
});
