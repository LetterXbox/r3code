import { expect, test } from "nsh/test";
import { createFocusRegion, createFocusTrigger, handFocusBack } from "./focusHandBack";

test("a collapse with the focus inside hands it to the trigger once; without it nothing moves (moveFocusOutOfCollapsingSidebar)", async () => {
  const region = createFocusRegion();
  const trigger = createFocusTrigger();
  let focused = 0;
  trigger.ref({ focus: () => { focused += 1; }, blur: () => {}, measure: async () => null });
  const now = (run: () => void) => run();
  const listen = region.listen as { onFocusWithinChange: (event: { focused: boolean }) => void };
  await expect(handFocusBack(region, trigger, now)).toBe(false);
  await expect(focused).toBe(0);
  listen.onFocusWithinChange({ focused: true });
  await expect(handFocusBack(region, trigger, now)).toBe(true);
  await expect(focused).toBe(1);
  // The region forgot it: a second collapse with nothing focused inside does not steal the focus.
  await expect(handFocusBack(region, trigger, now)).toBe(false);
  listen.onFocusWithinChange({ focused: true });
  listen.onFocusWithinChange({ focused: false });
  await expect(handFocusBack(region, trigger, now)).toBe(false);
  await expect(focused).toBe(1);
});
