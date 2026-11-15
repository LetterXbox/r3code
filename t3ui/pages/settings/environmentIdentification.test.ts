// AppearanceSettingsPanel.tsx environmentIdentificationOptions and descriptions, SidebarStageBackdrop.tsx's resolvers and
// useEnvironmentIdentificationMode's built-in-theme rule.
import { expect, test } from "nsh/test";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE, environmentIdentificationOptions, resolveEffectiveMode, resolvePillLabel, resolveSidebarStageBackdropVariant, resolveStageLabel,
} from "./environmentIdentification";

test("the default mode is artwork and follows the stage: the port's Dev stage draws the blueprint", () => {
  expect(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE).toBe("artwork");
  expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
  expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
  expect(resolveSidebarStageBackdropVariant("Latest")).toBeNull();
  expect(resolveSidebarStageBackdropVariant("Latest", "nightly-artwork")).toBe("nightly");
  expect(resolveSidebarStageBackdropVariant("Dev", "pill")).toBeNull();
  expect(resolveSidebarStageBackdropVariant("Dev", "none")).toBeNull();
});

test("a nightly server version makes the stage Nightly", () => {
  expect(resolveStageLabel("1.2.3-nightly.20260101.4")).toBe("Nightly");
  expect(resolveStageLabel("1.2.3")).toBe("Dev");
  expect(resolveStageLabel(null, "Latest")).toBe("Latest");
  expect(resolvePillLabel("dev")).toBe("Dev");
  expect(resolvePillLabel("Latest")).toBeNull();
});

test("the options and the label of artwork follow the stage", () => {
  const labels = (stage: "dev" | "nightly" | null) => environmentIdentificationOptions(stage).map((option) => `${option.value}:${option.label}`);
  expect(labels("dev")).toEqual(["artwork:Dev artwork", "nightly-artwork:Nightly artwork", "pill:Version pill", "none:None"]);
  expect(labels("nightly")).toEqual(["artwork:Nightly artwork", "dev-artwork:Dev artwork", "pill:Version pill", "none:None"]);
  expect(labels(null)).toEqual(["artwork:None", "nightly-artwork:Nightly artwork", "dev-artwork:Dev artwork"]);
});

test("only built-in themes show artwork: a custom theme turns an artwork mode into the pill", () => {
  expect(resolveEffectiveMode("artwork", "ocean")).toBe("artwork");
  expect(resolveEffectiveMode("artwork", "default")).toBe("artwork");
  expect(resolveEffectiveMode("artwork", "ovx-theme-abc")).toBe("pill");
  expect(resolveEffectiveMode("dev-artwork", "my-theme")).toBe("pill");
  expect(resolveEffectiveMode("none", "my-theme")).toBe("none");
  expect(resolveEffectiveMode("pill", "ocean")).toBe("pill");
});
