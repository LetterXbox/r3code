import { expect, test } from "nsh/test";
import { installOpenLink, OPEN_LINK_SCRIPT, parseFaviconMessage, parseOpenLinkMessage } from "./previewLinks";

function page() {
  const posted: any[] = [];
  const listeners: Record<string, (e: any) => void> = {};
  const doc = { baseURI: "http://localhost:3000/app/", addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; } };
  const win: any = { nsh: { postMessage: (m: string) => posted.push(JSON.parse(m)) }, open: () => "native" };
  installOpenLink({ window: win, document: doc, URL });
  const link = (attrs: Record<string, string>) => ({ tagName: "A", href: new URL(attrs.href!, doc.baseURI).href, getAttribute: (k: string) => attrs[k] ?? null, parentNode: doc });
  const fire = (type: string, target: any, extra: Record<string, unknown> = {}) => { let prevented = false; listeners[type]!({ target, button: 0, defaultPrevented: false, preventDefault: () => { prevented = true; }, stopPropagation() {}, ...extra }); return prevented; };
  return { win, posted, link, fire };
}

test("fm13: window.open and target=_blank open a new tab; Cmd/Ctrl and middle click open a background tab", () => {
  const p = page();
  expect(p.win.open("/docs")).toBeNull();
  expect(p.posted.at(-1)).toEqual({ t3: "open-link", url: "http://localhost:3000/docs", background: false });
  expect(p.win.open("")).toBe("native");
  expect(p.fire("click", p.link({ href: "x", target: "_blank" }))).toBe(true);
  expect(p.posted.at(-1)).toEqual({ t3: "open-link", url: "http://localhost:3000/app/x", background: false });
  expect(p.fire("click", p.link({ href: "https://example.com/" }), { metaKey: true })).toBe(true);
  expect(p.posted.at(-1)).toMatchObject({ background: true });
  expect(p.fire("auxclick", p.link({ href: "/m" }), { button: 1 })).toBe(true);
  expect(p.posted.at(-1)).toMatchObject({ url: "http://localhost:3000/m", background: true });
  // A plain click is the page's own navigation; a mailto link is not a tab.
  expect(p.fire("click", p.link({ href: "/plain" }))).toBe(false);
  expect(p.fire("click", { tagName: "A", href: "mailto:a@b.c", getAttribute: () => "_blank", parentNode: null })).toBe(false);
});

test("fm13: the injected script is the page function's own source", () => {
  expect(OPEN_LINK_SCRIPT.startsWith("(function installOpenLink(env)")).toBe(true);
  expect(/__name|__require/.test(OPEN_LINK_SCRIPT)).toBe(false);
});

test("fm13: only an http(s) open-link report is read", () => {
  expect(parseOpenLinkMessage(JSON.stringify({ t3: "open-link", url: "https://x.dev/", background: true }))).toEqual({ url: "https://x.dev/", background: true });
  expect(parseOpenLinkMessage(JSON.stringify({ t3: "open-link", url: "javascript:alert(1)" }))).toBeNull();
  expect(parseOpenLinkMessage(JSON.stringify({ t3: "audio", audible: true }))).toBeNull();
  expect(parseOpenLinkMessage("nope")).toBeNull();
});

// FaviconCapture.ts parity: an inline SVG is never accepted (it can carry a <script>), a data: icon over
// MAX_FAVICON_DATA_URL_LENGTH is dropped, and an http(s) icon over MAX_FAVICON_HTTP_URL_LENGTH is dropped.
test("fm13: favicon reports reject inline SVG and over-length candidates", () => {
  const favicon = (href: string) => parseFaviconMessage(JSON.stringify({ t3: "favicon", page: "p", href }));
  expect(favicon("data:image/svg+xml,<svg onload=alert(1)></svg>")).toBeNull();
  expect(favicon("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
  expect(favicon("data:image/png;base64,iVBORw0KGgo=")).toEqual({ page: "p", href: "data:image/png;base64,iVBORw0KGgo=" });
  expect(favicon(`data:image/png;base64,${"A".repeat(100_100)}`)).toBeNull();
  expect(favicon(`https://example.com/${"a".repeat(2_100)}.ico`)).toBeNull();
  expect(favicon("https://example.com/favicon.ico")).toEqual({ page: "p", href: "https://example.com/favicon.ico" });
});

test("fm13: the page reports its own icon, and the icon sources put it first", async () => {
  const posted: any[] = [];
  const doc = { baseURI: "http://localhost:3000/", readyState: "complete", addEventListener() {}, querySelectorAll: () => [{ href: "http://localhost:3000/icon.svg" }] };
  installOpenLink({ window: { nsh: { postMessage: (m: string) => posted.push(JSON.parse(m)) }, open() {}, location: { href: "http://localhost:3000/app" } }, document: doc, URL });
  expect(posted.at(-1)).toEqual({ t3: "favicon", page: "http://localhost:3000/app", href: "http://localhost:3000/icon.svg" });
  expect(parseFaviconMessage(JSON.stringify({ t3: "favicon", page: "p", href: "javascript:x" }))).toBeNull();
  const { faviconSources, recordPageFavicon } = await import("./previewEmpty");
  recordPageFavicon("http://localhost:3000/app", "http://localhost:3000/icon.svg");
  expect(faviconSources("http://localhost:3000/app#x")).toEqual(["http://localhost:3000/icon.svg", "http://localhost:3000/favicon.ico"]);
  expect(faviconSources("http://localhost:3000/other")).toEqual(["http://localhost:3000/icon.svg", "http://localhost:3000/favicon.ico"]);
});
