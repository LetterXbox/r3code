// Canvas painters for themeArtData.ts: the colour-scheme wireframes and the theme spheres.
import { Canvas, type CanvasRenderingContext2D } from "nsh";
import type { ThemeAppearance, ThemePreviewColors } from "../../themePreviews";
import { sphereSpec, wireframePanes, wireframeShapes, WIREFRAME_LINE } from "./themeArtData";

function drawPane(cx: CanvasRenderingContext2D, w: number, h: number, colors: ThemePreviewColors) {
  for (const shape of wireframeShapes(colors, w / h)) {
    if (shape.kind === "edge") {
      cx.fillStyle = WIREFRAME_LINE;
      cx.fillRect(shape.x * w - 1, 0, 1, h);
      continue;
    }
    cx.globalAlpha = shape.opacity ?? 1;
    cx.fillStyle = shape.fill;
    if (shape.kind === "circle") {
      const r = (shape.d * h) / 2;
      cx.beginPath();
      cx.arc(shape.cx * w, shape.cy * h, r, 0, Math.PI * 2);
      cx.fill();
      cx.globalAlpha = 1;
      continue;
    }
    const x = shape.x * w;
    const y = shape.y * h;
    const rw = shape.w * w;
    const rh = shape.h * h;
    const radius = Math.min(shape.radius, rw / 2, rh / 2);
    if (shape.shadow) {
      cx.shadowColor = "rgba(0,0,0,0.14)";
      cx.shadowBlur = 5;
      cx.shadowOffsetY = 2;
    }
    cx.beginPath();
    cx.roundRect(x, y, rw, rh, radius);
    cx.fill();
    cx.shadowColor = "rgba(0,0,0,0)";
    cx.shadowBlur = 0;
    cx.shadowOffsetY = 0;
    cx.globalAlpha = 1;
    if (shape.ring) {
      cx.strokeStyle = WIREFRAME_LINE;
      cx.lineWidth = 1;
      cx.beginPath();
      cx.roundRect(x + 0.5, y + 0.5, rw - 1, rh - 1, Math.max(0, radius - 0.5));
      cx.stroke();
    }
  }
}

/** ThemeWireframe: System is the light pane's left half beside the dark pane's right half, a 2px gap between. */
export function ThemeWireframe(props: { mode: "system" | ThemeAppearance; colors: (appearance: ThemeAppearance) => ThemePreviewColors }) {
  return (
    <Canvas
      class="h-full w-full"
      draw={(cx, size) => {
        for (const pane of wireframePanes(props.mode)) {
          cx.save();
          if (pane.clip) {
            cx.beginPath();
            if (pane.clip === "left") cx.rect(0, 0, size.width / 2 - 1, size.height);
            else cx.rect(size.width / 2 + 1, 0, size.width / 2 - 1, size.height);
            cx.clip();
          }
          drawPane(cx, size.width, size.height, props.colors(pane.appearance));
          cx.restore();
        }
      }}
    />
  );
}

/** ThemePreviewCircle: the soft sphere (the reference's two radial gradients over the mixed base). */
export function ThemeSphere(props: { colors: ThemePreviewColors; mode: ThemeAppearance }) {
  return (
    <Canvas
      class="size-[52px]"
      draw={(cx, size) => {
        const spec = sphereSpec(props.colors, props.mode);
        const w = size.width;
        const h = size.height;
        cx.save();
        cx.beginPath();
        cx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2);
        cx.clip();
        cx.fillStyle = spec.base;
        cx.fillRect(0, 0, w, h);
        cx.translate(w / 2, h / 2);
        cx.scale(spec.scale, spec.scale);
        cx.translate(-w / 2, -h / 2);
        for (const gradient of spec.gradients) {
          const gx = gradient.center[0] * w;
          const gy = gradient.center[1] * h;
          const fill = cx.createRadialGradient(gx, gy, 0, gx, gy, gradient.radius * w);
          for (const stop of gradient.stops) fill.addColorStop(stop.offset, stop.color);
          cx.fillStyle = fill;
          cx.fillRect(0, 0, w, h);
        }
        cx.restore();
        cx.strokeStyle = spec.edge;
        cx.lineWidth = 1;
        cx.beginPath();
        cx.arc(w / 2, h / 2, w / 2 - 0.5, 0, Math.PI * 2);
        cx.stroke();
      }}
    />
  );
}
