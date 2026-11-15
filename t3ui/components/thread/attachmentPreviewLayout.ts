/** ExpandedImageDialog / ZoomableImage: fit inside 92vw and min(86vh, height - 160), without enlarging raster images. */
export function attachmentPreviewSize(viewport: { width: number; height: number }, image: { width: number; height: number }) {
  const maxWidth = Math.max(1, viewport.width * 0.92 - (viewport.width >= 640 ? 96 : 0));
  const maxHeight = Math.max(1, Math.min(viewport.height * 0.86, viewport.height - 160));
  const scale = Math.min(1, maxWidth / Math.max(1, image.width), maxHeight / Math.max(1, image.height));
  return { width: Math.max(1, image.width * scale), height: Math.max(1, image.height * scale) };
}
