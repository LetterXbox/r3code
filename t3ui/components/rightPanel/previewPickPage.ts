// @ts-nocheck -- previewPick.ts: runs inside the preview page (shipped as text, previewPickPage.generated.ts), so it is
// plain JavaScript that reads nothing outside itself. The port of desktop/src/preview/PickPreload.ts startAnnotation:
// a toolbar (Select / Region / Draw / Erase, keys V R D E), hover outline, selected elements with labels (Shift adds),
// marquee regions that select the elements inside or mark a region, freehand strokes, Erase, and the annotation editor
// beside the targets: "Describe the change…" and Attach (Enter attaches, Cmd/Ctrl+Enter sends when allowed, Escape
// cancels). It posts { t3: "pick", annotation, submission } (PreviewAnnotationPayload) or { t3: "pick", cancelled: true }.
// NOT ported: the expanded style editor, voice input, the PDF input layer, React component/source lookup.
export function installPreviewPick(cfg, env) {
  var W = env.window, D = env.document;
  if (W.__t3pick) { W.__t3pick.teardown(true); return; }
  var ATTR = "data-t3code-annotation-ui";
  var theme = cfg.theme || {};
  var PRIMARY = theme.primary || "#2563eb";
  var PRIMARY_FILL = theme.primaryFill || "rgba(37,99,235,.10)";
  var REGION_FILL = theme.regionFill || "rgba(37,99,235,.06)";
  var sendEnabled = cfg.sendEnabled === true;
  var post = function (m) { m.t3 = "pick"; try { W.nsh && W.nsh.postMessage(JSON.stringify(m)); } catch (e) {} };
  var counter = 0;
  var nextId = function (kind) { counter += 1; return kind + "-" + Date.now().toString(36) + "-" + counter; };
  var finished = false;

  var host = D.createElement("div");
  host.setAttribute(ATTR, "");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
  var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
  var css = D.createElement("style");
  css.textContent = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:" + (theme.fontSans || "-apple-system,BlinkMacSystemFont,system-ui,sans-serif") + "}",
    ".bar{pointer-events:auto;position:fixed;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:2px;padding:4px;border-radius:10px;border:1px solid " + (theme.border || "rgba(0,0,0,.08)") + ";background:" + (theme.popover || "#fff") + ";color:" + (theme.popoverForeground || "#222") + ";box-shadow:0 10px 15px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);z-index:10}",
    "button{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 8px;border-radius:8px;font-size:12px;font-weight:500;color:inherit;white-space:nowrap}",
    "button:hover{background:" + (theme.accent || "rgba(0,0,0,.04)") + "}",
    ".bar button{height:32px;padding:0 10px;font-size:14px}",
    ".bar button.on{background:" + PRIMARY_FILL + ";color:" + PRIMARY + "}",
    ".editor{pointer-events:auto;position:fixed;display:none;flex-direction:column;width:min(360px,calc(100vw - 16px));border-radius:14px;border:1px solid " + (theme.border || "rgba(0,0,0,.08)") + ";background:" + (theme.popover || "#fff") + ";color:" + (theme.popoverForeground || "#222") + ";box-shadow:0 25px 50px -12px rgba(0,0,0,.25);z-index:10;overflow:hidden}",
    ".row{display:flex;align-items:flex-start;gap:8px;padding:8px}",
    "textarea{all:unset;flex:1;min-width:0;min-height:32px;max-height:96px;padding:6px 0;font-size:14px;line-height:20px;white-space:pre-wrap;overflow-y:hidden;border-bottom:1px solid transparent;color:" + (theme.foreground || "#222") + "}",
    "textarea:focus{border-bottom-color:" + PRIMARY + "}",
    "textarea::placeholder{color:" + (theme.mutedForeground || "#888") + "}",
    ".attach{height:32px;padding:0 12px;background:" + PRIMARY + ";color:" + (theme.primaryForeground || "#fff") + ";border:1px solid " + PRIMARY + ";box-shadow:0 1px 2px rgba(0,0,0,.05)}",
    ".attach:hover{background:" + PRIMARY + ";opacity:.9}",
    ".attach[disabled]{opacity:.45;pointer-events:none}",
    ".icon{width:32px;height:32px;padding:0;flex-shrink:0;color:" + (theme.mutedForeground || "#888") + "}",
    ".vrow{display:flex;align-items:center;gap:4px;padding:0 8px 8px}",
    ".vstatus{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-size:14px;color:" + (theme.mutedForeground || "#888") + "}",
    ".wave{display:none;flex:1;min-width:0;height:20px;align-items:center;justify-content:space-between;gap:1px;overflow:hidden}",
    ".wbar{display:block;height:100%;width:2px;flex-shrink:0;border-radius:9999px;background:" + PRIMARY + ";transform-origin:center}",
    ".velapsed{display:none;flex-shrink:0;font-size:12px;font-variant-numeric:tabular-nums;color:" + (theme.mutedForeground || "#888") + "}",
    ".vpreview{margin:0;padding:0 8px 8px;font-size:14px;color:" + (theme.mutedForeground || "#888") + "}",
    ".box{position:fixed;left:0;top:0;pointer-events:none;border:2px solid " + PRIMARY + ";border-radius:3px;display:none;z-index:1}",
    ".label{position:fixed;left:0;top:0;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px;border-radius:6px;background:" + PRIMARY + ";color:" + (theme.primaryForeground || "#fff") + ";padding:4px 8px;font-size:12px;font-weight:600;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);z-index:1}",
  ].join("\n");
  root.appendChild(css);
  var cursorStyle = D.createElement("style");
  cursorStyle.setAttribute(ATTR, "");
  cursorStyle.textContent = "html[data-t3code-annotation-tool] body, html[data-t3code-annotation-tool] body * { cursor: crosshair !important; }";
  D.documentElement.appendChild(cursorStyle);

  var createBox = function (fill) { var n = D.createElement("div"); n.className = "box"; n.style.background = fill; root.appendChild(n); return n; };
  var positionBox = function (node, rect) {
    if (rect.width <= 0 || rect.height <= 0) { node.style.display = "none"; return; }
    node.style.display = "block";
    node.style.transform = "translate(" + rect.x + "px, " + rect.y + "px)";
    node.style.width = rect.width + "px"; node.style.height = rect.height + "px";
  };
  var hoverOutline = createBox(PRIMARY_FILL);
  var marqueeBox = createBox(PRIMARY_FILL);
  var SVGNS = "http://www.w3.org/2000/svg";
  var svg = D.createElementNS ? D.createElementNS(SVGNS, "svg") : D.createElement("svg");
  svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
  svg.style.cssText = "position:fixed;inset:0;overflow:visible;pointer-events:none;z-index:1";
  root.appendChild(svg);

  var toolbar = D.createElement("div"); toolbar.className = "bar"; toolbar.setAttribute(ATTR, ""); root.appendChild(toolbar);
  var editor = D.createElement("div"); editor.className = "editor"; editor.setAttribute(ATTR, ""); root.appendChild(editor);
  var row = D.createElement("div"); row.className = "row"; editor.appendChild(row);
  var comment = D.createElement("textarea");
  comment.placeholder = "Describe the change…"; comment.setAttribute("dir", "auto"); comment.rows = 1;
  comment.setAttribute("aria-label", "Describe the change");
  row.appendChild(comment);
  var submit = D.createElement("button");
  submit.type = "button"; submit.className = "attach"; submit.textContent = "Attach";
  submit.title = sendEnabled ? "Attach annotation and screenshot (Enter). Send with Cmd/Ctrl+Enter." : "Attach annotation and screenshot (Enter)";
  row.appendChild(submit);
  // PickPreload.ts voice input (PreviewAnnotationSpeech.tsx): the mic button, and while dictating a row with Cancel, the
  // status and Finish, plus the live transcript. Recording and transcription stay in the app (cfg.voice): the page only
  // forwards the gestures with the draft, { t3: "pick", voice: action, text, cursor, selectionEnd }, and mirrors the
  // state the app sends back (W.__t3pick.voiceState).
  var voiceOn = cfg.voice === true, voicePhase = "idle";
  var voiceButton = D.createElement("button"); voiceButton.type = "button"; voiceButton.className = "icon";
  voiceButton.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>';
  voiceButton.setAttribute("aria-label", "Start voice input"); voiceButton.title = "Start voice input";
  voiceButton.style.display = "none";
  row.insertBefore ? row.insertBefore(voiceButton, submit) : row.appendChild(voiceButton);
  var voiceRow = D.createElement("div"); voiceRow.className = "vrow"; voiceRow.style.display = "none"; editor.appendChild(voiceRow);
  var voiceCancel = D.createElement("button"); voiceCancel.type = "button"; voiceCancel.className = "icon"; voiceCancel.setAttribute("aria-label", "Cancel voice input"); voiceCancel.title = "Cancel voice input";
  voiceCancel.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var voiceStatus = D.createElement("span"); voiceStatus.className = "vstatus"; voiceStatus.setAttribute("role", "status");
  // The waveform (24 bars of the microphone's level, newest at the end) and the elapsed time, while recording.
  var waveform = D.createElement("span"); waveform.className = "wave"; waveform.setAttribute("aria-hidden", "true");
  var levels = [], bars = [];
  for (var bi = 0; bi < 24; bi += 1) { levels.push(0); var bar = D.createElement("span"); bar.className = "wbar"; bar.style.transform = "scaleY(0.08)"; bar.style.opacity = "0.25"; waveform.appendChild(bar); bars.push(bar); }
  var voiceElapsed = D.createElement("span"); voiceElapsed.className = "velapsed";
  var recordingStartedAt = 0, elapsedTimer = null;
  var updateElapsed = function () { var sec = Math.floor((Date.now() - recordingStartedAt) / 1000); voiceElapsed.textContent = Math.floor(sec / 60) + ":" + (sec % 60 < 10 ? "0" : "") + (sec % 60); };
  var pushLevel = function (level) { levels.shift(); levels.push(Math.max(0, Math.min(1, level || 0))); for (var i = 0; i < bars.length; i += 1) { bars[i].style.transform = "scaleY(" + Math.max(0.08, levels[i]) + ")"; bars[i].style.opacity = levels[i] > 0.02 ? "1" : "0.25"; } };
  // The dictation shortcut (composer.dictation, cfg.voiceShortcuts like "mod+shift+d") toggles voice input in the comment.
  var shortcuts = Array.isArray(cfg.voiceShortcuts) ? cfg.voiceShortcuts : [];
  var isMac = /Mac|iPhone|iPad/.test(String((W.navigator && W.navigator.platform) || ""));
  var matchesShortcut = function (e) {
    return shortcuts.some(function (spec) {
      var parts = String(spec).toLowerCase().split("+"), key = parts.pop(), want = { meta: false, ctrl: false, alt: false, shift: false };
      parts.forEach(function (p) { if (p === "mod") { if (isMac) want.meta = true; else want.ctrl = true; } else if (p === "cmd" || p === "meta") want.meta = true; else if (p === "ctrl" || p === "control") want.ctrl = true; else if (p === "alt" || p === "option") want.alt = true; else if (p === "shift") want.shift = true; });
      return String(e.key || "").toLowerCase() === key && !!e.metaKey === want.meta && !!e.ctrlKey === want.ctrl && !!e.altKey === want.alt && !!e.shiftKey === want.shift;
    });
  };
  var voiceFinish = D.createElement("button"); voiceFinish.type = "button"; voiceFinish.className = "attach"; voiceFinish.setAttribute("aria-label", "Finish voice input"); voiceFinish.title = "Finish voice input"; voiceFinish.textContent = "Done";
  voiceRow.appendChild(voiceCancel); voiceRow.appendChild(voiceStatus); voiceRow.appendChild(waveform); voiceRow.appendChild(voiceElapsed); voiceRow.appendChild(voiceFinish);
  if (shortcuts.length > 0 && cfg.voiceShortcutLabel) voiceButton.title = "Start voice input (" + cfg.voiceShortcutLabel + ")";
  var voicePreview = D.createElement("p"); voicePreview.className = "vpreview"; voicePreview.setAttribute("role", "status"); voicePreview.style.display = "none"; editor.appendChild(voicePreview);
  var sendVoice = function (action) {
    if (!voiceOn || finished) return;
    post({ voice: action, text: String(comment.value || ""), cursor: comment.selectionStart == null ? String(comment.value || "").length : comment.selectionStart, selectionEnd: comment.selectionEnd == null ? null : comment.selectionEnd });
  };
  voiceButton.addEventListener("click", function () { sendVoice(voicePhase === "recording" ? "stop" : "start"); });
  voiceCancel.addEventListener("click", function () { sendVoice("cancel"); });
  voiceFinish.addEventListener("click", function () { sendVoice("stop"); });
  var applyVoiceState = function (state) {
    if (!state) return;
    var wasRecording = voicePhase === "recording";
    voicePhase = state.phase || "idle";
    var recording = voicePhase === "recording";
    if (recording && !wasRecording) { recordingStartedAt = Date.now(); updateElapsed(); elapsedTimer = W.setInterval ? W.setInterval(updateElapsed, 1000) : null; }
    if (!recording && wasRecording && elapsedTimer !== null) { W.clearInterval(elapsedTimer); elapsedTimer = null; }
    waveform.style.display = recording ? "flex" : "none"; voiceElapsed.style.display = recording ? "inline" : "none";
    if (recording && typeof state.level === "number") pushLevel(state.level);
    voiceButton.style.display = voiceOn && state.available !== false ? "inline-flex" : "none";
    var active = voicePhase === "preparing" || voicePhase === "recording" || voicePhase === "transcribing";
    voiceRow.style.display = active ? "flex" : "none";
    voiceStatus.textContent = state.status || "";
    voicePreview.textContent = state.preview || "";
    voicePreview.style.display = state.preview ? "block" : "none";
    if (typeof state.text === "string") {
      comment.value = state.text;
      var at = typeof state.cursor === "number" ? Math.min(state.cursor, state.text.length) : state.text.length;
      try { comment.setSelectionRange(at, at); } catch (e) {}
      resize();
    }
    comment.readOnly = active;
    if (active) submit.setAttribute("disabled", ""); else if (hasTargets()) submit.removeAttribute("disabled");
  };
  if (voiceOn) voiceButton.style.display = "inline-flex";

  var selected = [];
  var regions = [];
  var strokes = [];
  var tool = "select";
  var dragStart = null;
  var activeStroke = null;
  var editorWasShown = false;

  var isAnnotationNode = function (el) { return !!el && (el === host || (el.closest && el.closest("[" + ATTR + "]") !== null)); };
  var pickFromPoint = function (x, y) {
    var list = D.elementsFromPoint ? D.elementsFromPoint(x, y) : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (isAnnotationNode(c) || c === D.documentElement || c === D.body) continue;
      return c;
    }
    return null;
  };
  var rectOf = function (el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
  var describe = function (el) {
    var tag = el.tagName.toLowerCase(), id = el.id ? "#" + el.id : "";
    var classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(function (n) { return "." + n; }).join("") : "";
    return tag + id + classes;
  };
  var normalizeRect = function (sx, sy, ex, ey) { return { x: Math.min(sx, ex), y: Math.min(sy, ey), width: Math.abs(ex - sx), height: Math.abs(ey - sy) }; };
  var unionRects = function (rects, padding) {
    if (rects.length === 0) return null;
    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    rects.forEach(function (x) { l = Math.min(l, x.x); t = Math.min(t, x.y); r = Math.max(r, x.x + x.width); b = Math.max(b, x.y + x.height); });
    return { x: l - padding, y: t - padding, width: r - l + padding * 2, height: b - t + padding * 2 };
  };
  var strokeBounds = function (points, width) {
    var xs = points.map(function (p) { return p.x; }), ys = points.map(function (p) { return p.y; });
    var half = width / 2;
    var l = Math.min.apply(null, xs) - half, t = Math.min.apply(null, ys) - half;
    return { x: l, y: t, width: Math.max.apply(null, xs) + half - l, height: Math.max.apply(null, ys) + half - t };
  };
  var pathFromPoints = function (points) { return points.map(function (p, i) { return (i === 0 ? "M" : "L") + p.x + " " + p.y; }).join(" "); };

  var updateSelectedVisual = function (target) {
    var rect = rectOf(target.element);
    positionBox(target.outline, rect);
    if (rect.width === 0 || rect.height === 0) { target.label.style.display = "none"; return; }
    target.label.textContent = describe(target.element);
    target.label.style.display = "block";
    target.label.style.transform = "translate(" + Math.max(4, rect.x) + "px, " + Math.max(4, rect.y - 22) + "px)";
  };
  var findSelected = function (el) { for (var i = 0; i < selected.length; i++) if (selected[i].element === el) return selected[i]; return null; };
  var removeSelected = function (target) {
    selected = selected.filter(function (t) { return t !== target; });
    target.outline.remove(); target.label.remove();
  };
  var addSelected = function (el) {
    if (findSelected(el)) return;
    var label = D.createElement("div"); label.className = "label"; root.appendChild(label);
    var target = { id: nextId("element"), element: el, outline: createBox(PRIMARY_FILL), label: label };
    selected.push(target);
    updateSelectedVisual(target);
  };
  var toggleSelected = function (el, additive) {
    var existing = findSelected(el);
    if (existing) removeSelected(existing);
    else {
      if (!additive) selected.slice().forEach(removeSelected);
      addSelected(el);
    }
    updateStatus();
  };

  var bounds = function () {
    return unionRects(selected.map(function (t) { return rectOf(t.element); }).filter(function (r) { return r.width > 0 && r.height > 0; })
      .concat(regions.map(function (r) { return r.rect; })).concat(strokes.map(function (s) { return s.bounds; })), 0);
  };
  var positionEditor = function () {
    var b = bounds();
    if (!b) return;
    var er = editor.getBoundingClientRect(), gap = 8, vw = W.innerWidth, vh = W.innerHeight;
    var candidates = [
      { left: b.x + b.width + gap, top: b.y },
      { left: b.x - er.width - gap, top: b.y },
      { left: b.x + b.width - er.width, top: b.y + b.height + gap },
      { left: b.x + b.width - er.width, top: b.y - er.height - gap },
    ];
    var overflow = function (p) { return Math.max(0, -p.left) + Math.max(0, -p.top) + Math.max(0, p.left + er.width - vw) + Math.max(0, p.top + er.height - vh); };
    var best = candidates.reduce(function (cur, c) { return overflow(c) < overflow(cur) ? c : cur; });
    var m = 8;
    editor.style.left = Math.min(Math.max(m, best.left), Math.max(m, vw - er.width - m)) + "px";
    editor.style.top = Math.min(Math.max(m, best.top), Math.max(m, vh - er.height - m)) + "px";
  };
  var hasTargets = function () { return selected.length > 0 || regions.length > 0 || strokes.length > 0; };
  var updateStatus = function () {
    var any = hasTargets();
    editor.style.display = any ? "flex" : "none";
    if (any) submit.removeAttribute("disabled"); else submit.setAttribute("disabled", "");
    if (any) positionEditor();
    if (any && !editorWasShown) { editorWasShown = true; W.setTimeout(function () { try { comment.focus({ preventScroll: true }); } catch (e) {} }, 0); }
  };

  var toolButtons = {};
  [["select", "Select", "Select elements (V)"], ["marquee", "Region", "Draw a region or marquee-select elements (R)"], ["draw", "Draw", "Draw freehand (D)"], ["erase", "Erase", "Remove an annotation target (E)"]].forEach(function (t) {
    var b = D.createElement("button"); b.type = "button"; b.textContent = t[1]; b.title = t[2]; b.setAttribute("aria-label", t[1]);
    b.addEventListener("click", function () { tool = t[0]; refreshTools(); });
    toolButtons[t[0]] = b; toolbar.appendChild(b);
  });
  var refreshTools = function () {
    Object.keys(toolButtons).forEach(function (k) { if (k === tool) toolButtons[k].classList.add("on"); else toolButtons[k].classList.remove("on"); });
    if (tool !== "select") hoverOutline.style.display = "none";
    if (tool !== "marquee") marqueeBox.style.display = "none";
    D.documentElement.setAttribute("data-t3code-annotation-tool", tool);
  };

  var selectElementsInRect = function (rect) {
    var all = Array.prototype.slice.call(D.querySelectorAll("body *"));
    var found = all.filter(function (el) { return !isAnnotationNode(el); }).map(function (el) { return { element: el, rect: el.getBoundingClientRect() }; })
      .filter(function (c) {
        var r = c.rect;
        if (r.width < 2 || r.height < 2) return false;
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height &&
          (c.element.children.length === 0 || c.element.tagName === "BUTTON" || c.element.tagName === "A" || c.element.getAttribute("role") === "button");
      })
      .sort(function (a, b) { return a.rect.width * a.rect.height - b.rect.width * b.rect.height; }).slice(0, 20);
    found.forEach(function (c) { addSelected(c.element); });
    return found.length;
  };
  var removeTargetAtPoint = function (x, y) {
    for (var i = selected.length - 1; i >= 0; i--) {
      var r = selected[i].element.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { removeSelected(selected[i]); updateStatus(); return; }
    }
    var inside = function (rect) { return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height; };
    for (var j = 0; j < regions.length; j++) if (inside(regions[j].rect)) { regions[j].box.remove(); regions.splice(j, 1); updateStatus(); return; }
    for (var k = 0; k < strokes.length; k++) if (inside(strokes[k].bounds)) { strokes[k].path.remove(); strokes.splice(k, 1); updateStatus(); return; }
  };

  var inOverlay = function (e) { return e.composedPath ? e.composedPath().indexOf(host) >= 0 : isAnnotationNode(e.target); };
  var onPointerMove = function (e) {
    if (inOverlay(e)) { hoverOutline.style.display = "none"; return; }
    if (tool === "select" && dragStart === null) {
      var t = pickFromPoint(e.clientX, e.clientY);
      if (t) positionBox(hoverOutline, rectOf(t)); else hoverOutline.style.display = "none";
      return;
    }
    hoverOutline.style.display = "none";
    if (tool === "marquee" && dragStart) { positionBox(marqueeBox, normalizeRect(dragStart.x, dragStart.y, e.clientX, e.clientY)); return; }
    if (tool === "draw" && activeStroke) {
      activeStroke.points.push({ x: e.clientX, y: e.clientY });
      activeStroke.bounds = strokeBounds(activeStroke.points, activeStroke.width);
      activeStroke.path.setAttribute("d", pathFromPoints(activeStroke.points));
    }
  };
  var onPointerDown = function (e) {
    if (e.button !== 0 || inOverlay(e)) return;
    e.preventDefault(); e.stopPropagation();
    lastPointerDown = Date.now();
    if (tool === "select") { var t = pickFromPoint(e.clientX, e.clientY); if (t) toggleSelected(t, e.shiftKey); return; }
    if (tool === "erase") { removeTargetAtPoint(e.clientX, e.clientY); return; }
    dragStart = { x: e.clientX, y: e.clientY };
    if (tool === "draw") {
      var path = D.createElementNS ? D.createElementNS(SVGNS, "path") : D.createElement("path");
      path.setAttribute("fill", "none"); path.setAttribute("stroke", PRIMARY); path.setAttribute("stroke-width", "4");
      path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      activeStroke = { id: nextId("stroke"), color: PRIMARY, width: 4, points: [dragStart], bounds: { x: dragStart.x, y: dragStart.y, width: 1, height: 1 }, path: path };
    }
  };
  var onPointerUp = function (e) {
    if (!dragStart) return;
    e.preventDefault(); e.stopPropagation();
    if (tool === "marquee") {
      var rect = normalizeRect(dragStart.x, dragStart.y, e.clientX, e.clientY);
      marqueeBox.style.display = "none";
      if (rect.width >= 3 && rect.height >= 3 && selectElementsInRect(rect) === 0) {
        var box = createBox(REGION_FILL); positionBox(box, rect);
        regions.push({ id: nextId("region"), rect: rect, box: box });
      }
    } else if (tool === "draw" && activeStroke) {
      if (activeStroke.points.length > 1) strokes.push(activeStroke); else activeStroke.path.remove();
      activeStroke = null;
    }
    dragStart = null;
    updateStatus();
  };
  // A click with no pointer press before it is an accessibility or keyboard activation (VoiceOver, AXPress): it selects the
  // element as a pointer press would, so the layer works without a mouse. A mouse press already selected on pointerdown.
  var lastPointerDown = 0;
  var onClick = function (e) {
    if (inOverlay(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (tool === "select" && Date.now() - lastPointerDown > 1000 && e.target && e.target.nodeType === 1 && e.target !== D.body && e.target !== D.documentElement) toggleSelected(e.target, e.shiftKey);
  };
  var repaint = function () { selected.forEach(updateSelectedVisual); if (hasTargets()) positionEditor(); };

  var teardown = function (notify) {
    if (finished) return;
    finished = true;
    W.removeEventListener("pointermove", onPointerMove, true);
    W.removeEventListener("pointerdown", onPointerDown, true);
    W.removeEventListener("pointerup", onPointerUp, true);
    W.removeEventListener("click", onClick, true);
    W.removeEventListener("keydown", onKeyDown, true);
    W.removeEventListener("scroll", repaint, true);
    W.removeEventListener("resize", repaint);
    D.documentElement.removeAttribute("data-t3code-annotation-tool");
    cursorStyle.remove(); host.remove();
    W.__t3pick = null;
    if (elapsedTimer !== null && W.clearInterval) W.clearInterval(elapsedTimer);
    if (voiceOn && voicePhase !== "idle" && voicePhase !== "error") post({ voice: "cancel", text: "", cursor: 0, selectionEnd: null });
    if (notify) post({ cancelled: true });
  };
  var onKeyDown = function (e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); teardown(true); return; }
    if (inOverlay(e)) return;
    if (e.key === "v") tool = "select"; else if (e.key === "r") tool = "marquee"; else if (e.key === "d") tool = "draw"; else if (e.key === "e") tool = "erase"; else return;
    refreshTools();
  };
  var captureElement = function (el) {
    return { pageUrl: String(W.location.href), pageTitle: (D.title || "").trim() || null, tagName: el.tagName.toLowerCase(), selector: null,
      htmlPreview: String(el.outerHTML || "").slice(0, 500), componentName: null, source: null, stack: [], styles: "", pickedAt: new Date().toISOString() };
  };
  var submitAnnotation = function (submission) {
    if (submission === "send" && !sendEnabled) return;
    if (!hasTargets()) return;
    var annotation = {
      id: nextId("annotation"), pageUrl: String(W.location.href), pageTitle: (D.title || "").trim() || null, comment: comment.value.trim(),
      elements: selected.map(function (t) { return { id: t.id, element: captureElement(t.element), rect: rectOf(t.element) }; }),
      regions: regions.map(function (r) { return { id: r.id, rect: r.rect }; }),
      strokes: strokes.map(function (s) { return { id: s.id, color: s.color, width: s.width, points: s.points, bounds: s.bounds }; }),
      styleChanges: [], screenshot: null, createdAt: new Date().toISOString(),
    };
    // PickPreload.ts submitAnnotation: the editor, toolbar and hover outline hide, the marks stay on the page for the
    // host's capture (webview.capture), cropped to the union of the targets padded by 20 px (unionRects) and clipped to
    // the viewport; the host's { t3pick: "captured" } (or a 5 s guard) then tears the layer down.
    editor.style.display = "none"; toolbar.style.display = "none"; hoverOutline.style.display = "none";
    var rects = [].concat(annotation.elements.map(function (t) { return t.rect; }), annotation.regions.map(function (r) { return r.rect; }), annotation.strokes.map(function (s) { return s.bounds; }));
    var screenshotRect = null;
    if (rects.length > 0) {
      var left = Math.min.apply(null, rects.map(function (r) { return r.x; })) - 20, top = Math.min.apply(null, rects.map(function (r) { return r.y; })) - 20;
      var right = Math.max.apply(null, rects.map(function (r) { return r.x + r.width; })) + 20, bottom = Math.max.apply(null, rects.map(function (r) { return r.y + r.height; })) + 20;
      var vw = W.innerWidth || 0, vh = W.innerHeight || 0;
      var x0 = Math.max(0, left), y0 = Math.max(0, top), x1 = vw > 0 ? Math.min(vw, right) : right, y1 = vh > 0 ? Math.min(vh, bottom) : bottom;
      if (x1 > x0 && y1 > y0) screenshotRect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    W.__t3pick.captured = function () { teardown(false); };
    W.setTimeout(function () { teardown(false); }, 5000);
    post({ annotation: annotation, submission: submission, screenshotRect: screenshotRect });
  };
  var resize = function () { comment.style.height = "auto"; comment.style.height = Math.min(comment.scrollHeight || 32, 96) + "px"; comment.style.overflowY = (comment.scrollHeight || 0) > 96 ? "auto" : "hidden"; positionEditor(); };
  comment.addEventListener("input", resize);
  submit.addEventListener("click", function () { submitAnnotation("attach"); });
  editor.addEventListener("keydown", function (e) {
    if (voiceOn && e.target === comment && matchesShortcut(e)) { e.preventDefault(); e.stopPropagation(); sendVoice(voicePhase === "recording" ? "stop" : "start"); return; }
    // resolveAnnotationSubmission: Enter attaches; Cmd/Ctrl+Enter sends when allowed; Shift+Enter is a new line.
    if (e.target === comment && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      var submission = e.metaKey || e.ctrlKey ? (sendEnabled ? "send" : null) : "attach";
      e.stopPropagation();
      if (!submission) return;
      e.preventDefault();
      submitAnnotation(submission);
      return;
    }
    if (e.key !== "Escape") e.stopPropagation();
  });

  W.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  W.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
  W.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
  W.addEventListener("click", onClick, { capture: true, passive: false });
  W.addEventListener("keydown", onKeyDown, { capture: true });
  W.addEventListener("scroll", repaint, { capture: true, passive: true });
  W.addEventListener("resize", repaint, { passive: true });
  D.documentElement.appendChild(host);
  refreshTools();
  updateStatus();
  W.__t3pick = { teardown: teardown, comment: comment, submit: submitAnnotation, toggle: toggleSelected, voiceState: applyVoiceState };
}
