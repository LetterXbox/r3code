import { expect, test } from "nsh/test";
import { recordDetailsMeasurement, resolveThreadDetailsCardDensity } from "./threadDetailsDensity";

test("density drops to compact then essential as the measured content outgrows the card", () => {
  expect(resolveThreadDetailsCardDensity(400, { full: 0, compact: 0 })).toBe("full");
  expect(resolveThreadDetailsCardDensity(400, { full: 380, compact: 0 })).toBe("full");
  expect(resolveThreadDetailsCardDensity(400, { full: 520, compact: 0 })).toBe("compact");
  expect(resolveThreadDetailsCardDensity(400, { full: 520, compact: 300 })).toBe("compact");
  expect(resolveThreadDetailsCardDensity(400, { full: 520, compact: 450 })).toBe("essential");
});

test("measurements are kept per key and density; essential is never measured", () => {
  let current = { key: "", full: 0, compact: 0 };
  current = recordDetailsMeasurement(current, "t1", "full", 500);
  current = recordDetailsMeasurement(current, "t1", "compact", 420);
  expect(current).toEqual({ key: "t1", full: 500, compact: 420 });
  expect(recordDetailsMeasurement(current, "t1", "essential", 10)).toBe(current);
  expect(recordDetailsMeasurement(current, "t2", "full", 100)).toEqual({ key: "t2", full: 100, compact: 0 });
});
