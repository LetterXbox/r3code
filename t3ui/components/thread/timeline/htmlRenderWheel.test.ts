import { expect, test } from "nsh/test";
import { forwardArtifactWheel, readTimelineWheel } from "./htmlRenderWheel";
import { createTimelineFollow } from "./timelineFollow";

test("invalid wheel messages are ignored", () => {
  expect(readTimelineWheel('{"height":100}')).toBe(undefined);
  expect(readTimelineWheel('{"timelineWheel":"10"}')).toBe(undefined);
  expect(readTimelineWheel("not json")).toBe(undefined);
});

test("artifact wheel input keeps following at the end and releases when scrolling up", () => {
  let following = true;
  let pill = false;
  let cancellations = 0;
  const distances: number[] = [];
  const follow = createTimelineFollow({
    scrollToEnd: () => {},
    following: { get: () => following, set: (value) => { following = value; } },
    showPill: { get: () => pill, set: (value) => { pill = value; } },
  });
  follow.onScroll({ top: 1000, contentHeight: 1500, viewportHeight: 500 });
  const io = { cancelRestore: () => { cancellations += 1; }, follow, scroll: (delta: number) => { distances.push(delta); } };
  forwardArtifactWheel(40, io);
  expect(following).toBe(true);
  forwardArtifactWheel(-40, io);
  expect(following).toBe(false);
  expect(distances).toEqual([40, -40]);
  expect(cancellations).toBe(2);
  follow.dispose();
});

