import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, "third_party/t3-ghostty");
const require = createRequire(join(vendor, "package.json"));
const { build } = require(process.env.T3GPUI_ESBUILD_PATH || "esbuild");
const shiftedKeys = [
  ["!", "1"], ["@", "2"], ["#", "3"], ["$", "4"], ["%", "5"], ["^", "6"],
  ["&", "7"], ["*", "8"], ["(", "9"], [")", "0"], ["~", "`"], ["_", "-"],
  ["+", "="], ["{", "["], ["}", "]"], ["|", "\\"], [":", ";"], ['"', "'"],
  ["<", ","], [">", "."], ["?", "/"],
];
const shims = {
  platform: "export const isMacPlatform = p => /mac|iphone|ipad|ipod/i.test(p);",
  fonts: "export const isMonospaceFamily = () => true;",
  resize: "export function observeResize(element, callback) { const observer = new ResizeObserver(entries => callback(entries)); observer.observe(element); return () => observer.disconnect(); }",
  selection: "export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;",
  keys: `export const isMacPlatform = p => /mac|iphone|ipad|ipod/i.test(p); export const US_SHIFTED_TO_UNSHIFTED_KEYS = new Map(${JSON.stringify(shiftedKeys)});`,
};
const result = await build({
  entryPoints: [join(vendor, "entry.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  loader: { ".wasm": "dataurl", ".woff2": "dataurl" },
  write: false,
  plugins: [{
    name: "native-shell-adapters",
    setup(build) {
      const aliases = [
        [/(^|\/)lib\/utils$/, "platform"],
        [/appearanceFonts$/, "fonts"],
        [/observeResize$/, "resize"],
        [/selectionActions$/, "selection"],
        [/^@t3tools\/shared\/keybindings$/, "keys"],
      ];
      for (const [filter, path] of aliases) {
        build.onResolve({ filter }, () => ({ path, namespace: "native-shell" }));
      }
      build.onLoad({ filter: /.*/, namespace: "native-shell" }, ({ path }) => ({
        contents: shims[path], loader: "js",
      }));
    },
  }],
});
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const errors = `window.onerror = message => window.nsh.postMessage(JSON.stringify({type:'error',message:String(message)}));
window.onunhandledrejection = event => window.nsh.postMessage(JSON.stringify({type:'error',message:String(event.reason)}));`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#terminal{width:100%;height:100%;margin:0;background:#17212b;overflow:hidden}
#terminal{position:relative}canvas{display:block;width:100%;height:100%;cursor:text}
[role=scrollbar]{position:absolute;top:4px;right:1px;bottom:4px;width:8px;z-index:1}
[role=scrollbar]>div{position:absolute;left:1px;right:1px;background:#666;border-radius:3px}
</style></head><body><div id="terminal"></div><script>${errors}${script}</script></body></html>`;
// The installed NSH bundles image assets separately. Keeping the document in
// SVG metadata avoids parsing the terminal's font and WASM at app startup.
const encoded = Buffer.from(html, "utf8").toString("base64");
await writeFile(join(root, "t3ui/components/terminal/terminalDocument.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><metadata>${encoded}</metadata></svg>`);
