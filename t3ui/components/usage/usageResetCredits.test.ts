import { expect, test } from "nsh/test";
import { redeemResetCredit, resetCreditsSummary, resetCreditStatus } from "./usageResetCredits";

const now = Date.UTC(2026, 10, 11, 12);
test("summary names the count and when the next credit expires", () => {
  expect(resetCreditsSummary({ availableCount: 2, nextExpiresAt: new Date(now + 3 * 3_600_000).toISOString() }, now)).toBe("2 reset credits banked · next expires in 3h 0m");
  expect(resetCreditsSummary({ availableCount: 1, nextExpiresAt: "" }, now)).toBe("1 reset credit banked");
  expect(resetCreditsSummary({ availableCount: 2, nextExpiresAt: new Date(now + 60_000).toISOString() }, now, true)).toBe("2 banked · expires in 1m");
  expect(resetCreditsSummary({ availableCount: 0, nextExpiresAt: "" }, now)).toBe("No reset credits banked");
});
test("a warning wins over the outcome copy", () => {
  expect(resetCreditStatus({ outcome: "reset" })).toBe("Reset applied. Your windows have cleared.");
  expect(resetCreditStatus({ outcome: "reset", warning: "Partly applied." })).toBe("Partly applied.");
  expect(resetCreditStatus({ outcome: "noCredit" })).toBe("No reset credit left.");
});
test("redeem sends the instance id and reports a failure", async () => {
  const calls: unknown[] = [];
  expect(await redeemResetCredit(async (method, payload) => { calls.push([method, payload]); return { outcome: "nothingToReset" }; }, "codex_work")).toBe("Nothing to reset right now.");
  expect(calls).toEqual([["provider.consumeResetCredit", { instanceId: "codex_work" }]]);
  expect(await redeemResetCredit(async () => { throw new Error("offline"); }, "x")).toBe("offline");
});

test("a hub's credit is redeemed by naming its source, account and credit", async () => {
  const calls: unknown[] = [];
  await redeemResetCredit(async (method, payload) => { calls.push([method, payload]); return { outcome: "reset" }; }, { sourceId: "hub1", accountId: "ada.json", creditId: "cr1" });
  expect(calls).toEqual([["provider.consumeResetCredit", { sourceId: "hub1", accountId: "ada.json", creditId: "cr1" }]]);
});
