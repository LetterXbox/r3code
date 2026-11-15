import { expect, open, test } from "nsh/test";

test("grammar builds never run while input arrives and tokenizing is sliced: no JS turn over 50 ms while active; grammars build once idle", async () => {
  const app = await open("./ShikiIdleFixture.tsx", { width: 800, height: 900 });
  await app.waitUntil(() => app.texts().some((text) => text.includes("warm active max")), { timeout: 25000 });
  const line = app.texts().find((text) => text.startsWith("active max"))!;
  console.log(line);
  const [, active, builtActive, , built, warm] = line.match(/active max (-?\d+)ms, built while active (\d+); idle max (-?\d+)ms, built (\d+)\/\d+; warm active max (-?\d+)ms/)!;
  expect(Number(active)).toBeLessThan(50);
  expect(Number(builtActive)).toBe(0);
  expect(Number(built)).toBe(6);
  // With grammars built, blocks scrolling in tokenize a slice per turn: still no turn over 50 ms.
  expect(Number(warm)).toBeLessThan(50);
});
