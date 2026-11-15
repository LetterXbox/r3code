import { expect, open, test } from "nsh/test";
import { chatLaneInset, chatLaneWidth, dockedDetailsInsetEnd, threadDetailsDocks } from "./chatLane";

test("the lane is 736pt in a 973pt chat area and follows the chat width setting", () => {
  expect(chatLaneInset(973)).toBe(48);
  expect(chatLaneInset(500)).toBe(12);
  expect(chatLaneWidth(973, "comfortable")).toBe(736);
  expect(chatLaneWidth(973, "wide")).toBe(877);
  expect(chatLaneWidth(1500, "wide")).toBe(1152);
  expect(chatLaneWidth(973, "full")).toBe(877);
  expect(chatLaneWidth(500, "comfortable")).toBe(476);
});

test("the inset follows the window width, not the chat area (the reference's 640px media query)", () => {
  // A 484pt chat column beside the right panel in a 1280pt window keeps the 48pt inset.
  expect(chatLaneWidth(484, "comfortable", 1280)).toBe(388);
  expect(chatLaneWidth(484, "comfortable", 600)).toBe(460);
});

test("the details card docks when 640pt of chat fits beside it and narrows the lane", () => {
  expect(threadDetailsDocks({ width: 1034, height: 696 }, 1280)).toBe(true);
  expect(threadDetailsDocks({ width: 900, height: 696 }, 1280)).toBe(false);
  // 1034pt canvas: card at 742, lane 48..710 (32pt clearance), so 276pt more inset at the end.
  expect(dockedDetailsInsetEnd(1034, 1280, "comfortable")).toBe(276);
});

function measured(app: { texts(): string[] }, prefix: string) {
  const text = app.texts().find((entry) => entry.startsWith(prefix));
  return text ? Number(text.slice(prefix.length)) : NaN;
}

test("transcript rows and the composer share one 736pt column at 1229x768 with a 256pt sidebar", async () => {
  const app = await open("./ChatColumnFixture.tsx", { width: 1229, height: 768, clock: {} });
  await app.waitUntil(() => measured(app, "row ") > 0 && measured(app, "composer ") > 0);
  // A row's frame fills the 973pt area less the 48pt lane inset each side; the message lane inside it is
  // centred at the same 736pt cap (MessageRow and ComposerLane share chatWidthClass), so the edges coincide.
  expect(measured(app, "row ")).toBe(877);
  expect(measured(app, "composer ")).toBe(736);
});

test("wide and full chat widths widen both together", async () => {
  const app = await open("./ChatColumnFixture.tsx", { width: 1229, height: 768, clock: {} });
  await app.press("label:Use wide");
  await app.waitUntil(() => measured(app, "composer ") === 877);
  expect(measured(app, "row ")).toBe(877);
  await app.press("label:Use full");
  await app.waitUntil(() => measured(app, "composer ") === 877);
});
