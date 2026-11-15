import { expect, test } from "nsh/test";
import type { Thread } from "../../store";
import { planSectionReorder } from "./reorderActions";

const make = (id: string, key: string | null): Thread => ({
  id, projectId: "p", title: id, status: "idle", pinned: true, updatedAt: 0,
  meta: { pinOrderKey: key, activeOrderKey: key } as Thread["meta"],
});

test("dropping a row where it already is writes nothing", async () => {
  const rows = [make("a", "c"), make("b", "g"), make("c", "p")];
  await expect(planSectionReorder(rows, "b", "pinned", 1)).toEqual([]);
});

test("dropping a row between two others writes one key between theirs", async () => {
  const rows = [make("a", "c"), make("b", "g"), make("c", "p")];
  const plan = planSectionReorder(rows, "c", "pinned", 0);
  await expect(plan.length).toBe(1);
  await expect(plan[0]!.id).toBe("c");
  await expect(plan[0]!.orderKey < "c").toBe(true);
});

test("the active section reads the active keys", async () => {
  const rows = [make("a", "c"), make("b", "g")];
  const plan = planSectionReorder(rows, "a", "active", 1);
  await expect(plan[0]!.orderKey > "g").toBe(true);
});

test("a row that is not listed is left alone", async () => {
  await expect(planSectionReorder([make("a", "c")], "zzz", "pinned", 0)).toEqual([]);
});

test("fm13: the reorder-unsupported copy is the reference's", async () => {
  const { REORDER_UNSUPPORTED } = await import("./reorderActions");
  expect(REORDER_UNSUPPORTED.pinned).toBe("This environment's server does not support reordering pinned threads yet. Update the server to reorder pins.");
  expect(REORDER_UNSUPPORTED.active).toBe("Update this environment's server to reorder active threads.");
});
