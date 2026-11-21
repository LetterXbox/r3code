// The right panel's own surfaces: a terminal tab (its terminals split side by side or stacked), a
// pull request, the thread's linked pull requests, a side chat and a preview browser
// (RightPanelTabs.tsx's content switch; preview/PreviewPanel.tsx, PreviewChromeRow.tsx, PreviewEmptyState.tsx).
import { colorScheme, computed, effect, openUrl, Scroll, signal, Text, token, untracked, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { Input, Tooltip } from "nsh/base";
import { registerCommand } from "../../commands/registry";
import { allThreads, backendBearer, backendUrl, openThread, openThreadById, requestBackend, settingValue } from "../../store";
import type { PullRequestEntry } from "../../pages/utility-data";
import { HIcon } from "../header/HeaderIcons";
import { IssueDetailPanel } from "../issue/IssueDetailPanel";
import { resolveIssueEnvironmentId } from "../issue/issueStore";
import { pullRequestRowLabel, relationshipRows } from "../header/detailsLogic";
import type { LinkedPullRequest } from "../header/threadRelations";
import { SideChatPane } from "../sideChat/SideChatPane";
import { PRIcon } from "../pullRequest/PRIcon";
import { ThreadPullRequestsPanel } from "../pullRequest/ThreadPullRequestsPanel";
import { openLinkPullRequestDialog } from "../pullRequest/linkPullRequestState";
import { measureInto, panelViewOccluded as nativeViewOccluded, type PageRect } from "./nativeOcclusion";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { createPullRequestDetailModel } from "../pullRequest/pullRequestDetailModel";
import { rememberPanelPullRequestUrl } from "../pullRequest/activePullRequest";
import { rememberedPullRequestTab, rememberPullRequestTab } from "../pullRequest/pullRequestTabMemory";
import { createPullRequestHandoffModel } from "../pullRequest/pullRequestHandoffModel";
import { setComposerDraft } from "../../store";
import { resolveState, toneColor } from "../pullRequest/pullRequestPresentation";
import { closeEndedPanelTerminal, previewFocused, reportTerminalFocus, runTerminalChord } from "../terminal/terminalCommands";
import { addTerminalSelectionToChat } from "../composer/terminalContext";
import { TerminalPane } from "../terminal/TerminalPanel";
import { activatePanelTerminalAction, openPageLinkAction, openPullRequestSurface, setPreviewUrlAction } from "./panelState";
import { OPEN_LINK_SCRIPT, parseFaviconMessage, parseOpenLinkMessage } from "./previewLinks";
import { isNavigationDownload, normalizePreviewUrl, previewChrome } from "./previewLogic";
import { PreviewEmptyState, recordBrowserVisit, recordPageFavicon } from "./previewEmpty";
import { PreviewMoreMenu, ZoomIndicator, zoomScript, nextZoom } from "./previewMore";
import { adjustServerPreview, serverTabSchemeFor, serverTabZoomFor } from "./serverPreviewAdjust";
import { BrowserDeviceToolbar } from "../browser/BrowserDeviceToolbar";
import { DEVICE_TOOLBAR_HEIGHT, deviceViewportArea, framedViewport, responsiveViewportSize, type ViewportSetting } from "../browser/viewportLogic";
import { createViewportResize } from "../browser/BrowserViewportResizeHandles";
import { registerPreviewControls } from "./previewControls";
import { ServerBrowserSurface } from "../browser/ServerBrowserSurface";
import { bridgeAvailable, bridgeMarker, rendersServerTabNatively } from "../browser/desktopBrowserBridge";
import { previewPdfAssetUrl } from "../browser/serverBrowserStream";
import { resolveDiscoveredServerUrl } from "../browser/previewOpeners";
import { defaultTabViewport, defaultTabZoom } from "../browser/browserDefaults";
import { recordTabViewport } from "./previewViewportMemory";
import { alternatePreviewRuntime, isPrimaryEnvironmentEndpoint, moveTabLabel } from "../browser/previewRuntime";
import { serverEnvironmentLabel } from "../banners/serverCaps";
import { environmentSupportsServerBrowser } from "../../store";
import { currentPanelKey, updatePanel } from "./panelState";
import { closeSurface } from "./panelLogic";
import { PreviewUrlNormalizationError, resolveAddressBarInput, resolveSearchUrlTemplate } from "../browser/addressBar";
import { showToast } from "../toast/toastState";
import { createAnnotationVoice, dictationShortcuts, readPickVoice } from "./previewAnnotationSpeech";
import { forwardRecordingInput, handleTabCapture, isTabRecording, parseRecordingInputMessage, recordingCursorScript, recordingInputOptions, registerTabRecordingInjector } from "./previewRecording";
import { forwardedShortcuts, forwardedShortcutsScript, handleForwardedShortcutMessage } from "./previewForwardedShortcuts";
import { annotationTheme, PICK_CAPTURED_SCRIPT, previewPickScript, readPickMessage, submitPickedAnnotation } from "./previewPick";
import { beginServerTabClose, cancelServerTabClose, serverPreviews } from "./serverPreviewSessions";
import { openBrowserAction } from "./panelState";
import { audioScript, isTabMuted, parseAudioMessage, registerTabAudio, reportTabAudible } from "./previewAudio";
import { canOperatePreview, PREVIEW_SCOPE_MESSAGE, previewScopeState } from "./previewScope";
import { PreviewFileNotShown, PreviewUnreachable } from "./previewUnreachable";
export { focusPreviewUrl, previewResetZoom, previewZoomIn, previewZoomOut } from "./previewControls";
import type { Surface } from "./panelLogic";
import { FilePreview } from "../files/FilePreview";
import { AttachmentFileView } from "../files/AttachmentFileView";
import { readThreadAttachment } from "../thread/readAttachment";
import { navigateFolderAction } from "./panelState";
import { PreviewLoadingBar } from "../motion/Motion";
import { trackWebView } from "./webViewMounts";
import { bridgedTabIdFor, registerDesktopTab, reportNativeTab, resizeNativeTab } from "./desktopPreviewSessions";
import { clearNativeCache, clearNativeCookies, nativeDevToolsAvailable, nativeTabSchemeFor, openNativeDevTools, setNativeColorScheme } from "./nativePreviewAdjust";
import { DIcon } from "../device/DeviceIcons";

// --- terminal tab ---------------------------------------------------------------------------

/** `onTerminalExited`: closes a terminal whose session ended; a tab kept mounted for a thread that is not the open one gives its own
 * (RightPanel.tsx), since the default acts on the open thread's panel. */
export function TerminalSurface(props: { surface: Surface; threadId: string; cwd: string; onTerminalExited?: (terminalId: string) => void;
  /** False while the tab is kept mounted but not on screen (another tab in front, the panel closed, another thread open). */
  visible?: () => boolean }) {
  const ids = () => props.surface.terminalIds ?? [];
  return (
    <View class={`min-h-0 w-full min-w-0 flex-1 bg-terminal-background ${props.surface.splitDirection === "vertical" ? "flex-col" : "flex-row"}`} accessibilityLabel="Terminal tab">
      <Each of={ids()} key={(id) => `${props.threadId}:${id}`}>
        {(id) => (
          <View class={`min-h-0 min-w-0 flex-1 ${id() !== (ids()[0] ?? "") ? (props.surface.splitDirection === "vertical" ? "border-t border-border" : "border-l border-border") : ""}`}>
            <TerminalPane
              threadId={props.threadId}
              terminalId={id()}
              cwd={props.cwd}
              active={id() === props.surface.activeTerminalId}
              occluded={nativeViewOccluded}
              onScreen={props.visible}
              onFocus={() => activatePanelTerminalAction(props.surface.id, id())}
              onFocusState={(focused) => reportTerminalFocus({ kind: "panel", surfaceId: props.surface.id, terminalId: id() }, focused)}
              onChord={(chord) => runTerminalChord(chord, { kind: "panel", surfaceId: props.surface.id, terminalId: id() })}
              onAddToChat={addTerminalSelectionToChat}
              onSessionExited={() => { if (props.onTerminalExited) props.onTerminalExited(id()); else void closeEndedPanelTerminal(props.threadId, id()); }}
            />
          </View>
        )}
      </Each>
    </View>
  );
}

// --- file tab -----------------------------------------------------------------------------------

/** A file tab (FilePreviewPanel through RightPanelSurfaceContent): a workspace file with its side explorer, folder trail and
 * unsaved marker, or a chat attachment (`attachment:<id>`) with no workspace behind it. */
export function FileSurface(props: { surface: Surface; cwd: string; projectName: string | null; onOpenFile: (relativePath: string, line?: number) => void; onPendingChange?: (relativePath: string, pending: boolean) => void; request?: (method: string, payload: unknown) => Promise<unknown> }) {
  return props.surface.attachment
    ? <AttachmentFileView attachment={props.surface.attachment} load={(id, options) => readThreadAttachment(props.surface.attachment?.threadId, id, options)} />
    : (
      <FilePreview
        cwd={props.cwd}
        relativePath={props.surface.relativePath ?? ""}
        line={props.surface.line}
        projectName={props.projectName}
        onOpenFile={props.onOpenFile}
        explorer
        folderTrail={props.surface.folderTrail}
        onNavigateFolder={(relativePath, folderTrail, keepSource) => navigateFolderAction(props.surface.id, relativePath, folderTrail, keepSource)}
        onPendingChange={props.onPendingChange}
        {...(props.request ? { request: props.request } : {})}
      />
    );
}

// --- pull requests ----------------------------------------------------------------------------

/** The entry the detail panel reads: what the tab remembers, completed from the thread's linked snapshot. */
export function pullRequestEntryFor(surface: Surface, links: readonly LinkedPullRequest[]): PullRequestEntry {
  const link = links.find((item) => item.number === surface.number && item.repository === surface.repository);
  const snapshot = link?.snapshot ?? null;
  return {
    host: surface.host ?? link?.host ?? "", projectId: surface.projectId ?? "", repository: surface.repository ?? "", number: surface.number ?? 0,
    title: snapshot?.title ?? "", url: surface.url ?? link?.url ?? "", author: "", headBranch: snapshot?.headBranch ?? "", baseBranch: snapshot?.baseBranch ?? "",
    state: snapshot?.state ?? "open", isDraft: snapshot?.isDraft ?? false, updatedAt: "", createdAt: "", additions: snapshot?.additions ?? 0, deletions: snapshot?.deletions ?? 0,
    viewerReviewRequested: false, mergeability: "", checksState: snapshot?.checksState ?? "", reviewDecision: snapshot?.reviewDecision ?? "", provider: "", projectTitle: "", authorAvatarUrl: "", labels: [],
  };
}

export function PullRequestSurface(props: { surface: Surface; onClose: () => void; request?: (method: string, payload: unknown) => Promise<unknown> }) {
  const rpc = props.request ?? requestBackend;
  const entry = () => pullRequestEntryFor(props.surface, openThread()?.relations?.pullRequests ?? []);
  const detail = createPullRequestDetailModel({ request: rpc, entry, http: { endpoint: backendUrl, bearer: backendBearer, fetch }, rememberedTab: { read: () => rememberedPullRequestTab(props.surface.id), write: (tab) => rememberPullRequestTab(props.surface.id, tab) } });
  effect(() => { const url = detail.detail()?.url; if (url) rememberPanelPullRequestUrl(props.surface.id, url); });
  const now = signal(Date.now());
  // composerDraftTarget: beside a thread, Ask / Explain / Fix go into that thread's composer ("Added to the composer").
  const handoff = createPullRequestHandoffModel({
    subject: () => { const current = detail.detail(); return current && openThread() ? { number: current.number, title: current.title, url: current.url, headBranch: current.headBranch, baseBranch: current.baseBranch, provider: current.provider, projectId: entry().projectId } : null; },
    newThread: () => null,
    setDraft: (text) => setComposerDraft(text),
    checkout: async () => false,
    toast: (input) => { showToast(input); },
    attach: () => openThread() !== null,
  });
  return (
    <View class="min-h-0 w-full min-w-0 flex-1 flex-row" accessibilityLabel={`Pull request ${props.surface.number ?? ""}`}>
      <PullRequestDetailPanel entry={entry} model={detail} handoff={handoff} currentThreadId={() => openThread()?.id ?? null} now={() => now()} onClose={props.onClose} onOpenHost={(url) => { if (url) void openUrl(url).catch(() => {}); }} />
    </View>
  );
}

export function PullRequestsSurface(props: { projectId: string | null }) {
  const links = () => openThread()?.relations?.pullRequests ?? [];
  const now = signal(Date.now());
  return (
    <ThreadPullRequestsPanel
      threadId={openThread()?.id ?? ""}
      links={links}
      now={() => now()}
      dispatch={(command) => requestBackend("orchestration.dispatchCommand", { ...command, commandId: `cmd:${crypto.randomUUID()}` })}
      onOpen={(link) => openPullRequestSurface({ projectId: props.projectId ?? "", ...(link.host ? { host: link.host } : {}), repository: link.repository, number: link.number, url: link.url })}
      onLink={() => { const id = openThread()?.id; if (id) openLinkPullRequestDialog(id); }}
      supportsWatch
    />
  );
}

export function IssueSurface(props: { surface: Surface; onClose: () => void; request?: (method: string, payload: unknown) => Promise<unknown> }) {
  const now = signal(Date.now());
  const projectId = props.surface.projectId ?? openThread()?.projectId ?? "";
  const environmentId = resolveIssueEnvironmentId(projectId);
  return (
    <View class="min-h-0 w-full min-w-0 flex-1 flex-row" accessibilityLabel={`Issue ${props.surface.key ?? ""}`}>
      <IssueDetailPanel
        environmentId={environmentId}
        reference={{
          projectId,
          tracker: props.surface.tracker ?? "github",
          host: props.surface.host ?? "",
          scope: props.surface.scope ?? "",
          key: props.surface.key ?? "",
        }}
        now={() => now()}
        closeInTabStrip
        onClose={props.onClose}
        onOpenHost={(url) => { if (url) void openUrl(url).catch(() => {}); }}
        onOpenPullRequest={(pr) => openPullRequestSurface({ projectId, ...(props.surface.host ? { host: props.surface.host } : {}), repository: pr.repository, number: pr.number, url: pr.url })}
        currentThreadId={() => openThread()?.id ?? null}
        currentThreadLinkedIds={() => openThread()?.relations?.issues ?? []}
        {...(props.request ? { request: props.request } : {})}
      />
    </View>
  );
}

// --- side chat --------------------------------------------------------------------------------

/** SideChatPane.tsx: the tab's own header (title, Bring back, Delete, Close) over the side chat's chat. */
export function SideChatSurface(props: { surface: Surface; onClose?: () => void }) {
  return <Each of={props.surface.threadId ? [props.surface.threadId] : []} key={(id) => id}>{(id) => <SideChatPane threadId={id()} onClose={props.onClose} />}</Each>;
}

function SideChatTip(props: { text: string }) {
  return <Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}

export function sideChatsOf(threadId: string | null) {
  const current = threadId ? allThreads().find((thread) => thread.id === threadId) : undefined;
  if (!current) return [];
  return relationshipRows({ id: current.id, lineage: current.relations?.lineage }, allThreads().map((thread) => ({ id: thread.id, title: thread.title, lineage: thread.relations?.lineage }))).sideChats;
}

// --- preview browser ----------------------------------------------------------------------------

/** PreviewPanel.tsx: no page without the preview operate scope, and the reason once the session says it is missing. */
/** `current`: false while the tab is kept mounted for a thread that is not the open one (RightPanel.tsx); its page lives on, hidden. */
export interface PreviewFloat {
  /** This tab is shown as the floating card over the chat right now (RightPanel.tsx lays it out there): no toolbar, the page only. */
  floating: () => boolean;
  /** The page is drawn at this share of its size in the panel while it floats (the reference fits the source page into the card). */
  scale: () => number;
  /** This tab is the thread's floating tab (it floats whenever the panel does not show it). */
  pinned: () => boolean;
  /** "Float preview over chat" / "Close floating preview". */
  onToggle: () => void;
  /** The page's size while it shows in the panel: what the floating card keeps the proportions of. */
  onPageSize: (size: { width: number; height: number }) => void;
}

export function PreviewSurface(props: { surface: Surface; active?: () => boolean; current?: () => boolean; float?: PreviewFloat }) {
  // A memo: read inline, the branch re-ran on every new surface object (a new address) and made a second WebView.
  const serverTabId = computed(() => props.surface.serverTabId ?? null);
  return (
    <View class="min-h-0 w-full min-w-0 flex-1">
      {/* Plain props, not a spread: each is read where the page uses it, not where this branch is made. */}
      {previewScopeState() === "granted" && serverTabId() ? <ServerPreviewPage tabId={serverTabId()!} float={props.float} /> : null}
      {previewScopeState() === "granted" && !serverTabId() ? <PreviewPage surface={props.surface} active={props.active} current={props.current} float={props.float} /> : null}
      {previewScopeState() === "denied" ? (
        <View class="min-h-0 flex-1 items-center justify-center gap-3 p-8" accessibilityLabel="Preview access needed">
          <Text class="max-w-sm text-center text-sm text-muted-foreground">{PREVIEW_SCOPE_MESSAGE}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A server-hosted tab (runtime "server"): its stream, hidden while something covers it. */
function ServerPreviewPage(props: { tabId: string; float?: PreviewFloat }) {
  const ownRect = signal<PageRect | null>(null);
  let host: { measure(): Promise<any> } | undefined;
  const threadId = computed(() => Object.entries(serverPreviews()).find(([, state]) => state.sessions[props.tabId] !== undefined)?.[0] ?? null);
  const pdfUrl = computed(() => { const id = threadId(); const nav = id ? serverPreviews()[id]?.sessions[props.tabId]?.navStatus : undefined; return nav?._tag === "Success" ? previewPdfAssetUrl(nav.url, backendUrl() || null) : null; });
  // rendersServerTabNatively: a boolean memo, so the page is made again only when the tab moves between native and streamed.
  const native = computed(() => { const id = threadId(); return rendersServerTabNatively({ available: bridgeAvailable(), primary: isPrimaryEnvironmentEndpoint(backendUrl()), snapshot: id ? serverPreviews()[id]?.sessions[props.tabId] : null }); });
  // PreviewView.tsx chrome row of a server tab: its address, and the More menu's "Open on this computer" (handleMoveTab
  // with runtime "desktop": the tab opens in this computer's browser at the address resolved for it, and the server
  // tab closes).
  const pageUrl = computed(() => { const id = threadId(); const nav = id ? serverPreviews()[id]?.sessions[props.tabId]?.navStatus : undefined; return nav && nav._tag !== "Idle" ? String(nav.url ?? "") : ""; });
  const moveTarget = computed(() => alternatePreviewRuntime({ primary: isPrimaryEnvironmentEndpoint(backendUrl()), serverBrowser: environmentSupportsServerBrowser(), runtime: "server" }));
  async function moveToThisComputer() {
    const id = threadId();
    if (!id || moveTarget() !== "desktop") return;
    try {
      openBrowserAction(pageUrl() ? resolveDiscoveredServerUrl(backendUrl(), pageUrl()) : undefined);
      beginServerTabClose(id, props.tabId);
      await requestBackend("preview.close", { threadId: id, tabId: props.tabId });
    } catch (cause) {
      cancelServerTabClose(id, props.tabId);
      showToast({ type: "error", title: "Unable to move the browser tab", description: cause instanceof Error ? cause.message : "An error occurred." });
    }
  }
  return (
    <View ref={(node: any) => { host = node; }} onLayout={() => measureInto(host, ownRect)} class="min-h-0 w-full min-w-0 flex-1" accessibilityLabel="Browser">
      <View class={props.float?.floating() ? "hidden" : "h-10 shrink-0 flex-row items-center gap-1 border-b border-border px-2"} accessibilityLabel="Browser controls">
        <Text class="min-w-0 flex-1 truncate text-sm text-muted-foreground">{pageUrl()}</Text>
        {/* PreviewView.tsx adjustServerTab: zoom and hard reload go to the server's browser (preview.adjust). */}
        <PreviewMoreMenu enabled={threadId() !== null} zoom={() => serverTabZoomFor(props.tabId)}
          onHardReload={() => { const id = threadId(); if (id) void adjustServerPreview(id, props.tabId, { hardReload: true }); }}
          onZoom={(direction) => { const id = threadId(); const next = nextZoom(serverTabZoomFor(props.tabId), direction); if (id && next !== serverTabZoomFor(props.tabId)) void adjustServerPreview(id, props.tabId, { zoomFactor: next }); }}
          move={moveTarget() ? { label: moveTabLabel("desktop", serverEnvironmentLabel()), onMove: () => void moveToThisComputer() } : undefined}
          colorScheme={() => serverTabSchemeFor(props.tabId)}
          onColorScheme={(colorScheme) => { const id = threadId(); if (id) void adjustServerPreview(id, props.tabId, { colorScheme }); }}
          onClearCookies={() => { const id = threadId(); if (id) void adjustServerPreview(id, props.tabId, { clear: "cookies" }); }}
          onClearCache={() => { const id = threadId(); if (id) void adjustServerPreview(id, props.tabId, { clear: "cache" }); }} />
      </View>
      {threadId() && !native() ? <ServerBrowserSurface threadId={threadId()!} tabId={props.tabId} visible={() => true} hidden={() => nativeViewOccluded(ownRect())} pdfUrl={pdfUrl} followSize={() => !props.float?.floating()} /> : null}
      {threadId() && native() ? <BridgedServerPage threadId={threadId()!} tabId={props.tabId} hidden={() => nativeViewOccluded(ownRect())} /> : null}
    </View>
  );
}

/** A primary-environment server tab drawn natively (desktopBrowserBridge.ts): the server drives this WebView over CDP. Its
 * first address is the session's; later navigation is the server's (or the page's), so `src` never changes. */
function BridgedServerPage(props: { threadId: string; tabId: string; hidden: () => boolean }) {
  const initial = untracked(() => { const nav = serverPreviews()[props.threadId]?.sessions[props.tabId]?.navStatus; return nav && nav._tag !== "Idle" ? nav.url : "about:blank"; });
  return (
    <WebView
      src={initial}
      class={props.hidden() ? "hidden" : "min-h-0 flex-1"}
      onPress={() => previewFocused.set(true)}
      injectedJavaScriptBeforeContentLoaded={bridgeMarker(props.threadId, props.tabId)}
    />
  );
}

function PreviewPage(props: { surface: Surface; active?: (() => boolean) | undefined; current?: (() => boolean) | undefined; float?: PreviewFloat | undefined }) {
  const view = signal<WebViewRef | null>(null);
  // Made once: written inline, the ref expression read the surface and ran again (a second ref call) with every new address.
  const viewRef = trackWebView<WebViewRef>(`preview:${untracked(() => props.surface.id)}`, (node) => view.set(node));
  // The page rectangle of this browser, so a toast or tooltip occludes it only when it overlaps.
  const ownRect = signal<PageRect | null>(null);
  let host: { measure(): Promise<any> } | undefined;
  const occluded = () => nativeViewOccluded(ownRect());
  const nav = signal({ url: "", loading: false, canGoBack: false, canGoForward: false });
  const draft = signal<string | null>(null);
  const failure = signal("");
  const failureCode = signal<string | undefined>(undefined);
  // PreviewView.tsx:1062: a navigation that downloaded a file instead of rendering shows PreviewFileNotShown.
  const download = signal<{ url: string; fileName: string } | null>(null);
  let urlInput: { focus(): void; blur?(): void; setSelection?(start: number, end?: number): void } | undefined;
  const url = () => props.surface.previewUrl ?? "";
  // A boolean memo: the page region below is made again only when the tab gains or loses its page, never when the address
  // changes. Read as `url() === ""` it ran again on every new address and made a new WebView (a reload that lost the
  // history, scroll and form input); now a new address is the `src` of the same one, which navigates it.
  const hasPage = computed(() => url() !== "");
  // Tabs of different threads share ids (browser:1): only the open thread's page owns the tab's audio controls.
  const current = computed(() => props.current?.() ?? true);
  const chrome = () => previewChrome({ url: nav().url || url(), loading: nav().loading, canGoBack: nav().canGoBack, canGoForward: nav().canGoForward, hasPage: url() !== "" });
  // A new address for the same WebView: the address field shows it at once. The page's own events correct it after a
  // load or redirect, but a move inside the same document (a new hash) reports none, and the field kept the old address.
  effect(() => { const next = url(); failure.set(""); download.set(null); untracked(() => { if (nav().url !== "" && nav().url !== next) nav.set({ ...nav(), url: next }); }); });
  // preview.refresh (mod+r while the browser has the focus): only the tab in front answers.
  registerCommand("preview.refresh", () => { if (props.active && !props.active()) return false; if (url() === "") return false; if (!canOperatePreview()) return true; view()?.reload(); });
  // handleSubmitUrl (PreviewView.tsx): words search with Settings > Browser's engine; a bad address says why.
  function submit() {
    const input = draft() ?? "";
    draft.set(null);
    // PreviewChromeRow.tsx:180-188: a submitted address leaves the field (the page takes over).
    try { openUrl_(resolveAddressBarInput(input, resolveSearchUrlTemplate(settingValue("browserSearchEngine"), settingValue("browserCustomSearchUrl")))); urlInput?.blur?.(); }
    catch (cause) {
      showToast({ type: "error", title: "Could not open this address", description: cause instanceof PreviewUrlNormalizationError ? "Enter an http or https URL." : cause instanceof Error ? cause.message : "An error occurred." });
    }
  }
  function openUrl_(next: string) {
    recordBrowserVisit(next);
    setPreviewUrlAction(props.surface.id, next);
  }
  // PreviewChromeRow.tsx:191: the address field's "Open in system browser" addon shows while the pointer is over the field
  // (`group-hover/address`) and the field is not being edited, fading in over 150ms.
  const addressHover = signal(false);
  // The device toolbar: a viewport of its own size for the page (browser/viewportLogic.ts).
  // browserDefaults.ts: a new tab starts at the saved default viewport and zoom (Settings > Browser).
  // PreviewView.tsx handleMoveTab: on a remote environment with a browser of its own, this computer's tab moves there
  // (preview.open with runtime "server"; the server tab then shows through serverPreviewSync) and this one closes.
  const moveTarget = computed(() => alternatePreviewRuntime({ primary: isPrimaryEnvironmentEndpoint(backendUrl()), serverBrowser: environmentSupportsServerBrowser(), runtime: "desktop" }));
  // threadEnvironmentLabel/remoteOpen.runtime.ts's own fallback: a thread with no environmentId is the primary (local) one.
  const environmentId = () => openThread()?.environmentId ?? "primary";
  const nativeSurfaceKey = () => `${pageThreadId}\u0000${props.surface.id}`;
  async function moveTab() {
    const threadId = openThread()?.id;
    if (!moveTarget() || !threadId) return;
    try {
      // preview.open through desktopPreviewSessions.ts (the server-integration agent's helper), runtime "server".
      await registerDesktopTab({ threadId, url: url(), runtime: "server" });
      const key = currentPanelKey();
      if (key) updatePanel(key, (state) => closeSurface(state, props.surface.id));
    } catch (cause) {
      showToast({ type: "error", title: "Unable to move the browser tab", description: cause instanceof Error ? cause.message : "An error occurred." });
    }
  }
  // A reopened tab comes back at the viewport it was closed with (reopenClosedView.ts:122-140).
  const viewport = signal<ViewportSetting>(untracked(() => props.surface.viewport ?? defaultTabViewport()));
  effect(() => recordTabViewport(props.surface.id, viewport()));
  // ElectronBrowserHost desktop tab (desktopPreviewSessions.ts): the native page is a desktop-runtime preview session the
  // agent's preview tools list; its navigation is reported and a device-toolbar viewport committed with preview.resize.
  const contractViewport = (v: ViewportSetting) => (v.kind === "fill" ? { _tag: "fill" } : { ...v, _tag: v.kind, kind: undefined });
  // The page belongs to the thread open when it was made (pages of other threads are kept mounted behind it).
  const pageThreadId = untracked(() => openThread()?.id ?? null);
  effect(() => {
    const threadId = pageThreadId;
    const state = nav();
    const failed = failure();
    if (!threadId || !canOperatePreview()) return;
    const address = state.url || url();
    untracked(() => reportNativeTab(`${threadId}\u0000${props.surface.id}`, threadId, {
      kind: !address ? "Idle" : failed ? "LoadFailed" : state.loading ? "Loading" : "Success",
      url: address, title: String((state as { title?: unknown }).title ?? ""), canGoBack: state.canGoBack, canGoForward: state.canGoForward,
      ...(failed ? { code: Number(failureCode() ?? 0) || 0, description: failed } : {}),
    }, contractViewport(viewport()), undefined, undefined, props.surface.profileId));
  });
  // Desktop browser bridge: once this tab is a server-runtime session (desktopPreviewSessions.ts), its WebView carries
  // the marker that binds it to that server tab, and the server drives it (host patch 0014).
  const bridgeScript = computed(() => { const tabId = pageThreadId ? bridgedTabIdFor(`${pageThreadId}\u0000${props.surface.id}`) : null; return tabId && pageThreadId ? `\n${bridgeMarker(pageThreadId, tabId)}` : ""; });
  let lastViewport = "";
  effect(() => { const next = JSON.stringify(contractViewport(viewport())); if (lastViewport && next !== lastViewport) untracked(() => resizeNativeTab(`${pageThreadId}\u0000${props.surface.id}`, JSON.parse(next))); lastViewport = next; });
  const ratio = signal<number | null>(null);
  // useBrowserViewportResize: the rails around a sized page; a drag or arrow keys commit a freeform size.
  const deviceRoom = () => { const room = ownRect(); return room ? deviceViewportArea({ width: room.width, height: room.height - 40 }) : { width: 1, height: 1 }; };
  const resize = createViewportResize({ setting: () => viewport(), ratio: () => ratio(), available: deviceRoom, onCommit: (size) => viewport.set({ kind: "freeform", ...size }) });
  function toggleToolbar() {
    if (viewport().kind !== "fill") { viewport.set({ kind: "fill" }); ratio.set(null); return; }
    // browserResponsiveViewportForToggle: the saved default unless it is fill, else a panel-sized freeform (fallback 1024x768).
    const saved = defaultTabViewport();
    if (saved.kind !== "fill") { viewport.set(saved); return; }
    // resolveResponsiveBrowserViewportSize: the room under the 40pt chrome row, inside the rails, clamped like a resize.
    const room = ownRect();
    viewport.set({ kind: "freeform", ...responsiveViewportSize(room ? { width: room.width, height: room.height - 40 } : { width: 1024 + 20, height: 768 + DEVICE_TOOLBAR_HEIGHT + 10 }, zoom()) });
  }
  // The floating card (ThreadPreviewMiniPlayer.tsx): the page alone, fitted to the card.
  const floating = computed(() => props.float?.floating() ?? false);
  const pageScale = () => (floating() ? props.float?.scale() ?? 1 : 1);
  // resolveBrowserDeviceViewportLayout: the page sits in the room under the toolbar, inside the side and bottom rails.
  const framed = () => { const room = ownRect(); return room && !floating() ? framedViewport(resize.effective(), deviceRoom()) : null; };
  // Where the framed page is in this view: centred (self-center), under the 40 pt chrome row and the device toolbar.
  const frameBox = () => { const room = ownRect(); const frame = framed(); return { x: room && frame ? (room.width - frame.width) / 2 : 0, y: 40 + DEVICE_TOOLBAR_HEIGHT, width: frame?.width ?? 0, height: frame?.height ?? 0 }; };
  const zoom = signal(untracked(defaultTabZoom));
  function setZoom(next: number) {
    zoom.set(next);
    // The WebView API has no page zoom; the page's own zoom property is the nearest thing.
    view()?.injectJavaScript(zoomScript(next * untracked(pageScale)));
  }
  // A floating page is the page at its size in the panel, drawn smaller: the card's share of that size multiplies the zoom.
  effect(() => { const scale = pageScale(); const node = view(); untracked(() => node?.injectJavaScript(zoomScript(zoom() * scale))); });
  // The page's size in the panel (the toolbar row above it is 40pt), reported while it shows there.
  effect(() => {
    const room = ownRect();
    if (!room || floating() || !(props.active?.() ?? true)) return;
    const height = room.height - 40 - (viewport().kind !== "fill" ? DEVICE_TOOLBAR_HEIGHT : 0);
    if (room.width > 0 && height > 0) props.float?.onPageSize({ width: room.width, height });
  });
  // A new address in the same WebView may be the same document (a new hash), which keeps the zoom the page was given: reset both.
  // The tab keeps its zoom across addresses (HostedBrowserWebview applies the tab's zoom factor); a new document gets it again on load.
  effect(() => { void url(); untracked(() => view())?.injectJavaScript(zoomScript(untracked(zoom) * untracked(pageScale))); });
  // The tab's sound: its speaker button and "Mute tab" reach the page through script (previewAudio.ts).
  effect(() => {
    if (!hasPage() || view() === null || !current()) return;
    return registerTabAudio(props.surface.id, (muted) => view()?.injectJavaScript(audioScript(muted)));
  });
  // The recording cursor (previewRecording.ts startTabRecording / stopTabRecording): installed on record start,
  // torn down on stop; re-installed on every load (RecordingCursor.ts's dom-ready restore -- a new document loses it).
  effect(() => {
    if (!hasPage() || view() === null || !current()) return;
    return registerTabRecordingInjector(props.surface.id, (script) => view()?.injectJavaScript(script));
  });
  // preview.focusUrl / preview.zoomIn / zoomOut / resetZoom reach this tab through previewControls.ts.
  effect(() => registerPreviewControls({
    focusUrl: () => urlInput?.focus(),
    zoomBy: (direction) => { if (url() !== "") setZoom(nextZoom(zoom(), direction)); },
    isActive: () => props.active?.() ?? true,
  }));
  // "Annotate preview" (PreviewChromeRow.tsx): a pick runs in the page until a click or Escape (previewPick.ts).
  const pickActive = signal(false);
  // PreviewAnnotationSpeech: dictation in the page's annotation editor, on the composer's pipeline.
  const annotationVoice = createAnnotationVoice((script) => view()?.injectJavaScript(script));
  // setForwardedShortcuts: the page keeps the current chords (bindings, history, terminal open can change them).
  effect(() => { const script = forwardedShortcutsScript(forwardedShortcuts()); untracked(() => view()?.injectJavaScript(script)); });
  function togglePick() { if (url() === "") return; if (pickActive()) annotationVoice.cancel(); view()?.injectJavaScript(previewPickScript({ sendEnabled: true, theme: annotationTheme(), voice: annotationVoice.available(), voiceShortcuts: dictationShortcuts().keys, voiceShortcutLabel: dictationShortcuts().label })); pickActive.set(!pickActive()); }
  effect(() => { void url(); untracked(() => pickActive.set(false)); });
  const button = (label: string, icon: string, disabled: boolean, onPress: () => void) => (
    <View role="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} class={`size-6 items-center justify-center rounded-md ${disabled ? "opacity-40" : "hover:bg-accent"}`}>
      <HIcon name={icon} size={14} />
    </View>
  );
  return (
    <View ref={(node: any) => { host = node; }} onLayout={() => measureInto(host, ownRect)} class="min-h-0 w-full min-w-0 flex-1" accessibilityLabel="Browser">
      <View class={floating() ? "hidden" : "mb-3 h-7 min-h-7 shrink-0 flex-row items-center gap-1 bg-background px-2"}>
        <PreviewLoadingBar loading={() => chrome().loading} />
        <View class="flex-row items-center gap-0.5" role="group" accessibilityLabel="Navigation">
          {button("Back", "arrow-left", !chrome().canGoBack, () => view()?.goBack())}
          {button("Forward", "arrow-right", !chrome().canGoForward, () => view()?.goForward())}
          {button(chrome().loading ? "Stop" : "Refresh", chrome().loading ? "square" : "rotate-cw", url() === "", () => (chrome().loading ? view()?.stopLoading() : view()?.reload()))}
        </View>
        <View class="h-7 min-w-0 flex-1 flex-row items-center" onMouseEnter={() => addressHover.set(true)} onMouseLeave={() => addressHover.set(false)} testID="Preview address field">
        <Input
          ref={(node: any) => { urlInput = node; }}
          accessibilityLabel="Search or enter URL"
          placeholder="Search or enter URL"
          value={draft() ?? chrome().address}
          onFocus={() => { previewFocused.set(true); const address = chrome().address; draft.set(address); setTimeout(() => urlInput?.setSelection?.(0, address.length), 0); }}
          onBlur={() => { previewFocused.set(false); draft.set(null); }}
          onChange={(event) => draft.set(event.value)}
          onSubmit={submit}
          onKeyPress={(event) => { if (event.key === "Escape") { draft.set(null); urlInput?.blur?.(); } }}
          class="h-7 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-sm text-foreground"
        />
        {url() !== "" && draft() === null ? (
          <View class="transition-opacity" style={{ opacity: addressHover() ? 1 : 0, pointerEvents: addressHover() ? "auto" : "none" }}>
            {button("Open in system browser", "external-link", false, () => void openUrl(chrome().address).catch(() => {}))}
          </View>
        ) : null}
        </View>
        {props.float ? (
          // PreviewChromeRow.tsx: Button size icon-xs, secondary and primary-tinted while this tab is the floating one.
          <View
            role="button"
            accessibilityLabel={props.float.pinned() ? "Close floating preview" : "Float preview over chat"}
            accessibilityState={{ selected: props.float.pinned(), disabled: url() === "" || !!failure() }}
            disabled={url() === "" || !!failure()}
            tooltip={<Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.float.pinned() ? "Close floating preview" : "Float preview over chat"}</Text></Tooltip>}
            onPress={props.float.onToggle}
            class={`size-6 shrink-0 items-center justify-center rounded-md ${url() === "" || failure() ? "opacity-64" : props.float.pinned() ? "bg-secondary" : "hover:bg-accent"}`}
          >
            <DIcon name="picture-in-picture-2" size={14} {...(props.float.pinned() ? { tint: String(token("primary")) } : {})} />
          </View>
        ) : null}
        <View
          role="button"
          accessibilityLabel={pickActive() ? "Cancel annotation" : "Annotate preview"}
          accessibilityState={{ selected: pickActive(), disabled: url() === "" || !!failure() }}
          disabled={url() === "" || !!failure()}
          tooltip={<Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{failure() && !download() ? "Page didn't load. Pick is unavailable until the page renders" : pickActive() ? "Cancel annotation (Esc)" : "Annotate elements, regions, and drawings"}</Text></Tooltip>}
          onPress={togglePick}
          class={`size-6 shrink-0 items-center justify-center rounded-md ${url() === "" || failure() ? "opacity-64" : pickActive() ? "bg-secondary" : "hover:bg-accent"}`}
        >
          <DIcon name="mouse-pointer-click" size={14} {...(pickActive() ? { tint: String(token("primary")) } : {})} />
        </View>
        {/* PreviewChromeRow.tsx:239-262: the capture button: screenshot, Shift+press records, press again stops. */}
        <View
          role="button"
          accessibilityLabel={isTabRecording(props.surface.id) ? "Stop recording" : "Capture screenshot"}
          disabled={url() === "" || !!failure()}
          tooltip={<Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{isTabRecording(props.surface.id) ? "Stop recording" : "Screenshot \u00b7 Shift-click to record"}</Text></Tooltip>}
          onPress={(event: { modifiers?: { shift?: boolean } }) => { const r = untracked(ownRect); handleTabCapture(props.surface.id, event?.modifiers?.shift === true, r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null); }}
          class={`relative size-6 shrink-0 items-center justify-center rounded-md ${url() === "" || failure() ? "opacity-64" : isTabRecording(props.surface.id) ? "bg-secondary" : "hover:bg-accent"}`}
        >
          <DIcon name="camera" size={14} {...(isTabRecording(props.surface.id) ? { tint: String(token("destructive")) } : {})} />
          {isTabRecording(props.surface.id) ? <View class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-destructive" /> : null}
        </View>
        <PreviewMoreMenu move={moveTarget() ? { label: moveTabLabel(moveTarget()!, serverEnvironmentLabel()), onMove: () => void moveTab() } : undefined} enabled={url() !== ""} zoom={zoom} deviceToolbar={viewport().kind !== "fill"} onToggleDeviceToolbar={toggleToolbar} onHardReload={() => view()?.reload()} onZoom={(direction) => setZoom(nextZoom(zoom(), direction))}
          colorScheme={() => nativeTabSchemeFor(nativeSurfaceKey())}
          onColorScheme={(scheme) => void setNativeColorScheme(nativeSurfaceKey(), environmentId(), props.surface.profileId, scheme)}
          onClearCookies={() => void clearNativeCookies(environmentId(), props.surface.profileId)}
          onClearCache={() => void clearNativeCache(environmentId(), props.surface.profileId)}
          devToolsAvailable={nativeDevToolsAvailable}
          onOpenDevTools={() => void openNativeDevTools()} />
      </View>
      {url() !== "" && viewport().kind !== "fill" && !floating() ? <BrowserDeviceToolbar setting={() => viewport() as Exclude<ViewportSetting, { kind: "fill" }>} ratio={ratio} width={() => ownRect()?.width ?? 1000} onChange={(next, nextRatio) => { viewport.set(next); ratio.set(nextRatio); }} onClose={() => { viewport.set({ kind: "fill" }); ratio.set(null); }} /> : null}
      {!hasPage() ? (
        <PreviewEmptyState onOpenUrl={(next) => openUrl_(resolveDiscoveredServerUrl(backendUrl(), next))} />
      ) : (
        <>
          {failure() && !download() ? <PreviewUnreachable move={moveTarget() ? { label: moveTabLabel(moveTarget()!, serverEnvironmentLabel()), onMove: () => void moveTab() } : undefined} url={url()} description={failure()} code={failureCode()} onReload={() => { failure.set(""); view()?.reload(); }} /> : null}
          {download() ? <PreviewFileNotShown url={download()!.url} fileName={download()!.fileName} onOpen={() => void openUrl(download()!.url).catch(() => {})} /> : null}
          {occluded() && !failure() && !download() ? <View class="min-h-0 flex-1 bg-background" accessibilityLabel="Browser page hidden behind an open menu" testID="Browser occluded" /> : null}
          <ZoomIndicator zoom={zoom} />
          <WebView
            ref={viewRef}
            src={url()}
            class={occluded() || failure() || download() ? "hidden" : framed() ? "self-center" : "min-h-0 flex-1"}
            style={framed() ? { width: framed()!.width, height: framed()!.height } : undefined}
            onPress={() => previewFocused.set(true)}
            injectedJavaScriptBeforeContentLoaded={`${audioScript(isTabMuted(props.surface.id))}\n${OPEN_LINK_SCRIPT}${bridgeScript()}\n${forwardedShortcutsScript(untracked(() => forwardedShortcuts()))}`}
            onMessage={(event) => { if (handleForwardedShortcutMessage(event.data)) return; const icon = parseFaviconMessage(event.data); if (icon) { recordPageFavicon(icon.page, icon.href); return; } const link = parseOpenLinkMessage(event.data); if (link) { if (canOperatePreview()) openPageLinkAction(link.url, link.background); return; } const voice = readPickVoice(event.data); if (voice) { annotationVoice.handle(voice); return; } const picked = readPickMessage(event.data); if (picked !== null) { pickActive.set(false); if (picked !== "cancelled") { const r = untracked(ownRect); void submitPickedAnnotation(picked, r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null, { captured: () => view()?.injectJavaScript(PICK_CAPTURED_SCRIPT) }); } return; } const audible = parseAudioMessage(event.data); if (audible !== null && current()) { reportTabAudible(props.surface.id, audible); return; } const recordingInput = parseRecordingInputMessage(event.data); if (recordingInput !== null) void forwardRecordingInput(props.surface.id, recordingInput); }}
            onLoadStart={(event) => { failure.set(""); download.set(null); reportTabAudible(props.surface.id, false); nav.set({ ...event }); }}
            onLoad={(event) => { nav.set({ ...event }); // Recents belong to the open thread's project: a kept page of another thread that reloads records nothing.
              if (event.url && current()) recordBrowserVisit(event.url, event.title); if (pageScale() !== 1 || zoom() !== 1) view()?.injectJavaScript(zoomScript(zoom() * pageScale())); if (isTabRecording(props.surface.id)) view()?.injectJavaScript(recordingCursorScript(recordingInputOptions(), String(token("primary")))); }}
            onNavigationStateChange={(event) => nav.set({ ...event })}
            onError={(event) => { failureCode.set(event.code); failure.set(event.message); }}
            // Only a navigation that turned into the download (the tab's own address, nothing rendered: the reference's
            // LoadFailed-with-download) replaces the page; an in-page download (a Download button, <a download>) leaves it.
            onDownload={(event) => { if (event.state === "started" && isNavigationDownload(event.url, [url(), untracked(nav).url])) download.set({ url: event.url, fileName: event.filename }); }}
          />
          {framed() && !failure() && !download() && (props.active?.() ?? true) ? <resize.Handles frame={frameBox} /> : null}
        </>
      )}
    </View>
  );
}
