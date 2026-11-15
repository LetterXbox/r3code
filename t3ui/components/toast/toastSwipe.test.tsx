// ui/toast.tsx swipeDirection ["right", "up"] with Base UI's 40 pt threshold.
import { expect, open, test } from "nsh/test";
import { toastSwipeDismisses } from "./ToastHost";

test("toastSwipeDismisses: past 40 pt right or up only", () => {
  expect(toastSwipeDismisses({ x: 41, y: 0 })).toBe(true);
  expect(toastSwipeDismisses({ x: 0, y: -41 })).toBe(true);
  expect(toastSwipeDismisses({ x: 40, y: 0 })).toBe(false);
  expect(toastSwipeDismisses({ x: -80, y: 0 })).toBe(false);
  expect(toastSwipeDismisses({ x: 0, y: 80 })).toBe(false);
});

test("a short or leftward drag keeps the toast; a swipe to the right dismisses it", async () => {
  const app = await open("./ToastSwipeFixture.tsx", { width: 900, height: 600 });
  await app.press("label:Raise");
  await app.waitFor("text:toasts=1");
  await app.drag("label:Swipe to dismiss", { x: -80 });
  await app.drag("label:Swipe to dismiss", { x: 20 });
  await app.wait(100);
  await app.waitFor("text:toasts=1");
  await app.drag("label:Swipe to dismiss", { x: 120 });
  await app.waitFor("text:toasts=0");
});

test("the corner dismiss button still takes a press inside the swipe area", async () => {
  const app = await open("./ToastSwipeFixture.tsx", { width: 900, height: 600 });
  await app.press("label:Raise");
  await app.waitFor("text:toasts=1");
  await app.press("label:Dismiss notification");
  await app.waitFor("text:toasts=0");
});

test("toastSwipeDirection: the swipe's own direction decides the exit", async () => {
  const { toastSwipeDirection } = await import("./ToastHost");
  expect(toastSwipeDirection({ x: 90, y: -10 })).toBe("right");
  expect(toastSwipeDirection({ x: 5, y: -70 })).toBe("up");
  expect(toastSwipeDirection({ x: 10, y: 0 })).toBeNull();
});
