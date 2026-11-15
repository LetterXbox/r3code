import { expect, test } from "nsh/test";
import { openInEditor, runGitAction, runPull, watchVcsStatus, type GitProgress, type Subscribe } from "./gitRuntime";

function fakeSubscribe() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let emit: (value: unknown) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let stopped = 0;
  const subscribe: Subscribe = (method, payload, onValue, onError) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    emit = onValue; fail = onError;
    return () => { stopped++; };
  };
  return { subscribe, calls, emit: (value: unknown) => emit(value), fail: (error: Error) => fail(error), stopped: () => stopped };
}

test("status subscription merges local and remote events", () => {
  const fake = fakeSubscribe();
  const seen: (string | null)[] = [];
  const stop = watchVcsStatus("/repo", fake.subscribe, (status) => seen.push(status ? `${status.refName}:${status.aheadCount}` : null), () => {});
  expect(fake.calls[0]).toEqual({ method: "subscribeVcsStatus", payload: { cwd: "/repo", includeRemote: true } });
  fake.emit({ _tag: "snapshot", local: { isRepo: true, refName: "main", workingTree: {} }, remote: null });
  fake.emit({ _tag: "remoteUpdated", remote: { aheadCount: 3, hasUpstream: true } });
  expect(seen).toEqual([null, "main:0", "main:3"]);
  stop();
  expect(fake.stopped()).toBe(1);
});

test("a stacked action reports progress and finishes with the server's toast", () => {
  const fake = fakeSubscribe();
  const progress: GitProgress[] = [];
  const done: string[] = [];
  const failed: string[] = [];
  runGitAction({ cwd: "/repo", action: "commit_push_pr", threadId: "t1" }, fake.subscribe,
    { onProgress: (value) => progress.push(value), onDone: (result) => done.push(`${result.title}|${result.url}`), onFailed: (message) => failed.push(message) }, () => 1000);
  const payload = fake.calls[0].payload;
  expect(fake.calls[0].method).toBe("git.runStackedAction");
  expect(payload.action).toBe("commit_push_pr");
  expect(payload.threadId).toBe("t1");
  const actionId = payload.actionId;
  fake.emit({ actionId: "other", kind: "phase_started", label: "ignored" });
  fake.emit({ actionId, kind: "phase_started", label: "Committing..." });
  fake.emit({ actionId, kind: "hook_output", text: "lint\nall good" });
  expect(progress.map((item) => [item.status, item.output])).toEqual([["Starting source control action...", null], ["Committing...", null], ["Committing...", "all good"]]);
  fake.emit({ actionId, kind: "action_finished", result: { toast: { title: "Created PR #4", cta: { kind: "open_pr", label: "View PR", url: "https://x/4" } } } });
  fake.fail(new Error("Environment subscription ended unexpectedly"));
  expect(done).toEqual(["Created PR #4|https://x/4"]);
  expect(failed).toEqual([]);
});

test("a failed action and a dropped stream both report once", () => {
  const first = fakeSubscribe();
  const failed: string[] = [];
  const hooks = { onProgress: () => {}, onDone: () => {}, onFailed: (message: string) => failed.push(message) };
  runGitAction({ cwd: "/r", action: "push" }, first.subscribe, hooks);
  first.emit({ actionId: first.calls[0].payload.actionId, kind: "action_failed", phase: "push", message: "rejected" });
  first.fail(new Error("later"));
  const second = fakeSubscribe();
  runGitAction({ cwd: "/r", action: "push" }, second.subscribe, hooks);
  second.fail(new Error("Connect an environment first"));
  expect(failed).toEqual(["rejected", "Connect an environment first"]);
});

test("pull and open-in use the contract's request shapes", async () => {
  const requests: [string, unknown][] = [];
  const request = async (method: string, payload: unknown) => {
    requests.push([method, payload]);
    return method === "vcs.pull" ? { status: "pulled", refName: "main", upstreamRef: "origin/main" } : undefined;
  };
  const pulled = await runPull("/repo", request);
  expect(pulled).toEqual({ title: "Pulled", description: "Updated main from origin/main", url: null });
  await openInEditor("/repo", "vscode", request);
  expect(requests).toEqual([["vcs.pull", { cwd: "/repo" }], ["shell.openInEditor", { cwd: "/repo", editor: "vscode" }]]);
});
