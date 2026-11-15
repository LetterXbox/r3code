import { expect, test } from "nsh/test";
import { markdownProseDirection, textDirection } from "./textDirection";

test("textDirection follows the words' majority per sentence (textDirection.ts)", () => {
  expect(textDirection("Fix the build")).toBe("ltr");
  expect(textDirection("123 !!")).toBe(undefined);
  expect(textDirection("שלום עולם")).toBe("rtl");
  expect(textDirection("React مكتبة رائعة جدا")).toBe("rtl");
  expect(markdownProseDirection("```js\nconst a = 1\n``` مرحبا بالعالم")).toBe("rtl");
});
