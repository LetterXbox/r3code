// @ts-nocheck -- previewLinks.ts: runs inside the preview page before its own scripts (serialized with toString and
// injected), plain JavaScript that reads nothing outside itself. window.open and target=_blank links are reported as
// { t3: "open-link", url, background: false }; a Cmd/Ctrl-click or middle click on a link as background: true.
export function installOpenLink(env) {
  var W = env.window, D = env.document;
  try {
    if (W.__t3OpenLink) return;
    W.__t3OpenLink = true;
    var post = function (url, background) {
      try {
        var resolved = new env.URL(String(url), D.baseURI).href;
        if (!/^https?:/i.test(resolved)) return false;
        W.nsh.postMessage(JSON.stringify({ t3: "open-link", url: resolved, background: !!background }));
        return true;
      } catch (e) { return false; }
    };
    var open = W.open;
    W.open = function (url) {
      if (url === undefined || url === null || url === "" || !post(url, false)) return open.apply(W, arguments);
      return null;
    };
    var linkOf = function (target) {
      while (target && target !== D) { if (target.tagName === "A" && target.href) return target; target = target.parentNode; }
      return null;
    };
    var handle = function (event, middle) {
      if (event.defaultPrevented) return;
      var a = linkOf(event.target);
      if (!a) return;
      var modified = middle || event.metaKey || event.ctrlKey;
      var blank = (a.getAttribute("target") || "").toLowerCase() === "_blank";
      if (!modified && !blank) return;
      if (post(a.href, modified)) { event.preventDefault(); event.stopPropagation(); }
    };
    D.addEventListener("click", function (event) { if (event.button === 0) handle(event, false); }, true);
    D.addEventListener("auxclick", function (event) { if (event.button === 1) handle(event, true); }, true);
    // usePreviewBridge: the page's own icon (<link rel="icon">), reported once the document is parsed.
    var reportIcon = function () {
      try {
        var links = D.querySelectorAll ? D.querySelectorAll("link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']") : [];
        var href = links.length > 0 ? links[0].href : "";
        if (!href || !/^(https?:|data:image\/)/i.test(href)) return;
        W.nsh.postMessage(JSON.stringify({ t3: "favicon", page: String(W.location && W.location.href || ""), href: String(href) }));
      } catch (e) {}
    };
    if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", reportIcon); else reportIcon();
  } catch (e) {}
}
