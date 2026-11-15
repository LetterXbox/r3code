import { expect, open, test } from "nsh/test";
import { parseFontListing } from "../../desktop/fonts";
import { fontPickerItems } from "./FontFamilyPicker";

test("the listing keeps visible families sorted and marks fixed-pitch ones", () => {
  const listing = parseFontListing('[["Menlo",true],["Arial",false],[".SF NS",false],["Menlo",true]]');
  expect(listing?.families).toEqual(["Arial", "Menlo"]);
  expect([...(listing?.monospace ?? [])]).toEqual(["Menlo"]);
  expect(parseFontListing("oops")).toBe(null);
  expect(fontPickerItems(["Arial", "Menlo"], "")).toEqual(["__default__", "Arial", "Menlo"]);
  expect(fontPickerItems(["Arial", "Menlo"], "men")).toEqual(["Menlo"]);
});

test("the picker searches, refuses a proportional font for code, and picks a monospace one", async () => {
  const app = await open("./FontFamilyPickerFixture.tsx", { width: 700, height: 700 });
  await app.press("label:Code font family");
  for (const text of ["System monospace", "default", "Fira Code", "Helvetica", "Menlo"]) await expect(app.texts()).toContain(text);
  await app.type("label:Search fonts", "zzz");
  await app.waitUntil(() => app.texts().includes("No fonts found."));
  await app.clear("label:Search fonts");
  await app.press("label:Helvetica");
  await app.waitUntil(() => app.texts().includes("\"Helvetica\" isn't monospace"));
  await expect(app.texts()).toContain("code=");
  await app.press("label:Code font family");
  await app.press("label:Menlo");
  await app.waitUntil(() => app.texts().includes("code=Menlo"));
});

test("typed family lists are checked against the installed listing (isFontFamilyAvailable / isMonospaceFamily)", async () => {
  const fonts = await import("../../desktop/fonts");
  fonts.setFontEnumerationForTest({ status: "unknown" });
  expect(fonts.isFontFamilyAvailable("Nope Sans")).toBe(true);
  expect(fonts.isFontFamilyAvailable(" , ")).toBe(false);
  fonts.setFontEnumerationForTest({ status: "granted", families: ["Menlo", "Helvetica"], monospace: new Set(["Menlo"]) });
  expect(fonts.isFontFamilyAvailable("Nope Sans")).toBe(false);
  expect(fonts.isFontFamilyAvailable("'menlo'")).toBe(true);
  expect(fonts.isFontFamilyAvailable("Nope, serif")).toBe(true);
  expect(fonts.isMonospaceFamilyList("Nope, Helvetica, Menlo")).toBe(false);
  expect(fonts.isMonospaceFamilyList("Nope, Menlo")).toBe(true);
  expect(fonts.isMonospaceFamilyList("ui-monospace")).toBe(true);
  expect(fonts.isMonospaceFamilyList("sans-serif")).toBe(false);
  fonts.setFontEnumerationForTest({ status: "unknown" });
});
