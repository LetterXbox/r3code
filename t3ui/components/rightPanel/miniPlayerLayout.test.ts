// The floating preview's frame: the reference's own cases (previewMiniPlayerLayout.test.ts, chatCanvasLayout.test.ts).
import { expect, test } from "nsh/test";
import {
  clampMiniPlayerPosition, MINI_PLAYER_EDGE_GAP, resizeMiniPlayer, resolveChatCanvasLayout, resolveMiniPlayerFrame,
  type ChatCanvasPreview, type MiniPlayerObstacles,
} from "./miniPlayerLayout";

const container = { width: 1_000, height: 700 };
const source = { width: 1_600, height: 1_000 };
const gap = MINI_PLAYER_EDGE_GAP;
const composer = { left: 100, right: 900, height: 150 };
const obstacles: MiniPlayerObstacles = { composer, detailsCard: null };
const tallComposer: MiniPlayerObstacles = { composer: { ...composer, height: 300 }, detailsCard: null };

test("the default card is 320 wide at the source's proportions, top right of a bare container", () => {
  expect(resolveMiniPlayerFrame({ width: null, position: null, source, container })).toEqual({ x: 1_000 - gap - 320, y: gap, width: 320, height: 200 });
  // A source taller than wide fits the 320 box by its height, and is never narrower than 240.
  expect(resolveMiniPlayerFrame({ width: null, position: null, source: { width: 900, height: 1_000 }, container })).toMatchObject({ width: 288, height: 320 });
  expect(resolveMiniPlayerFrame({ width: null, position: null, source: { width: 500, height: 1_000 }, container })).toMatchObject({ width: 240, height: 480 });
});

test("a stored width shrinks to the space above the composer without being lost", () => {
  expect(resolveMiniPlayerFrame({ width: 800, position: { x: 100, y: 80 }, source, container, obstacles: tallComposer })).toEqual({ x: 100, y: gap, width: 602, height: 376 });
});

test("a corner drag is projected onto the aspect-ratio diagonal and does not jump", () => {
  const start = { x: 300, y: 200, width: 320, height: 200 };
  expect(resizeMiniPlayer({ start, direction: "southeast", delta: { x: 20, y: 100 }, source, container })).toEqual({ x: 300, y: 200, width: 379, height: 237 });
  const frames = [-99, -100, -101].map((y) => resizeMiniPlayer({ start, direction: "southeast", delta: { x: 160, y }, source, container }));
  expect(Math.abs(frames[0]!.width - frames[2]!.width) <= 2).toBe(true);
});

test("a resize stops at the container edge, never under 240 x 150, and shifts when the free axis would overflow", () => {
  expect(resizeMiniPlayer({ start: { x: 600, y: 12, width: 320, height: 200 }, direction: "east", delta: { x: 500, y: 0 }, source, container })).toEqual({ x: 600, y: 12, width: 388, height: 243 });
  expect(resizeMiniPlayer({ start: { x: 12, y: 400, width: 320, height: 200 }, direction: "east", delta: { x: 300, y: 0 }, source, container })).toEqual({ x: 12, y: 300, width: 620, height: 388 });
  expect(resizeMiniPlayer({ start: { x: 300, y: 200, width: 320, height: 200 }, direction: "east", delta: { x: -300, y: 0 }, source, container })).toEqual({ x: 300, y: 200, width: 240, height: 150 });
  // A west or north handle keeps the opposite edge where it was.
  expect(resizeMiniPlayer({ start: { x: 300, y: 200, width: 320, height: 200 }, direction: "west", delta: { x: -80, y: 0 }, source, container })).toEqual({ x: 220, y: 200, width: 400, height: 250 });
  expect(resizeMiniPlayer({ start: { x: 300, y: 200, width: 320, height: 200 }, direction: "northwest", delta: { x: -80, y: -50 }, source, container })).toMatchObject({ x: 220, y: 150 });
});

test("a resize stops growing downward at the composer beneath it", () => {
  expect(resizeMiniPlayer({ start: { x: 300, y: 100, width: 320, height: 200 }, direction: "south", delta: { x: 0, y: 400 }, source, container, obstacles: tallComposer }))
    .toEqual({ x: 300, y: 100, width: 461, height: 288 });
});

test("a position is clamped 12pt inside the container and clear of the composer", () => {
  expect(clampMiniPlayerPosition({ x: -50, y: 9_999 }, container, { width: 320, height: 200 })).toEqual({ x: gap, y: 700 - gap - 200 });
  expect(clampMiniPlayerPosition({ x: 20, y: 500 }, container, { width: 60, height: 150 }, obstacles)).toEqual({ x: 20, y: 500 });
  expect(clampMiniPlayerPosition({ x: 850, y: 500 }, container, { width: 60, height: 150 }, obstacles)).toEqual({ x: composer.right + gap, y: 500 });
  expect(clampMiniPlayerPosition({ x: 100, y: 100 }, container, { width: 976, height: 500 }, obstacles)).toEqual({ x: gap, y: 700 - 150 - gap - 500 });
});

// --- on the chat canvas ---------------------------------------------------------------------------------------

const preview: ChatCanvasPreview = { width: 320, position: null, source };
const resolve = (width: number, player: ChatCanvasPreview | null = preview, height = 900) =>
  resolveChatCanvasLayout({ container: { width, height }, preview: player, composerHeight: 180 });

test("with no stored place the card sits at the bottom right, above the composer while it overlaps the chat lane", () => {
  // A canvas too narrow for a readable lane beside the card: the card overlaps the lane and keeps clear of the composer.
  const narrow = resolve(1_000);
  expect(narrow.overlapsChat).toBe(true);
  expect(narrow.frame).toEqual({ x: 1_000 - gap - 320, y: 900 - 180 - gap - 200, width: 320, height: 200 });
  expect(narrow.chat).toEqual(resolve(1_000, null).chat);
  // A wide canvas: the lane moves over and the card sits in the bottom right corner beside it.
  const wide = resolve(1_344);
  expect(wide.overlapsChat).toBe(false);
  expect(wide.frame).toEqual({ x: 1_344 - gap - 320, y: 900 - gap - 200, width: 320, height: 200 });
  expect(wide.chat.left + wide.chat.width <= wide.frame!.x - gap).toBe(true);
  expect(wide.chat.width >= 640).toBe(true);
});

test("a drag crosses a canvas with no room for a lane beside the card, and comes back", () => {
  for (const width of [900, 1_000, 1_004]) {
    const start = resolve(width, { ...preview, position: { x: width - 332, y: 200 } }).frame!;
    const moved = resolve(width, { ...preview, position: { x: start.x - 300, y: start.y }, lastInteraction: "drag" });
    expect(moved.frame).toEqual({ ...start, x: start.x - 300 });
    expect(resolve(width, { ...preview, position: { x: start.x, y: start.y }, lastInteraction: "drag" }).frame).toEqual(start);
  }
});

test("on a wide canvas a drag to the left stops before the card would push the chat lane to the right", () => {
  const centered = resolve(1_344, null).chat;
  for (const x of [1_100, 800, 700, 600, 400, 12, -100]) {
    const result = resolve(1_344, { ...preview, position: { x, y: 500 } });
    expect(result.frame!.x >= 700).toBe(true);
    expect(result.chat.left <= centered.left).toBe(true);
    expect(result.chat.width >= 640).toBe(true);
    expect(result.frame!.x >= result.chat.left + result.chat.width + 12).toBe(true);
  }
  expect(resolve(1_344, { ...preview, position: { x: 12, y: 500 } }).frame!.x).toBe(700);
});

test("a dragged card stays above the composer when no readable lane fits beside it", () => {
  const result = resolve(1_000, { ...preview, position: { x: 12, y: 700 } });
  expect(result.chat).toEqual(resolve(1_000, null).chat);
  expect(result.frame!.x).toBe(12);
  expect(result.frame!.y + result.frame!.height <= 708).toBe(true);
});

test("a narrow canvas shrinks the card for this layout only: the stored width comes back when it grows", () => {
  const player = { ...preview, width: 480 };
  expect(resolve(400, player, 500).frame!.width).toBe(376);
  expect(resolve(1_800, player).frame!.width).toBe(480);
  expect(resolve(0, player).frame).toBe(null);
});

test("a device's source size: a phone before the stream reports a screen, the reported screen upright or in landscape", async () => {
  const { resolveDeviceMiniPlayerSourceSize } = await import("./miniPlayerLayout");
  expect(resolveDeviceMiniPlayerSourceSize("ios", null)).toEqual({ width: 1000, height: 1000 / (9 / 19.5) });
  expect(resolveDeviceMiniPlayerSourceSize("android", null)).toEqual({ width: 1000, height: 1000 / (9 / 20) });
  expect(resolveDeviceMiniPlayerSourceSize("ios", { width: 2556, height: 1179, orientation: "portrait" })).toEqual({ width: 1179, height: 2556 });
  expect(resolveDeviceMiniPlayerSourceSize("android", { width: 1080, height: 2400, orientation: "landscape_left" })).toEqual({ width: 2400, height: 1080 });
});

test("a device's corner radius: the frame's on iOS, 14% of the short side on Android (never below the frame's)", async () => {
  const { resolveDeviceMiniPlayerCornerRadius } = await import("./miniPlayerLayout");
  expect(resolveDeviceMiniPlayerCornerRadius("ios", { width: 300, height: 600 })).toBe(12);
  expect(resolveDeviceMiniPlayerCornerRadius("android", { width: 300, height: 600 })).toBe(42);
  expect(resolveDeviceMiniPlayerCornerRadius("android", { width: 50, height: 100 })).toBe(12);
});
