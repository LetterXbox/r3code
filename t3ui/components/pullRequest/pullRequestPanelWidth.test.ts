import { expect, test } from "nsh/test";
import { createPullRequestPanelWidth, PULL_REQUEST_PANEL_WIDTH_KEY } from "./pullRequestPanelWidth";

test("a saved PR panel width is restored, and a drag is saved for the next page", async () => {
  const values = new Map([[PULL_REQUEST_PANEL_WIDTH_KEY, "620"]]);
  const storage = { getItem: async (key: string) => values.get(key) ?? null, setItem: async (key: string, value: string) => { values.set(key, value); } };
  const first = createPullRequestPanelWidth(storage);
  await Promise.resolve();
  expect(first.saved()).toBe(620);
  first.commit(710);
  const reopened = createPullRequestPanelWidth(storage);
  await Promise.resolve();
  expect(reopened.saved()).toBe(710);
});

test("a late restore cannot overwrite a width chosen during loading", async () => {
  let release: (value: string | null) => void = () => {};
  const read = new Promise<string | null>((resolve) => { release = resolve; });
  const width = createPullRequestPanelWidth({ getItem: () => read, setItem: async () => {} });
  width.commit(700);
  release("450");
  await read;
  await Promise.resolve();
  expect(width.saved()).toBe(700);
});
