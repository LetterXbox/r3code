import { expect, test } from "nsh/test";
import { withImplicitFastModeDefault } from "../../store";

test("implicit fastMode=false only when the model offers fast mode and the user picked none", () => {
  const fast = [{ type: "boolean", id: "fastMode" }];
  expect(withImplicitFastModeDefault(fast, undefined)).toEqual([{ id: "fastMode", value: false }]);
  expect(withImplicitFastModeDefault(fast, [{ id: "fastMode", value: true }])).toEqual([{ id: "fastMode", value: true }]);
  expect(withImplicitFastModeDefault([{ type: "select", id: "effort" }], undefined)).toBeUndefined();
});
