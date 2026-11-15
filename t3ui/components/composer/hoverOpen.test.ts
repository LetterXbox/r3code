import { expect, test } from "nsh/test";
import { hoverOpen } from "./Popover";

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

test("openOnHover: opens after the delay, a move into the popup keeps it open, leaving both closes after closeDelay", async () => {
  const states: boolean[] = [];
  const { hover } = hoverOpen((open) => states.push(open), { delay: 30, closeDelay: 30 });
  hover.onMouseEnter();
  await wait(10);
  expect(states).toEqual([]);
  await wait(40);
  expect(states).toEqual([true]);
  hover.onMouseLeave(); // leaves the trigger...
  hover.onMouseEnter(); // ...into the popup
  await wait(50);
  expect(states).toEqual([true, true]);
  hover.onMouseLeave();
  await wait(50);
  expect(states).toEqual([true, true, false]);
});

test("openOnHover defaults: 300 ms open delay, immediate close; a pass-through hover never opens", async () => {
  const states: boolean[] = [];
  const { hover } = hoverOpen((open) => states.push(open));
  hover.onMouseEnter();
  await wait(20);
  hover.onMouseLeave();
  expect(states).toEqual([false]);
  await wait(320);
  expect(states).toEqual([false]);
});
