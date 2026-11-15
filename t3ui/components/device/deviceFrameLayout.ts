// deviceFrameLayout.ts (components/device/deviceFrameLayout.ts): the largest aspect-correct frame that fits the host
// box once the controls rail's inset is taken off its width.
export function fitDeviceFrame(aspect: number, width: number, height: number, rightInset: number) {
  const availableWidth = Math.max(0, width - rightInset);
  if (availableWidth === 0 || height === 0) return { width: 0, height: 0 };
  const byHeight = { width: height * aspect, height };
  return byHeight.width <= availableWidth
    ? byHeight
    : { width: availableWidth, height: availableWidth / aspect };
}
