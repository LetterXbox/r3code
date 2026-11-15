import { expect, test } from "nsh/test";
import { pressOpenFavoriteTarget, registerOpenFavoriteTarget } from "./openFavorite";

test("editor.openFavorite presses the newest enabled Open-in button on screen; none, or a disabled one, falls through", () => {
  expect(pressOpenFavoriteTarget()).toBe(false);
  const pressed: string[] = [];
  let enabled = true;
  const stopFirst = registerOpenFavoriteTarget({ press: () => pressed.push("first"), enabled: () => true });
  const stopSecond = registerOpenFavoriteTarget({ press: () => pressed.push("second"), enabled: () => enabled });
  expect(pressOpenFavoriteTarget()).toBe(true);
  enabled = false;
  expect(pressOpenFavoriteTarget()).toBe(false);
  stopSecond();
  expect(pressOpenFavoriteTarget()).toBe(true);
  stopFirst();
  expect(pressOpenFavoriteTarget()).toBe(false);
  expect(pressed).toEqual(["second", "first"]);
});
