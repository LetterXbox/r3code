// @ts-nocheck -- previewRecording.ts: runs inside the preview page (shipped as text,
// previewRecordingPage.generated.ts), so it is plain JavaScript that reads nothing outside itself. The port of
// desktop/src/preview/RecordingCursor.ts installRecordingCursor: a human cursor (drawn in the page, so page
// snapshots include it; the page's native cursor is hidden) and an agent cursor, both in a `popover="manual"` layer
// kept above dialogs and fullscreen elements. Pointer moves/presses and key presses post
// { t3: "recordingInput", input } (DesktopPreviewRecordingInput: "clear" | key{label,held,width} |
// pointer{phase,x,y,width,height}) while the matching option is on; a sensitive field (recordingKeysAreSensitive,
// duplicated here from recordingInput.ts -- recordingInputParity.test.ts keeps the two copies in step) reports a
// key press with a null label instead of its text.
// NOT ported: the agent cursor's drive from a preview-act path (the port has none yet) and the colour theme beyond
// the ring's primary colour, which arrives pre-resolved as cfg.primary.
export function installPreviewRecording(cfg, env) {
  var W = env.window, D = env.document;
  if (W.__t3record) { W.__t3record.dispose(); }
  var showKeyPresses = cfg.showKeyPresses === true;
  var showMousePresses = cfg.showMousePresses === true;
  var post = function (input) { try { W.nsh && W.nsh.postMessage(JSON.stringify({ t3: "recordingInput", input: input })); } catch (e) {} };

  function recordingKeyLabel(input, isMac) {
    if (input.key === "Dead" || input.key === "Process" || input.key === "Unidentified" || input.key === "") return null;
    var mods = [];
    if (input.ctrlKey || input.key === "Control") mods.push(isMac ? "⌃" : "Ctrl");
    if (input.altKey || input.key === "Alt") mods.push(isMac ? "⌥" : "Alt");
    if (input.shiftKey || input.key === "Shift") mods.push(isMac ? "⇧" : "Shift");
    if (input.metaKey || input.key === "Meta") mods.push(isMac ? "⌘" : "Win");
    var labels = { Enter: "↵", Tab: "⇥", Backspace: "⌫", Delete: "⌦", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", " ": "Space", Space: "Space" };
    if (input.key !== "Control" && input.key !== "Alt" && input.key !== "Shift" && input.key !== "Meta") {
      mods.push(labels[input.key] !== undefined ? labels[input.key] : (input.key.length === 1 ? input.key.toUpperCase() : input.key));
    }
    return mods.join(isMac ? "" : " + ");
  }
  function recordingKeysAreSensitive(doc) {
    var el = doc.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el) return false;
    if (el.tagName === "IFRAME") return true;
    if (el.tagName.indexOf("-") >= 0) return true;
    var type = el.getAttribute ? el.getAttribute("type") : null;
    return !!type && type.toLowerCase() === "password";
  }

  var POPOVER_RESET = "all:initial;margin:0;padding:0;border:0;background:transparent;overflow:visible;inset:auto;animation:none;transition:none;";
  var style = D.createElement("style");
  style.textContent = "html, html * { cursor: none !important; } [data-t3code-recording-cursor]::backdrop, [data-t3code-recording-agent-cursor]::backdrop { display: none !important; }";
  var cursor = D.createElement("div");
  cursor.setAttribute("aria-hidden", "true");
  cursor.setAttribute("data-t3code-recording-cursor", "");
  cursor.popover = "manual";
  cursor.style.cssText = POPOVER_RESET + "position:fixed;left:0;top:0;width:16px;height:24px;pointer-events:none;z-index:2147483647;display:none;";
  cursor.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="24" viewBox="0 0 16 24"><path d="M1 1v18l4-4 4 8 3-1.5-4-8H15Z" fill="black" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  var agentCursor = D.createElement("div");
  agentCursor.setAttribute("aria-hidden", "true");
  agentCursor.setAttribute("data-t3code-recording-agent-cursor", "");
  agentCursor.popover = "manual";
  agentCursor.style.cssText = POPOVER_RESET + "position:fixed;left:0;top:0;width:20px;height:20px;pointer-events:none;z-index:2147483647;display:none;filter:drop-shadow(0 1px 2px #0003);transition:transform 150ms ease-out,opacity 150ms ease-out;";
  agentCursor.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="' + (cfg.primary || "#2563eb") + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:translate(-2px,-2px)"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg>';
  D.documentElement.append(style, cursor, agentCursor);
  var cursors = [cursor, agentCursor];
  var raise = function () {
    for (var i = 0; i < cursors.length; i++) {
      var element = cursors[i];
      if (!element.isConnected || typeof element.showPopover !== "function") continue;
      if (element.matches(":popover-open")) element.hidePopover();
      element.showPopover();
    }
  };
  raise();
  var dialogObserver = new W.MutationObserver(raise);
  dialogObserver.observe(D, { subtree: true, attributes: true, attributeFilter: ["open"] });
  var toggle = function (event) {
    if (cursors.indexOf(event.target) >= 0) return;
    if ("newState" in event && event.newState === "open") raise();
  };
  D.addEventListener("toggle", toggle, true);
  D.addEventListener("fullscreenchange", raise);

  var humanPoint = null;
  var drawHuman = function () {
    if (!humanPoint) return;
    cursor.style.transform = "translate(" + humanPoint.x + "px, " + humanPoint.y + "px)";
    cursor.style.display = "block";
  };
  var lastKeyLabel = null;
  var pointerHeld = false;
  var pointerFrame;
  var pendingPointer;
  var cancelPendingPointer = function () {
    if (pointerFrame !== undefined) W.cancelAnimationFrame(pointerFrame);
    pointerFrame = undefined;
    pendingPointer = undefined;
  };
  var keyPress = function (input, held) {
    if (!showKeyPresses) return;
    var label = recordingKeysAreSensitive(D) ? null : recordingKeyLabel(input, /Mac/.test(W.navigator.platform));
    lastKeyLabel = label;
    post({ type: "key", label: label, held: !!held, width: W.innerWidth });
  };
  var pointer = function (point, phase) {
    if (!showMousePresses || (phase === "move" && !pointerHeld)) return;
    if (phase === "down") pointerHeld = true;
    if (phase === "up") pointerHeld = false;
    var input = { type: "pointer", phase: phase, x: point.x, y: point.y, width: W.innerWidth, height: W.innerHeight };
    if (phase === "move") {
      pendingPointer = input;
      if (pointerFrame === undefined) {
        pointerFrame = W.requestAnimationFrame(function () {
          pointerFrame = undefined;
          if (pendingPointer) post(pendingPointer);
          pendingPointer = undefined;
        });
      }
    } else {
      cancelPendingPointer();
      post(input);
    }
  };
  var moveHuman = function (point) {
    humanPoint = point;
    drawHuman();
  };
  var pointerMove = function (event) {
    if (event.pointerType === "touch") return;
    var point = { x: event.clientX, y: event.clientY };
    moveHuman(point);
    pointer(point, "move");
  };
  var pointerDown = function (event) {
    if (event.pointerType === "touch") return;
    moveHuman({ x: event.clientX, y: event.clientY });
    pointer({ x: event.clientX, y: event.clientY }, "down");
  };
  var pointerUp = function (event) {
    if (event.pointerType !== "touch") pointer({ x: event.clientX, y: event.clientY }, "up");
  };
  var keyDown = function (event) {
    if (event.isComposing || event.repeat) return;
    keyPress(event, true);
  };
  var keyUp = function () {
    if (!showKeyPresses) return;
    post({ type: "key", label: recordingKeysAreSensitive(D) ? null : lastKeyLabel, held: false, width: W.innerWidth });
  };
  var hide = function () {
    cursor.style.display = "none";
    pointerHeld = false;
    cancelPendingPointer();
    if (showKeyPresses || showMousePresses) post({ type: "clear" });
  };
  var leave = function (event) {
    if (event.relatedTarget === null) hide();
  };
  W.addEventListener("pointermove", pointerMove, true);
  W.addEventListener("pointerdown", pointerDown, true);
  W.addEventListener("pointerup", pointerUp, true);
  W.addEventListener("pointercancel", pointerUp, true);
  W.addEventListener("keydown", keyDown, true);
  W.addEventListener("keyup", keyUp, true);
  W.addEventListener("pointerout", leave, true);
  W.addEventListener("blur", hide);

  W.__t3record = {
    dispose: function () {
      W.removeEventListener("pointermove", pointerMove, true);
      W.removeEventListener("pointerdown", pointerDown, true);
      W.removeEventListener("pointerup", pointerUp, true);
      W.removeEventListener("pointercancel", pointerUp, true);
      W.removeEventListener("keydown", keyDown, true);
      W.removeEventListener("keyup", keyUp, true);
      W.removeEventListener("pointerout", leave, true);
      W.removeEventListener("blur", hide);
      dialogObserver.disconnect();
      D.removeEventListener("toggle", toggle, true);
      D.removeEventListener("fullscreenchange", raise);
      cancelPendingPointer();
      cursor.remove();
      agentCursor.remove();
      style.remove();
      delete W.__t3record;
    },
  };
}
