// ZoomableImage.tsx's zoom and pan math: the viewport is the image's box (at most the dialog's), the content the fitted image
// times the zoom; zooming keeps the point under the pointer (or the middle) in place, and the pan stays inside the content.

/** ZoomableImage MAX_ZOOM. */
export const MAX_ZOOM = 8;

export interface ZoomView {
  readonly zoom: number;
  readonly left: number;
  readonly top: number;
}

export interface ZoomBox {
  /** The fitted image at zoom 1. */
  readonly width: number;
  readonly height: number;
  /** The most room the viewport may take. */
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/** The viewport: the zoomed image, no larger than the room it has. */
export function zoomViewport(box: ZoomBox, zoom: number): { width: number; height: number } {
  return { width: Math.min(box.width * zoom, box.maxWidth), height: Math.min(box.height * zoom, box.maxHeight) };
}

/** A pan kept inside the content (scrollLeft / scrollTop clamped as a scroll node clamps them). */
export function clampPan(box: ZoomBox, view: ZoomView): ZoomView {
  const viewport = zoomViewport(box, view.zoom);
  const maxLeft = Math.max(0, box.width * view.zoom - viewport.width);
  const maxTop = Math.max(0, box.height * view.zoom - viewport.height);
  return { zoom: view.zoom, left: Math.min(maxLeft, Math.max(0, view.left)), top: Math.min(maxTop, Math.max(0, view.top)) };
}

/**
 * ZoomableImage changeZoom: clamps to 1..MAX_ZOOM and keeps the content point under `point` (viewport coordinates; the
 * middle of the viewport without one) where it was. The same view comes back when the zoom does not change.
 */
export function changeZoom(box: ZoomBox, view: ZoomView, next: number, point?: { x: number; y: number }): ZoomView {
  const clamped = Math.min(MAX_ZOOM, Math.max(1, next));
  if (clamped === view.zoom) return view;
  const viewport = zoomViewport(box, view.zoom);
  const x = point ? point.x : viewport.width / 2;
  const y = point ? point.y : viewport.height / 2;
  const anchorX = (view.left + x) / view.zoom;
  const anchorY = (view.top + y) / view.zoom;
  // The viewport grows with the zoom (up to its room) around its center, so the pointer's place in it moves with it.
  const resized = zoomViewport(box, clamped);
  const shiftX = (resized.width - viewport.width) / 2;
  const shiftY = (resized.height - viewport.height) / 2;
  return clampPan(box, { zoom: clamped, left: anchorX * clamped - (x + shiftX), top: anchorY * clamped - (y + shiftY) });
}

/** ZoomableImage's wheel: a notch zooms by e^(-deltaY * 0.002), Ctrl (a touchpad pinch in browsers) five times faster. */
export function wheelZoom(zoom: number, deltaY: number, ctrl: boolean): number {
  return zoom * Math.exp(-deltaY * (ctrl ? 0.01 : 0.002));
}

/** ZoomableImage onClick: a click toggles between fit and 2x. */
export function clickZoom(zoom: number): number {
  return zoom > 1 ? 1 : 2;
}

/** ZoomableImage onPointerMove: a drag of more than 4 points is a pan, and the click it ends with does not zoom. */
export const DRAG_CLICK_SLOP = 4;
