// PreviewImageContent.tsx: the image's size (or "Loading image…"), Zoom out / percentage / Zoom in, Fit image and
// Actual image size, over a scrolling viewport the image is drawn in at that scale (fit: never above 100%).
import { cleanup, Image, Scroll, signal, Text, View } from "nsh";
import { FileSurfaceAction, FileSurfaceFailure } from "./fileSurfaceChrome";

export function fitScale(natural: { width: number; height: number }, viewport: { width: number; height: number }): number {
  if (!natural.width || !natural.height) return 1;
  return Math.min(1, Math.max(1, viewport.width - 32) / natural.width, Math.max(1, viewport.height - 32) / natural.height);
}

export function zoomedScale(scale: number, factor: number): number {
  return Math.max(0.05, Math.min(8, scale * factor));
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff" };

/** imageDecode.worker: HEIF/HEIC and TIFF, which the web app decodes itself, are previewed up to 50 MB, 32 megapixels and
 * 16,384 pixels per side; past that its decoder refuses and the viewer shows "Unable to load image." (native decoding
 * here reads them, so the same bounds are applied to what it reads). */
export const decodedImageKind = (name: string) => /\.(?:hei[cf]|tiff?)$/i.test(name);
export function decodedImageFits(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 16384 && height <= 16384 && width <= 32_000_000 / height;
}
const DECODED_IMAGE_MAX_BYTES = 50 * 1024 * 1024;

/** `load` reads the image's bytes (a workspace file: the runtime grants no file: image URLs, so it is shown from memory). */
export function ImagePreview(props: { src?: string; load?: () => Promise<Uint8Array>; name: string; onError?: () => void }) {
  const failed = signal(false);
  const natural = signal({ width: 0, height: 0 });
  const viewport = signal({ width: 0, height: 0 });
  const zoom = signal<number | null>(null);
  const scale = () => zoom() ?? fitScale(natural(), viewport());
  const changeZoom = (factor: number) => zoom.set(zoomedScale(scale(), factor));
  const src = signal(props.src ?? "");
  const fail = () => { failed.set(true); props.onError?.(); };
  const decoded = decodedImageKind(props.name);
  const sized = (size: { width: number; height: number }) => {
    if (decoded && !decodedImageFits(size.width, size.height)) { fail(); return; }
    natural.set(size);
  };
  // The size comes from the image itself before it is drawn: an image with no size yet is laid out at nothing.
  // getSize answers file and network images; a blob image's size comes from its own onLoad (it may refuse a blob URL).
  const measure = (url: string) => void Image.getSize(url).then((size) => { if (size.width > 0) sized({ width: size.width, height: size.height }); }).catch(() => {});
  if (props.load) {
    const extension = props.name.slice(props.name.lastIndexOf(".") + 1).toLowerCase();
    void props.load().then((bytes) => {
      if (decoded && bytes.length > DECODED_IMAGE_MAX_BYTES) { fail(); return; }
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: IMAGE_TYPES[extension] ?? "application/octet-stream" }));
      cleanup(() => URL.revokeObjectURL(url));
      src.set(url);
      measure(url);
    }).catch(fail);
  } else if (props.src) measure(props.src);
  return (
    <View class="min-h-0 min-w-0 flex-1 flex-col overflow-hidden" accessibilityLabel="Image preview">
      {failed() ? <FileSurfaceFailure message="Unable to load image." /> : <>
      <View class="min-h-10 shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-b border-border-60 px-3 py-1">
        <Text class="text-xs tabular-nums text-muted-foreground">{natural().width ? `${natural().width.toLocaleString()} × ${natural().height.toLocaleString()}` : "Loading image…"}</Text>
        <View class="flex-row items-center gap-1">
          <FileSurfaceAction label="Zoom out" icon="minus" disabled={!natural().width || scale() <= 0.05} onPress={() => changeZoom(1 / 1.25)} />
          <Text class="min-w-10 text-center text-xs tabular-nums text-muted-foreground">{`${Math.round(scale() * 100)}%`}</Text>
          <FileSurfaceAction label="Zoom in" icon="plus" disabled={!natural().width || scale() >= 8} onPress={() => changeZoom(1.25)} />
          <FileSurfaceAction label="Fit image" icon="scan" pressed={zoom() === null} onPress={() => zoom.set(null)} />
          <FileSurfaceAction label="Actual image size" icon="maximize" pressed={zoom() === 1} onPress={() => zoom.set(1)} />
        </View>
      </View>
      {/* One Scroll scrolls one way: a vertical one around a sideways one scrolls a zoomed image both ways. */}
      <Scroll class="min-h-0 flex-1" onLayout={(event) => viewport.set({ width: event.bounds.size.width, height: event.bounds.size.height })}>
        <Scroll horizontal>
        <View
          class="items-center justify-center p-4"
          style={{
            minWidth: viewport().width,
            minHeight: viewport().height,
            ...(natural().width ? { width: Math.max(viewport().width, natural().width * scale() + 32), height: Math.max(viewport().height, natural().height * scale() + 32) } : {}),
          }}
        >
          {src() ? <Image
            src={src()}
            accessibilityLabel={props.name}
            onLoad={(event) => sized({ width: event.size.width, height: event.size.height })}
            onError={() => { failed.set(true); props.onError?.(); }}
            style={natural().width ? { width: natural().width * scale(), height: natural().height * scale() } : { width: 1, height: 1 }}
          /> : null}
        </View>
        </Scroll>
      </Scroll>
      </>}
    </View>
  );
}
