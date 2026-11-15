import { expect, test } from "nsh/test";
import { createServerThreadFind } from "./threadFindServer";

const answer = (complete: boolean, total: number) => ({ complete, snapshotSequence: 1, totalMatches: total, activeIndex: 0, match: null });

// useThreadFind.ts: with ServerConfig.threadFindProgressive the web streams `orchestration.searchThreadStream` until an answer is complete.
test("a progressive server is searched over searchThreadStream; partial answers show, the complete one ends the stream", async () => {
  const methods: string[] = [];
  let push: (value: unknown) => void = () => {};
  let stopped = 0;
  const find = createServerThreadFind({
    request: async (method) => { methods.push(method); return answer(true, 0); },
    subscribe: (method, _payload, onValue) => { methods.push(method); push = onValue; return () => { stopped += 1; }; },
    progressive: () => true,
    debounceMs: 1,
  });
  find.search("t1", "needle");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(methods).toEqual(["orchestration.searchThreadStream"]);
  push(answer(false, 2));
  expect(find.result()?.totalMatches).toBe(2);
  expect(find.status()).toBe("loading");
  push(answer(true, 5));
  expect(find.result()?.totalMatches).toBe(5);
  expect(find.status()).toBe(null);
  expect(stopped).toBe(1);
});

test("without the capability the one-shot searchThread is used", async () => {
  const methods: string[] = [];
  const find = createServerThreadFind({ request: async (method) => { methods.push(method); return answer(true, 1); }, subscribe: () => () => {}, progressive: () => false, debounceMs: 1 });
  find.search("t1", "needle");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(methods).toEqual(["orchestration.searchThread"]);
});
