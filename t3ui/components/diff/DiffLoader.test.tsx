import { expect, open, test } from "nsh/test";

function readCounter(texts: readonly string[], prefix: string): number {
  const match = texts.find((text) => text.startsWith(prefix));
  return match === undefined ? Number.NaN : Number(match.slice(prefix.length));
}

async function counts(app: Awaited<ReturnType<typeof open>>) {
  const texts = app.texts();
  return { requests: readCounter(texts, "requests:"), maxInFlight: readCounter(texts, "maxInFlight:") };
}

test("a diff with 500 files requests only a small bounded batch, never the whole list", async () => {
  const app = await open("./DiffLoaderFixture.tsx", { width: 1000, height: 800 });
  await app.waitUntil(() => readCounter(app.texts(), "requests:") > 0);
  // Give the initial (concurrent) batch time to fully settle, then it must stop growing on its own.
  await app.wait(600);
  const settled = await counts(app);
  // Only the files the virtualised list actually reported visible (plus a small lookahead) were
  // requested: nowhere near the diff's 500 files, which is what "only visible files requested" means.
  expect(settled.requests).toBeGreaterThan(0);
  expect(settled.requests).toBeLessThan(100);
  // The hard concurrency cap was honored: never more than PATCH_CONCURRENCY requests in flight together.
  expect(settled.maxInFlight).toBeLessThanOrEqual(4);
});

test("a backlog built up by a single large scroll is dropped entirely on unmount", async () => {
  const app = await open("./DiffLoaderFixture.tsx", { width: 1000, height: 800 });
  await app.waitUntil(() => readCounter(app.texts(), "requests:") > 0);
  // One big jump reveals far more rows at once than PATCH_CONCURRENCY can dispatch immediately: most of
  // what it asks for sits queued, not yet sent, which is the backlog this test needs dropped on unmount.
  await app.scroll("label:Changed files diff", 8000);
  const atUnmount = (await counts(app)).requests;
  expect(atUnmount).toBeLessThan(500);
  await app.press("label:Unmount diff panel");
  await app.wait(600);
  const later = (await counts(app)).requests;
  expect(later).toBe(atUnmount);
});
