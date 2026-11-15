// The number field's keys (Base UI NumberField.Input): ArrowUp/Down step, Shift steps by 10, Home/End reach the bounds.
import { expect, open, test } from "nsh/test";
import { stepperKeys, stepperKeyValue } from "./stepperKeys";

test("stepperKeyValue: step, large step, clamp, and Home/End only with a bound", () => {
  expect(stepperKeyValue("up", 5)).toBe(6);
  expect(stepperKeyValue("down", 5, { step: 2 })).toBe(3);
  expect(stepperKeyValue("shift+up", 5)).toBe(15);
  expect(stepperKeyValue("shift+down", 5, { min: 1 })).toBe(1);
  expect(stepperKeyValue("up", 30, { max: 30 })).toBe(30);
  expect(stepperKeyValue("home", 5)).toBeNull();
  expect(stepperKeyValue("home", 5, { min: 1 })).toBe(1);
  expect(stepperKeyValue("end", 5, { max: 9 })).toBe(9);
  expect(stepperKeys({})).toEqual(["up", "down", "shift+up", "shift+down"]);
  expect(stepperKeys({ min: 0, max: 3 })).toEqual(["up", "down", "shift+up", "shift+down", "home", "end"]);
});

test("the arrows step the focused field and do nothing once it lost the focus", async () => {
  const app = await open("./StepperKeysFixture.tsx");
  await app.type("label:Amount", "");
  await app.keyboard.press("up");
  await app.waitFor("text:value=6");
  await app.keyboard.press("shift+up");
  await app.waitFor("text:value=16");
  await app.keyboard.press("down");
  await app.waitFor("text:value=15");
  await app.keyboard.press("end");
  await app.waitFor("text:value=30");
  await app.keyboard.press("home");
  await app.waitFor("text:value=1");
  await app.type("label:Other", "");
  await app.keyboard.press("up");
  await app.wait(150);
  await app.waitFor("text:value=1");
});
