import { expect, test } from "nsh/test";
import { resolveRestingComposerControlsLayout, shouldUseCompactComposerFooter, shouldUseCompactComposerPrimaryActions } from "./composerFooterLayout";

test("the footer goes compact under 620, or 780 with the pending-answer actions", () => {
  expect(shouldUseCompactComposerFooter(619)).toBe(true);
  expect(shouldUseCompactComposerFooter(620)).toBe(false);
  expect(shouldUseCompactComposerFooter(700, { hasWideActions: true })).toBe(true);
  expect(shouldUseCompactComposerFooter(null)).toBe(false);
  expect(shouldUseCompactComposerPrimaryActions(700)).toBe(false);
  expect(shouldUseCompactComposerPrimaryActions(779, { hasWideActions: true })).toBe(true);
  expect(shouldUseCompactComposerPrimaryActions(780, { hasWideActions: true })).toBe(false);
});

test("resting controls drop to icon-only, then into the overflow (reference hysteresis cases)", () => {
  const measurement = { gap: 4, naturalFixedWidth: 140, minimumFixedWidth: 80, blockWidths: [80, 140], iconOnlyBlockWidths: [40, 60], overflowWidth: 24 };
  expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 400 })).toEqual({ hiddenCount: 0, iconOnlyCount: 0, visible: true });
  expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 300 }).iconOnlyCount).toBeGreaterThan(0);
  expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 200 }).hiddenCount).toBeGreaterThan(0);
  for (const hostWidth of [368, 288, 248]) {
    let previous = resolveRestingComposerControlsLayout({ ...measurement, hostWidth });
    for (let index = 0; index < 10; index += 1) {
      const next = resolveRestingComposerControlsLayout({ ...measurement, hostWidth, previous, naturalFixedWidth: 140 + (index % 2) * 0.5 });
      if (index > 1) expect(next).toEqual(previous);
      previous = next;
    }
  }
});

test("a sub-pixel jitter of the picker width settles", () => {
  const base = { gap: 4, naturalFixedWidth: 149, minimumFixedWidth: 105, blockWidths: [60, 140], overflowWidth: 24 };
  let layout = { hiddenCount: 0, visible: true };
  const settled: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    layout = resolveRestingComposerControlsLayout({ ...base, naturalFixedWidth: index % 2 === 0 ? 149 : 149.5, hostWidth: 357, previous: layout });
    if (index >= 2) settled.push(`${layout.hiddenCount}:${layout.visible}`);
  }
  expect(new Set(settled).size).toBe(1);
});
