import { expect, open, test } from "nsh/test";
import { clampHtmlRenderHeight, htmlRenderFileName, htmlRenderFrameHeight, htmlRenderFromToolItem } from "./htmlRenderReference";
import { htmlRenderThemeFragment, readContentHeight } from "./HtmlRender";

test("html_render references come from a completed call's envelope; failures and other tools have none", () => {
  const output = { content: [{ type: "text", text: JSON.stringify({ htmlRender: { attachmentId: "a", title: "  T  ", height: 5000 } }) }] };
  expect(htmlRenderFromToolItem({ type: "dynamic_tool", status: "completed", toolName: "mcp__t3-code__html_render", output })).toEqual({ attachmentId: "a", title: "T", height: 2000 });
  expect(htmlRenderFromToolItem({ type: "dynamic_tool", status: "running", toolName: "mcp__t3-code__html_render", output })).toBe(undefined);
  expect(htmlRenderFromToolItem({ type: "dynamic_tool", status: "completed", toolName: "mcp__other__thing", output })).toBe(undefined);
  expect(htmlRenderFromToolItem({ type: "dynamic_tool", status: "completed", toolName: "mcp__t3-code__html_render", output: { isError: true, content: output.content } })).toBe(undefined);
});

test("frame height: live content wins, then per-width measurements, then the agent's height, clamped", () => {
  expect(clampHtmlRenderHeight(10)).toBe(80);
  expect(htmlRenderFrameHeight({ attachmentId: "a", title: "t", height: 300 }, 700)).toBe(300);
  expect(htmlRenderFrameHeight({ attachmentId: "a", title: "t", height: 300 }, 700, 512.2)).toBe(513);
  expect(htmlRenderFrameHeight({ attachmentId: "a", title: "t", height: 900, heights: [[320, 800], [728, 400], [1000, 350]] }, 700)).toBe(800);
  expect(htmlRenderFileName("a/b: c")).toBe("a b c.html");
  expect(readContentHeight(JSON.stringify({ height: 240 }))).toBe(240);
  expect(readContentHeight("nope")).toBe(undefined);
});

test("the row mints an inline text/html URL; the card fallback offers Open full screen, which opens the zoomable dialog", async () => {
  const app = await open("./HtmlRenderFixture.tsx", { width: 900, height: 900 });
  await expect(app.texts()).toContain("row html-render");
  await expect(app.texts()).toContain("Sales chart");
  await expect(app.texts()).toContain('calls 2 assets.createUrl {"resource":{"_tag":"attachment","attachmentId":"att-1","fileName":"Sales chart.html","mimeType":"text/html","disposition":"inline"}}');
  await app.press("label:Open full screen");
  await expect(app.texts()).toContain("100%");
  await app.press("label:Zoom in");
  await expect(app.texts()).toContain("125%");
  await app.press("label:Reset zoom");
  await expect(app.texts()).toContain("100%");
  await app.press("label:Close");
  await expect(app.texts()).not.toContain("100%");
});

test("the theme fragment carries every variable a page may use: charts, radius, fonts, fixed status colors", () => {
  const tokens: Record<string, string> = { background: "#000", foreground: "#fff", primary: "#346bf1", muted: "#111" };
  const fragment = htmlRenderThemeFragment("dark", (name) => tokens[name]);
  const theme = JSON.parse(decodeURIComponent(fragment.slice("#t3-theme=".length))) as { appearance: string; variables: Record<string, string> };
  expect(theme.appearance).toBe("dark");
  expect(theme.variables["--chart-1"]).toBe("#346bf1");
  expect(theme.variables["--chart-2"]).toBe("#2dd4bf");
  expect(theme.variables["--chart-6"]).toBe("#a3e635");
  expect(theme.variables["--radius"]).toBe("0.625rem");
  expect(theme.variables["--success-foreground"]).toBe("#34d399");
  expect(theme.variables["--code-background"]).toBe("#111");
});

test("a rebuilt row (a new reference object, same attachment) keeps its page: no new mint, no new WebView", async () => {
  const app = await open("./HtmlRenderFixture.tsx", { width: 900, height: 900 });
  await expect(app.texts()).toContain('calls 2 assets.createUrl {"resource":{"_tag":"attachment","attachmentId":"att-1","fileName":"Sales chart.html","mimeType":"text/html","disposition":"inline"}}');
  await app.press("label:Rebuild rows");
  await app.press("label:Rebuild rows");
  await expect(app.texts()).toContain('calls 2 assets.createUrl {"resource":{"_tag":"attachment","attachmentId":"att-1","fileName":"Sales chart.html","mimeType":"text/html","disposition":"inline"}}');
});
