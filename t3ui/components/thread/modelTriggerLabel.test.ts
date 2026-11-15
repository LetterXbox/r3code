import { expect, test } from "nsh/test";
import { triggerModelName } from "./ModelPicker";

test("the model trigger reads Choose model when nothing is selected (ProviderModelPicker)", () => {
  expect(triggerModelName(null)).toBe("Choose model");
});
