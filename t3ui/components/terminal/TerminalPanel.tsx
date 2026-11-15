import { cleanup, colorScheme, computed, effect, Image, signal, Text, token, untracked, View, WebView } from "nsh";
import { attachResumeFlags, noteAttachAnswered } from "./terminalAttachResume";
import type { WebViewRef } from "nsh";
import { record } from "../../backend/client";
import { sessionScopeState, TERMINAL_OPERATE_SCOPE, TERMINAL_READ_SCOPE } from "../../backend/sessionScopes";
import { terminalStreamMethod } from "./terminalObserve";
import { allProjects, backendStatus, backendUrl, requestBackend, subscribeBackend, threadById } from "../../store";
import { terminalLaunchFields, terminalOpenInput } from "./terminalLaunchEnv";
import { measureInto, nativeViewOccluded, overlayOpen, type PageRect } from "../rightPanel/nativeOcclusion";
import { canvasSnapshotScript, createSnapshotHost } from "../rightPanel/nativeSnapshot";
import { loadTerminalDocument } from "./terminalDocument";
import { takeTerminalInput, takeTerminalLaunch } from "./pendingInput";
import { drawerTypingWanted, setTerminalTypeSink } from "./terminalTyping";
import { clearWebViewFocus, detectNativeWebFocus, holdsWebKeyboard, HOST_FOCUS_PROBE_SCRIPT, nativeWebFocus, noteHostFocusProbe, PAGE_BLUR_IF_UNFOCUSED_SCRIPT, pageBlurredByPress, PAGE_BLUR_SCRIPT, PARKED_WEBVIEW_STYLE, registerWebKeyboard, webViewTookKeyboard } from "./webKeyboard";
import { cssFontFamilies, fontFamilySetting, separateFonts, terminalTextStyle } from "../../typography";
import { terminalRendererFont } from "./terminalLogic";
import { clampGrid, createPostOnce, createResizeGate, createScreenBuffer, createSnapshotGate, type Grid } from "./terminalMessages";
import { createTerminalPageBridge } from "./terminalPageBridge";
import { terminalThemeMessage } from "./terminalTheme";
import { createExitWatcher, noteTerminalSession, terminalSessionGrid, terminalSessionLabel } from "./terminalSessionInfo";
import type { TerminalSelection } from "../composer/terminalContext";
import { trackWebView } from "../rightPanel/webViewMounts";

const resumedThreads = new Set<string>();
type TerminalState = "connecting" | "running" | "exited" | "closed" | "error";
type TerminalMessage = { type: "reset" | "output"; data: string };

/** One terminal session: the Ghostty canvas bound to `terminal.attach` for `terminalId`. The drawer around it owns the chrome. */
export function TerminalPane(props: { threadId: string; terminalId: string; cwd: string; active?: boolean; onFocus?: () => void;
  /** The page reported that its input gained or lost the keyboard focus (terminalFocus). */
  onFocusState?: (focused: boolean) => void;
  /** The page forwarded an app chord ("mod+d") instead of typing it. */
  onChord?: (chord: string) => void;
  /** Keys the app receives while the drawer is meant to have the keyboard are written to this pane while it is active (terminalTyping.ts). */
  forwardTyping?: boolean;
  /** Whether a floating surface covers this web view; a pane inside the right panel ignores the panel's own sheet. */
  occluded?: (own?: PageRect | null) => boolean;
  /** Which surface the pane belongs to (a drawer's state key), so a hidden drawer can tell its WebView holds the keyboard. */
  keyboardGroup?: string;
  /** False while the surface around the pane is hidden (a closed drawer): a WebView holding the keyboard parks instead. */
  shown?: () => boolean;
  /** False while the pane is not on screen (its tab is not in front, its panel is closed, its thread is not the open one). Only its
   * menus read it: the selection menu closes when the pane leaves the screen. Without it `shown` answers. */
  onScreen?: () => boolean;
  /** "Add to chat" of the terminal's menus: puts a selection into the open thread's composer (false: nothing taken). Without it the menus have no such item. */
  onAddToChat?: (selection: TerminalSelection) => boolean;
  /** The session ended by itself (ThreadTerminalDrawer.onSessionExited): the surface closes the terminal, as the web does, instead of offering a restart. */
  onSessionExited?: () => void }) {
  const ownRect = signal<PageRect | null>(null);
  let host: { measure(): Promise<any> } | undefined;
  // A memo: the snapshot host re-requests a still whenever this notifies, so it must notify only when the boolean flips
  // (a second overlay opening while one is already open must not re-snapshot or flash the placeholder).
  const covered = computed(() => (props.occluded ?? nativeViewOccluded)(ownRect()));
  const terminalId = props.terminalId;
  const state = signal<TerminalState>("connecting");
  const error = signal("");
  const document = signal<string | null>(null);
  const restarting = signal(0);
  let view: WebViewRef | undefined;
  let ready = false;
  const pageReady = signal(false);
  // While covered, a still of the Ghostty canvas stands in for the hidden WebView (placeholder until it arrives).
  const snapshot = createSnapshotHost(covered, (token) => { if (ready && view) view.injectJavaScript(canvasSnapshotScript(token)); else throw new Error("not ready"); });
  let attached = false;
  let generation = 0;
  let handledRestart = 0;
  const screen = createScreenBuffer();
  let input = "";
  // What a failed write says when the failure has no message of its own: the web's copy for the mapped keys.
  let inputFailure = "";
  let writing = false;
  let grid: Grid | null = null;
  const snapshotGate = createSnapshotGate();
  let attachedThread = props.threadId;
  // Debounced, and only when the grid really changed: layout passes report the same size over and over.
  const resizeGate = createResizeGate((next) => {
    if (!attached) return;
    const requestGeneration = generation;
    void requestBackend("terminal.resize", { threadId: attachedThread, terminalId, ...next }).catch((cause: unknown) => {
      if (requestGeneration === generation) report(cause);
    });
  });

  function sendTheme() {
    const background = token("terminal-background");
    const foreground = token("terminal-foreground");
    const cursor = token("terminal-cursor");
    const selection = token("terminal-selection-background");
    postOnce("theme", JSON.stringify(terminalThemeMessage({ background, foreground, cursor, selection }, colorScheme())));
  }

  // The renderer rebuilds its font atlas and repaints on every font or theme message, so an unchanged
  // value must not be sent again: settings and tokens notify far more often than they change (each
  // server config event), and re-sending made the terminal flash blank and white every second or so.
  const poster = createPostOnce((payload) => { view?.postMessage(payload); });
  function postOnce(kind: "theme" | "font" | "grid" | "visible", payload: string) {
    if (!ready || !view) return;
    poster.send(kind, payload);
  }

  // terminalTextStyle (the Appearance typography: the Terminal font when fonts are separate, else the code font) reaches the renderer as it changes.
  function sendFont() {
    const message = terminalRendererFont(terminalTextStyle(), cssFontFamilies(fontFamilySetting(separateFonts() ? "terminal" : "code")));
    postOnce("font", JSON.stringify(message));
  }

  cleanup(() => props.onFocusState?.(false));
  // The keyboard hand-back (webKeyboard.ts): the app blurs this page to take typing back, and while the WKWebView is the
  // window's first responder it is parked as a point rather than hidden, which would take every key with it.
  const keyboardGroup = props.keyboardGroup ?? "panel";
  const keyboardId = `${keyboardGroup}:${terminalId}`;
  let pageFocused = false;
  detectNativeWebFocus();
  // A host with the focus fix also moves first responder: blur() hands it back to the app's view (webKeyboard.ts). Only
  // there: the prebuilt host treats a WebView's blur() as "blur every field", which would undo a click into the composer.
  cleanup(registerWebKeyboard(keyboardId, () => { if (ready && view) { view.injectJavaScript(PAGE_BLUR_SCRIPT); if (nativeWebFocus()) view.blur(); } }));
  // Gives this terminal the keyboard: focus() makes its WKWebView first responder where the host carries it out (the
  // prebuilt host ignores it, and the typing forward of terminalTyping.ts stays the fallback); the page focuses its input
  // and answers the probe, which tells whether the host really did it.
  function focusPage() {
    if (!view) return;
    view.focus();
    view.postMessage(JSON.stringify({ type: "focus" }));
    if (ready) view.injectJavaScript(HOST_FOCUS_PROBE_SCRIPT);
  }
  const parked = computed(() => holdsWebKeyboard(keyboardId) && (covered() || !(props.shown?.() ?? true)));
  // Opening the drawer (drawerTypingWanted) hands its active terminal the keyboard, as the reference focuses it.
  effect(() => {
    // `overlayOpen()` beside `covered()`: where WebViews sit under the app's surface nothing is ever covered, and the terminal
    // still waits for an open menu or dialog to close before it takes the keyboard back (on the other host covered() implies it).
    if (!props.forwardTyping || !props.active || !(props.shown?.() ?? true) || !drawerTypingWanted() || !pageReady() || covered() || overlayOpen()) return;
    untracked(focusPage);
  });
  effect(() => { sendTheme(); });
  effect(() => { sendFont(); });

  effect(() => {
    let active = true;
    void loadTerminalDocument().then((html) => {
      if (active) document.set(html);
    }).catch((cause: unknown) => {
      if (active) { state.set("error"); report(cause); }
    });
    return () => { active = false; };
  });

  function display(message: TerminalMessage) {
    screen.note(message);
    if (ready && view) view.postMessage(JSON.stringify(message));
  }

  function report(cause: unknown, fallback = "") {
    error.set(cause instanceof Error ? cause.message : fallback || String(cause));
  }

  // writeSystemMessage: a line of the app's own in the terminal, as the web writes its notices.
  const onScreen = () => (props.onScreen ?? props.shown)?.() ?? true;
  const notice = (text: string) => display({ type: "output", data: `\r\n[terminal] ${text}\r\n` });
  // The page's menus and links (terminalPageBridge.ts): the menus open in the app, at the pointer the page reports.
  const bridge = createTerminalPageBridge({
    terminalId,
    cwd: () => props.cwd,
    post: (message) => { view?.postMessage(JSON.stringify(message)); },
    origin: async () => { const at = await view?.measure(); return at ? { x: at.pagePosition.x, y: at.pagePosition.y } : null; },
    label: () => terminalSessionLabel(props.threadId, terminalId),
    focusPage: () => focusPage(),
    notice,
    onScreen: () => onScreen(),
    ...(props.onAddToChat ? { addToChat: props.onAddToChat } : {}),
  });
  // The reference closes the terminal's menu when its view goes away (clearSelectionAction in the setup cleanups). This pane
  // stays mounted, so its "Add to chat / Copy" menu stayed open over the next tab's toolbar until Escape: it closes when the
  // pane leaves the screen, and when the pane is removed.
  effect(() => { if (!onScreen()) untracked(() => bridge.dismissMenu()); });
  cleanup(() => bridge.dismissMenu());
  // setSharedGrid: the PTY grid the server reports for this terminal is the one every renderer draws.
  function sendGrid() {
    const shared = terminalSessionGrid(props.threadId, terminalId);
    postOnce("grid", JSON.stringify({ type: "grid", cols: shared?.cols ?? null, rows: shared?.rows ?? null }));
  }
  effect(() => { sendGrid(); });
  // setVisible: a hidden drawer's page stops rendering and repaints when shown again. Only the page is told; the WebView itself
  // is mounted, hidden or parked exactly as before (PersistentTerminalDrawers, webKeyboard.ts).
  function sendVisible() { postOnce("visible", JSON.stringify({ type: "visible", visible: props.shown?.() ?? true })); }
  effect(() => { sendVisible(); });
  // synchronizeTerminalStatus: a session that ends writes its notice and, where the surface asks for it, closes the terminal.
  const exitWatcher = createExitWatcher((status) => {
    if (!props.onSessionExited) return;
    notice(status === "closed" ? "Terminal closed" : "Process exited");
    setTimeout(() => { if (exitWatcher.ended) props.onSessionExited?.(); }, 0);
  });
  const syncStatus = (status: string) => exitWatcher.sync(status);

  effect(() => {
    if (!props.forwardTyping || !props.active) return;
    return setTerminalTypeSink((data) => {
      if (!attached || input.length + data.length > 65536) return;
      input += data;
      void flushInput(props.threadId, generation);
    });
  });

  async function flushInput(threadId: string, requestGeneration: number) {
    if (writing || !attached) return;
    writing = true;
    try {
      while (input && attached && requestGeneration === generation) {
        const data = input.slice(0, 65536);
        input = input.slice(data.length);
        await requestBackend("terminal.write", { threadId, terminalId, data });
      }
    } catch (cause) {
      // A failed write may have reached the PTY, so retrying it could run a command twice.
      input = "";
      if (requestGeneration === generation) report(cause, inputFailure);
    } finally {
      writing = false;
      if (input && attached) void flushInput(props.threadId, generation);
    }
  }

  effect(() => {
    const threadId = props.threadId;
    const cwd = props.cwd;
    const connected = backendStatus() === "connected";
    const environment = backendUrl();
    const restart = restarting();
    const explicitRestart = restart !== handledRestart;
    handledRestart = restart;
    const sessionKey = `${environment}\n${threadId}\n${terminalId}`;
    const requestGeneration = ++generation;
    attached = false;
    attachedThread = threadId;
    input = "";
    error.set("");
    // No blank here: a re-attach is answered by a snapshot, which repaints once. Blanking first made every
    // reconnect flash the canvas. Output queued for an unloaded page belongs to the old attach, so it goes.
    if (!ready) screen.clear();
    if (!connected || !threadId || !cwd) {
      state.set("closed");
      return;
    }
    state.set("connecting");
    const { resume, restartIfNotRunning } = attachResumeFlags(sessionKey, explicitRestart);
    const location = untracked(() => {
      const thread = threadById(threadId);
      const project = thread ? allProjects().find((candidate) => candidate.id === thread.projectId) : undefined;
      return terminalLaunchFields({ projectRoot: project?.path, worktreePath: thread?.path });
    });
    const size = { cols: grid?.cols ?? 80, rows: grid?.rows ?? 24 };
    // useThreadTerminalActions.openTerminal: a terminal this view has not attached yet is opened with `terminal.open`
    // (cwd, worktree, runtime env plus a project script's extra env, grid, stopOnSettle), then attached.
    const launch = resume ? null : untracked(() => takeTerminalLaunch(threadId, terminalId));
    const openInput = launch ? terminalOpenInput({ threadId, terminalId, cwd, location, size, launch }) : null;
    let stopAttach: (() => void) | null = null;
    let disposed = false;
    // terminalSessions.ts attachedTerminalSessionFamily: a session without terminal:operate but with terminal:read
    // follows the terminal read-only through `terminal.observe` (same event stream, never opens or writes).
    const observeOnly = untracked(() => terminalStreamMethod(sessionScopeState(TERMINAL_OPERATE_SCOPE), sessionScopeState(TERMINAL_READ_SCOPE)) === "terminal.observe");
    const attach = () => { if (!disposed) stopAttach = subscribeBackend(observeOnly ? "terminal.observe" : "terminal.attach", observeOnly ? { threadId, terminalId } : {
      threadId, terminalId, cwd, ...size, ...(location.worktreePath ? { worktreePath: location.worktreePath } : {}),
      resume, ...(restartIfNotRunning ? { restartIfNotRunning: true } : {}),
    }, (value) => {
      if (requestGeneration !== generation) return;
      const event = record(value);
      if (!event || typeof event.type !== "string") return;
      if (event.type === "snapshot" || event.type === "restarted") {
        const snapshot = record(event.snapshot);
        if (!snapshot || typeof snapshot.history !== "string") return;
        resumedThreads.add(sessionKey);
        noteAttachAnswered(sessionKey);
        noteTerminalSession(threadId, terminalId, snapshot);
        // An observed terminal is read-only: `attached` gates every write and resize.
        attached = !observeOnly && (snapshot.status === "running" || snapshot.status === "starting");
        state.set(snapshot.status === "running" ? "running" : snapshot.status === "starting" ? "connecting" : snapshot.status === "error" ? "error" : "exited");
        if (typeof snapshot.status === "string") syncStatus(snapshot.status);
        // The same history with nothing painted since is already on screen: do not blank and redraw it.
        if (snapshotGate.accept(snapshot.history)) display({ type: "reset", data: snapshot.history });
        // The server session may be new: tell it the grid once per attach.
        resizeGate.forget();
        if (attached) {
          resizeGate.request(grid);
          const queued = takeTerminalInput(threadId, terminalId);
          if (queued) { input += queued; void flushInput(threadId, requestGeneration); }
        }
      } else if (event.type === "output" && typeof event.data === "string") {
        snapshotGate.invalidate();
        display({ type: "output", data: event.data });
      } else if (event.type === "cleared") {
        snapshotGate.invalidate();
        display({ type: "reset", data: "" });
      } else if (event.type === "activity") {
        // The shell's title and whether a subprocess runs, and the shared PTY grid (TerminalActivityEvent).
        noteTerminalSession(threadId, terminalId, event);
      } else if (event.type === "exited" || event.type === "closed") {
        attached = false;
        state.set(event.type);
        syncStatus(event.type);
      } else if (event.type === "error") {
        attached = false;
        state.set("error");
        error.set(typeof event.message === "string" ? event.message : "Terminal failed");
      }
    }, (cause) => {
      if (requestGeneration !== generation) return;
      attached = false;
      state.set("error");
      report(cause);
    }); };
    if (openInput && !observeOnly) {
      void requestBackend("terminal.open", openInput).then(attach, (cause: unknown) => {
        if (requestGeneration !== generation) return;
        state.set("error");
        report(cause instanceof Error ? cause : new Error(String(cause)));
      });
    } else attach();
    const unsubscribe = () => { disposed = true; stopAttach?.(); };
    return () => {
      generation++;
      attached = false;
      input = "";
      resizeGate.cancel();
      unsubscribe();
    };
  });

  function onMessage(data: string) {
    let message: Record<string, unknown> | null;
    try { message = record(JSON.parse(data)); } catch { return; }
    if (!message || typeof message.type !== "string") return;
    if (snapshot.handleMessage(message)) return;
    if (noteHostFocusProbe(message)) return;
    if (message.type === "ready") {
      ready = true;
      pageReady.set(true);
      // A freshly loaded page has neither: send both even if the values are what the last page was given.
      poster.forget();
      snapshotGate.invalidate();
      sendTheme();
      sendFont();
      sendGrid();
      sendVisible();
      // Everything the canvas showed, 1:1: a page that loads again (the host rebuilt the WebView) starts blank, and only the
      // output after it (often a bare prompt redrawn on resize) used to show. The server's snapshot cannot be asked for again
      // without a re-attach, so the pane keeps what it painted (terminalMessages.ts createScreenBuffer).
      const shown = screen.text();
      if (shown) view?.postMessage(JSON.stringify({ type: "reset", data: shown }));
      grid = clampGrid(message.cols, message.rows) ?? grid;
      resizeGate.request(grid);
    } else if (message.type === "input" && typeof message.data === "string" && attached) {
      inputFailure = typeof message.failure === "string" ? message.failure : "";
      if (input.length + message.data.length > 65536) {
        error.set("Terminal input is backed up. Wait for it to finish before typing more.");
        return;
      }
      input += message.data;
      void flushInput(props.threadId, generation);
    } else if (message.type === "resize" && clampGrid(message.cols, message.rows)) {
      grid = clampGrid(message.cols, message.rows);
      resizeGate.request(grid);
    } else if (message.type === "focus-state" && typeof message.focused === "boolean") {
      props.onFocusState?.(message.focused);
      pageFocused = message.focused;
      if (message.focused) { webViewTookKeyboard(keyboardId, keyboardGroup, () => pageFocused); props.onFocus?.(); }
      // A host that moves first responder natively: the page lost the focus because its WKWebView gave the keyboard back
      // (a press on app content), so it holds nothing and none of the prebuilt host's hand-back workarounds applies.
      else if (nativeWebFocus()) clearWebViewFocus(keyboardId);
      // Focus left the page for app content (a field, a button): make that stick, so the keys reach the app. WebKit reports
      // this blur but keeps the element active and refocuses it on the next key, so the keys went on to the shell (VERIFY3 6b).
      // Not guarded by `lifecycle()`: under the test automation the window never read "active", so the guard skipped every
      // hand-back. Cost: after switching to another app and back, the terminal may need a click to type again.
      // A press on the composer only shows up here (webKeyboard.ts pageBlurredByPress): the composer takes the keyboard.
      // Read after the delay: the press can be reported before the pointer move that puts the pointer over the composer.
      else setTimeout(() => { if (!pageFocused) pageBlurredByPress(); if (ready && view) view.injectJavaScript(PAGE_BLUR_IF_UNFOCUSED_SCRIPT); }, 120);
    } else if (message.type === "chord" && typeof message.chord === "string") {
      props.onChord?.(message.chord);
    } else if (bridge.handle(message)) {
      // A menu or link message of the page (terminalPageBridge.ts); open-link, open-path, contextmenu, selection-action, link-check ...
    } else if (message.type === "error") {
      state.set("error");
      attached = false;
      error.set(typeof message.message === "string" ? message.message : "Terminal renderer failed");
    }
  }

  const needsRestart = () => state() === "closed" || state() === "exited" || state() === "error";
  const statusText = () => (state() === "exited" ? "Process exited" : state() === "closed" ? "Terminal closed" : state() === "error" ? "Terminal failed" : "");
  return (
    <View ref={(node: any) => { host = node; }} onLayout={() => measureInto(host, ownRect)} class="min-h-0 min-w-0 flex-1 bg-terminal-background" accessibilityLabel={`Terminal ${terminalId}`} testID={`Terminal pane ${terminalId}`}>
      {needsRestart() || error() ? (
        <View class="h-7 shrink-0 flex-row items-center gap-2 px-3">
          <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{error() || statusText()}</Text>
          {needsRestart() ? (
            <View accessibilityLabel="Restart terminal" role="button" onPress={() => restarting.update((n) => n + 1)} class="rounded-md px-2 py-0.5 hover:bg-accent"><Text class="text-xs text-foreground">Restart</Text></View>
          ) : null}
        </View>
      ) : null}
      {covered() ? (snapshot.image()
        ? <Image src={snapshot.image()!} class="flex-1" style={{ objectFit: "fill" }} testID={`Terminal snapshot ${terminalId}`} />
        : <View class="flex-1 bg-terminal-background" testID={`Terminal occluded ${terminalId}`} />) : null}
      {document() ? <WebView ref={trackWebView<WebViewRef>(`terminal:${keyboardId}`, (node) => { view = node; })} html={document() ?? ""} class={parked() ? "" : covered() ? "hidden" : "flex-1"} style={parked() ? PARKED_WEBVIEW_STYLE : undefined} onPress={() => { props.onFocus?.(); focusPage(); }} onMessage={(event) => onMessage(event.data)} onError={(event) => { state.set("error"); error.set(event.message); }} /> : null}
    </View>
  );
}
