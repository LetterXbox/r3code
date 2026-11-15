// Bundles the reference's 3D device viewer (third_party/t3-device-viewer: client-runtime/device, mountDeviceViewer,
// phoneTrackpad, three.js) into the Device panel's 3D WebView page, and each device model into its own asset.
// Like build-terminal.mjs, the page and the models ride in SVG <metadata> (base64), because the installed NSH bundles
// image assets separately and parsing them at startup would be slow. Run after changing the vendored viewer.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, "third_party/t3-device-viewer");
const out = join(root, "t3ui/components/device");
const require = createRequire(join(vendor, "package.json"));
const { build } = require(process.env.T3GPUI_ESBUILD_PATH || "esbuild");
const shims = {
  resize: "export function observeResize(element, callback) { const observer = new ResizeObserver(entries => callback(entries)); observer.observe(element); return () => observer.disconnect(); }",
};
const result = await build({
  entryPoints: [join(vendor, "entry.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
  plugins: [{
    name: "native-shell-adapters",
    setup(build) {
      build.onResolve({ filter: /observeResize$/ }, () => ({ path: "resize", namespace: "native-shell" }));
      build.onResolve({ filter: /^@t3tools\/client-runtime\/device\/phone-interaction$/ }, () => ({ path: join(vendor, "src/device/phoneInteraction.ts") }));
      build.onLoad({ filter: /.*/, namespace: "native-shell" }, ({ path }) => ({ contents: shims[path], loader: "js" }));
    },
  }],
});
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
// `__T3_VIEWER_CONFIG__` is replaced by the app (deviceViewer.ts) with the device's config and models.
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#host{position:absolute;inset:0}
canvas{display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none}
</style></head><body><div id="host"><canvas id="viewer" aria-label="Interactive 3D device. Drag the screen to interact. Drag outside it or swipe with two fingers to turn."></canvas></div>
<script>window.T3_VIEWER=__T3_VIEWER_CONFIG__;</script><script>${script}</script></body></html>`;
const svg = (base64) => `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><metadata>${base64}</metadata></svg>`;
await writeFile(join(out, "deviceViewerDocument.svg"), svg(Buffer.from(html, "utf8").toString("base64")));
for (const id of ["iphone-18-pro", "iphone-18-pro-max", "ipad-pro-13-m5", "ipad-pro-13-m5-magic-keyboard", "iphone-duo"]) {
  const bytes = await readFile(join(vendor, "models", `${id}.glb`));
  await writeFile(join(out, "models", `${id}.svg`), svg(bytes.toString("base64")));
}
console.log(`device viewer page ${html.length} B`);
