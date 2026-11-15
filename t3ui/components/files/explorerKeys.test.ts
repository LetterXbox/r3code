import { expect, test } from "nsh/test";
import { EXPLORER_MIN_WIDTH, explorerKeyWidth } from "./explorerState";

test("the explorer's resize edge moves by 16 with the arrows and to its bounds with Home and End (FileExplorerPane onKeyDown)", async () => {
  await expect(explorerKeyWidth("left", 256, 400)).toBe(272);
  await expect(explorerKeyWidth("right", 256, 400)).toBe(240);
  await expect(explorerKeyWidth("home", 256, 400)).toBe(EXPLORER_MIN_WIDTH);
  await expect(explorerKeyWidth("end", 256, 400)).toBe(400);
  await expect(explorerKeyWidth("left", 395, 400)).toBe(400);
  await expect(explorerKeyWidth("right", 170, 400)).toBe(EXPLORER_MIN_WIDTH);
});
