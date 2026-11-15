import { expect, test } from "nsh/test";
import { groupModels } from "./modelGroups";

test("available models are grouped by provider without changing model identifiers", () => {
  expect(groupModels([
    { provider: "one", model: "m1", label: "Provider One: Model A" },
    { provider: "two", model: "m2", label: "Provider Two: Model B" },
    { provider: "one", model: "m3", label: "Provider One: Model C" },
  ])).toEqual([
    { provider: "one", label: "Provider One", models: [{ model: "m1", label: "Model A" }, { model: "m3", label: "Model C" }] },
    { provider: "two", label: "Provider Two", models: [{ model: "m2", label: "Model B" }] },
  ]);
});
