import { expect, test } from "nsh/test";
import { shimmerCenter, shimmerStrength } from "./Shimmer";

test("the band enters before the text, crosses it and leaves after", () => {
  expect(shimmerCenter(0, 200)).toBe(-36);
  expect(shimmerCenter(15, 200)).toBe(100);
  expect(shimmerCenter(29, 200)).toBeGreaterThan(200);
  expect(shimmerCenter(30, 200)).toBe(-36);
});

test("the highlight follows the band and fades away from its centre", () => {
  expect(shimmerStrength(4, 9, 15, 200)).toBe(1);
  expect(shimmerStrength(0, 9, 15, 200)).toBe(0);
  expect(shimmerStrength(4, 9, 0, 200)).toBe(0);
});
