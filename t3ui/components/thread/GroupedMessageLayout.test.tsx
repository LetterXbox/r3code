import { expect, open, test } from "nsh/test";

function height(texts: string[], prefix: string): number {
  return Number(texts.find((text) => text.startsWith(prefix))?.slice(prefix.length));
}

test("grouped messages do not reserve an invisible actions row in a wide lane", async () => {
  const app = await open("./GroupedMessageLayoutFixture.tsx", { width: 800, height: 600 });
  await app.waitUntil(() => height(app.texts(), "grouped ") > 0 && height(app.texts(), "single ") > 0);
  expect(height(app.texts(), "single ") - height(app.texts(), "grouped ") >= 30).toBe(true);
});

test("narrow lanes keep grouped message actions below the bubble", async () => {
  const app = await open("./GroupedMessageLayoutFixture.tsx", { width: 480, height: 600 });
  await app.waitUntil(() => height(app.texts(), "grouped ") > 0 && height(app.texts(), "single ") > 0);
  expect(height(app.texts(), "single ") - height(app.texts(), "grouped ")).toBe(12);
});
