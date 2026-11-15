// DevicePanel.tsx / DeviceWorkspace.tsx / DeviceToolsPanel.tsx: the right panel's Device surface. The list of simulators and
// emulators over every device host, open/start, a booted device's video (MJPEG in a WebView) and its settings.
// Touch, keys and Home/Back/Recents/Rotate go over the hub's input socket from inside the stream's WebView page (deviceInput.ts).
// The 3D phone (3D / Flat / Restore 3D view, Magic Keyboard, Duo stances) runs the reference viewer in its own page
// (DevicePhoneView.tsx, deviceViewer.ts); Android fold is DeviceAndroidFoldControls.tsx.
import { computed, effect, signal, Text, untracked, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { backendBearer, backendUrl, requestBackend } from "../../store";
import { SettingsButton, SettingsSwitch } from "../SettingsLayout";
import { Scroll } from "nsh";
import { measureInto, panelViewOccluded, type PageRect } from "../rightPanel/nativeOcclusion";
import { DIcon } from "./DeviceIcons";
import { DeviceLoadingView } from "./DeviceLoadingView";
import {
  deviceHubReadiness, deviceKey, discoveryWarningText, emptyListMessage, groupDevices, hostDiagnostics, hostUpdateDetail, loadingMessage, needsSetup,
  platformGroupLabel, showsAndroidHint, type DeviceServiceState, type DeviceSummary,
} from "./deviceLogic";
import { deviceAction, deviceClose, deviceDetail, deviceList, deviceOpen, errorMessage, watchDeviceState, type DeviceRequest } from "./deviceState";
import { DeviceSetupDialog } from "./DeviceSetup";
import { hubHttpBase, mintMediaTicket, mjpegUrl, streamPage, type DeviceHubAccess } from "./deviceStream";
import { AX_POLL_INTERVAL_MS, captureDeviceScreenshot, deviceScreenshotFileName, appendDeviceEventLog, eventLogUrl, fetchDeviceAxTree, foregroundUrl, readEventLogMessage, readForegroundMessage, type DeviceEventLogEntry } from "./deviceHubApi";
import { deviceInputScript, inputSocketUrl, type DevicePageCommand } from "./deviceInput";
import { DeviceToolsPanel, type DeviceActBody } from "./DeviceToolsPanel";
import { Menu, MenuItem } from "nsh/base";
import { trackOpenChange, useOverlayOpen, webViewsUnderSurface } from "../rightPanel/nativeOcclusion";
import type { Surface } from "../rightPanel/panelLogic";
import { closeRightPanelAction } from "../rightPanel/panelState";
import { writeFile } from "fs/promises";
import { DevicePhoneView } from "./DevicePhoneView";
import { hasDeviceKeyboard, phoneUnavailableReason, resolveDeviceModelId, type ViewerReport } from "./deviceViewer";
import { DeviceAndroidFoldControls } from "./DeviceAndroidFoldControls";
import { DeviceDuoControls, type DuoCommand, type DuoControlState } from "./DeviceDuoControls";
import { androidFoldView, deviceScreenKey } from "./deviceFold";
import { homedir } from "os";

type Subscribe = Parameters<typeof watchDeviceState>[0];

function DeviceListButton(props: { label: string; accessibilityLabel?: string; icon?: "play" | "arrow-up-right"; disabled?: boolean; onPress: () => void }) {
  return (
    <View role="button" accessibilityLabel={props.accessibilityLabel ?? props.label} disabled={props.disabled} onPress={props.onPress} class="h-7 flex-row items-center justify-center gap-1 rounded-lg border border-input bg-background px-2.5 hover:bg-accent">
      {props.icon ? <DIcon name={props.icon} size={14} /> : null}
      <Text class="text-xs font-medium text-foreground">{props.label}</Text>
    </View>
  );
}

function Notice(props: { text: string; onDismiss: () => void }) {
  return (
    <View role="alert" class="flex-row items-start gap-2 border-b border-border bg-destructive-8 px-3 py-2">
      <DIcon name="circle-alert" size={14} />
      <Text class="min-w-0 flex-1 text-xs text-destructive-foreground">{props.text}</Text>
      <View role="button" accessibilityLabel="Dismiss device error" onPress={props.onDismiss} class="size-5 items-center justify-center rounded hover:bg-accent"><DIcon name="x" size={12} /></View>
    </View>
  );
}

function Warning(props: { label: string; detail: string; platforms: ("ios" | "android")[]; onRetry: () => Promise<unknown> }) {
  const dismissed = signal<string | null>(null);
  const retrying = signal(false);
  const cause = () => `${props.platforms.join()}\u0000${props.detail}`;
  return (
    <>
      {dismissed() === cause() ? null : (
        <View class="flex-row flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1">
          <View class="min-w-0 flex-1 flex-row items-start gap-2"><DIcon name="triangle-alert" size={14} /><Text class="min-w-0 flex-1 text-xs text-muted-foreground">{discoveryWarningText(props.label, props.platforms)}</Text></View>
          {props.platforms.length > 0 ? <SettingsButton label={retrying() ? "Retrying…" : "Retry"} accessibilityLabel={`Retry device discovery on ${props.label}`} disabled={retrying()} onPress={() => { retrying.set(true); void props.onRetry().finally(() => retrying.set(false)); }} /> : null}
          <View role="button" accessibilityLabel={`Dismiss device warning for ${props.label}`} onPress={() => dismissed.set(cause())} class="size-5 items-center justify-center rounded hover:bg-accent"><DIcon name="x" size={12} /></View>
        </View>
      )}
    </>
  );
}

function Loading(props: { name: string; description: string; message: string; error: boolean; stage?: "opening" | "stream"; onRetry?: () => void }) {
  return (
    <DeviceLoadingView name={props.name} description={props.description} stage={props.stage ?? "opening"} message={props.message} error={props.error}>
      {props.error && props.onRetry ? <SettingsButton label="Retry" onPress={props.onRetry} /> : null}
    </DeviceLoadingView>
  );
}

/**
 * DeviceStreamView (components/device/DeviceStreamView.tsx): a booted device's video alone, the hub's MJPEG feed in a
 * WebView with its connecting and failure states. The Device tab and the floating device preview each show one.
 * `occluded` says whether something covers it (default: the right panel's occlusion test).
 */
export function DeviceStreamView(props: { device: DeviceSummary; hostLabel: string; hostKind: string | undefined; hubBasePath: string; visible: () => boolean; occluded?: (own: PageRect | null) => boolean; class?: string;
  /** Touch, keys and hardware buttons over the hub's input socket (deviceInput.ts); the floating preview shows video only. */
  input?: { onConnected: (connected: boolean) => void; bind: (send: (command: DevicePageCommand) => void) => void;
    /** The hub access of the page that was made, and each time that page starts (its first report). */
    onAccess?: (access: DeviceHubAccess) => void; onStreaming?: (streaming: boolean) => void; onPageReady?: () => void; onSse?: (name: string, data: unknown) => void;
    /** The screen the page knows: serve-sim's screen config (iOS), else the MJPEG frame size (fold reads key on it). */
    onScreen?: (screen: { width: number; height: number; orientation: string; supportsHingeAngle?: boolean }) => void } }) {
  const url = signal<string | null>(null);
  const page = signal<string | null>(null);
  let webView: WebViewRef | undefined;
  let pageReady = false;
  effect(() => { void page(); pageReady = false; });
  props.input?.bind((command) => webView?.postMessage(JSON.stringify(command)));
  const failure = signal("");
  const status = signal<"connecting" | "streaming" | "error">("connecting");
  const ownRect = signal<PageRect | null>(null);
  let host: { measure(): Promise<any> } | undefined;
  // The video: the hub's MJPEG feed, with the media ticket a bearer connection needs.
  // `visible` as a boolean memo, and one feed per environment and session: read inline, `props.visible()` ran this effect
  // again on every right-panel update (a width commit, another tab opening), and each run minted a new ticket and a new
  // feed address, which made the video's WebView again. A feed that is up is kept; one that failed is asked for again.
  const visible = computed(() => props.visible());
  let feedFor = "";
  effect(() => {
    if (!visible()) return;
    const endpoint = backendUrl(); const bearer = backendBearer();
    const device = props.device;
    const hostKind = props.hostKind;
    const hubBasePath = props.hubBasePath;
    const wanted = JSON.stringify([endpoint, bearer, hubBasePath, hostKind, device.hostId, device.id, device.platform]);
    if (feedFor === wanted && untracked(() => url() !== null && failure() === "" && status() !== "error")) return;
    if (feedFor && feedFor !== wanted) {
      page.set(null);
      url.set(null);
      props.input?.onConnected(false);
      props.input?.onStreaming?.(false);
    }
    const base = hubHttpBase(endpoint, hubBasePath);
    if (!base) { failure.set("The environment address is not available."); return; }
    let stale = false;
    status.set("connecting"); failure.set("");
    void (async () => {
      try {
        const query: Record<string, string> = { hostId: device.hostId };
        if (bearer) query.wsTicket = await mintMediaTicket(endpoint, bearer);
        if (!stale) {
          feedFor = wanted;
          const target = { platform: device.platform, deviceId: device.id, serveSimOnly: hostKind === "simlock" };
          const feed = mjpegUrl({ httpBase: base, query }, target);
          const input = props.input ? deviceInputScript({ url: inputSocketUrl({ httpBase: base, query }, target), platform: props.device.platform, avcc: target.platform === "ios" || target.serveSimOnly }) : undefined;
          page.set(streamPage(feed, input)); url.set(feed);
          props.input?.onAccess?.({ httpBase: base, query });
        }
      } catch (cause) { if (!stale) { failure.set(errorMessage(cause)); status.set("error"); } }
    })();
    return () => { stale = true; };
  });
  const occluded = () => !visible() || (props.occluded ?? panelViewOccluded)(ownRect());
  return (
      <View ref={(node: any) => { host = node; }} onLayout={() => measureInto(host, ownRect)} class={props.class ?? "min-h-0 min-w-0 flex-1"}>
        {failure() ? <Loading name={props.device.name} description={`${props.hostLabel} · ${props.device.version}`} message={failure()} error stage="stream" /> : null}
        {occluded() && !failure() ? <View class="min-h-0 flex-1 bg-background" /> : null}
        {url() && !failure() ? (
          <WebView
            ref={(node: WebViewRef) => { webView = node; }}
            html={page() ?? streamPage(url()!)}
            class={occluded() ? "hidden bg-background" : "min-h-0 flex-1 bg-background"}
            onMessage={(event) => { try { const m = JSON.parse(event.data) as { t3?: string; status?: "streaming" | "error"; connected?: boolean }; if (m.t3 === "stream" && m.status) { status.set(m.status); props.input?.onStreaming?.(m.status === "streaming"); } if (m.t3 === "input") { if (!pageReady) { pageReady = true; props.input?.onPageReady?.(); } props.input?.onConnected(m.connected === true); } if (m.t3 === "screen") props.input?.onScreen?.((m as { screen?: any }).screen); if (m.t3 === "sse") props.input?.onSse?.(String((m as { name?: unknown }).name), (m as { data?: unknown }).data); } catch { /* not ours */ } }}
          />
        ) : null}
        {status() === "connecting" && !failure() ? <Text class="px-3 py-2 text-xs text-muted-foreground">Connecting video…</Text> : null}
      </View>
  );
}

/** The booted device: its video and its settings. */
function Workspace(props: { device: DeviceSummary; hostLabel: string; hostKind: string | undefined; hostDiagnostics?: () => string | undefined; hubBasePath: string; visible: () => boolean; request: DeviceRequest; onClose: () => void; onPowerOff: () => void }) {
  const toolsOpen = signal(false);
  const workspaceWidth = signal(0);
  const overlayTools = () => webViewsUnderSurface() && workspaceWidth() > 0 && workspaceWidth() < 700;
  const settings = signal<Record<string, unknown> | null>(null);
  const toolsError = signal("");
  const busy = signal(false);
  const runsHostCommands = props.hostKind === "local" || props.hostKind === "ssh";
  const target = { hostId: props.device.hostId, deviceId: props.device.id };
  // useDeviceControls: `foregroundApp` of the last DeviceDetail (the reference also follows the hub's foreground stream).
  const foregroundApp = signal<{ id: string } | null>(null);
  const applyDetail = (detail: unknown) => {
    const d = detail as { settings?: Record<string, unknown>; foregroundApp?: { id?: unknown } | null } | null;
    if (d?.settings) settings.set(d.settings);
    if (d && "foregroundApp" in d) foregroundApp.set(d.foregroundApp && typeof d.foregroundApp.id === "string" ? { id: d.foregroundApp.id } : null);
  };
  const readSettings = () => { void deviceDetail(target, props.request).then((detail) => { applyDetail(detail); if (settings() === null) settings.set({}); toolsError.set(""); }).catch((cause) => toolsError.set(errorMessage(cause))); };
  // useDeviceControls reads the settings while the device is shown (the rail's appearance and text size need them).
  effect(() => { if (runsHostCommands && (toolsOpen() || props.visible()) && settings() === null) untracked(readSettings); });
  async function act(body: Record<string, unknown>): Promise<boolean> {
    if (busy()) return false;
    busy.set(true); toolsError.set("");
    try { applyDetail(await deviceAction({ ...target, ...body, type: String(body.type) }, props.request)); return true; }
    catch (cause) { toolsError.set(errorMessage(cause)); return false; }
    finally { busy.set(false); }
  }
  // DeviceControlsRail's hardware buttons and rotation go to the stream page's input socket (deviceInput.ts).
  const inputConnected = signal(false);
  let sendCommand: (command: DevicePageCommand) => void = () => {};
  const rotateOpen = signal(false);
  // deviceHubApi.ts: the foreground app and event log stream from the hub (iOS) through the stream page; the AX tree is polled.
  const access = signal<DeviceHubAccess | null>(null);
  const eventLogOpen = signal(false);
  const eventLog = signal<DeviceEventLogEntry[]>([]);
  const axOverlay = signal(false);
  const hubTarget = () => { const a = access(); return a ? { access: a, platform: props.device.platform, deviceId: props.device.id } : null; };
  const syncStreams = () => {
    const t = untracked(hubTarget);
    sendCommand({ t3device: "sse", name: "foreground", url: t && t.platform === "ios" ? foregroundUrl(t) : null });
    sendCommand({ t3device: "sse", name: "eventlog", url: t && t.platform === "ios" && untracked(eventLogOpen) ? eventLogUrl(t) : null });
  };
  effect(() => { void eventLogOpen(); void access(); untracked(syncStreams); if (!eventLogOpen()) untracked(() => eventLog.set([])); });
  const onSse = (name: string, data: unknown) => {
    if (name === "foreground") { const app = readForegroundMessage(data); if (app !== undefined) foregroundApp.set(app); }
    else if (name === "eventlog") { const batch = readEventLogMessage(data); if (batch) eventLog.set(appendDeviceEventLog(eventLog(), batch.entries, batch.reset)); }
  };
  effect(() => {
    const t = hubTarget();
    if (!axOverlay() || !t || !props.visible()) { untracked(() => sendCommand({ t3device: "ax", elements: [] })); return; }
    let stopped = false;
    const poll = () => { void fetchDeviceAxTree(t).then((tree) => { if (!stopped) sendCommand({ t3device: "ax", elements: tree.elements }); }).catch(() => {}); };
    poll();
    const timer = setInterval(poll, AX_POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(timer); };
  });
  useOverlayOpen(() => rotateOpen(), "device rotate menu");
  // DeviceWorkspace saveScreenshot: the hub's PNG, saved to Downloads (the browser's download); a capture always finishes.
  const streaming = signal(false);
  const screenshotPending = signal(false);
  const screenshotError = signal<string | null>(null);
  const saveScreenshot = () => {
    const t = hubTarget();
    if (!t || screenshotPending() || !props.visible()) return;
    screenshotPending.set(true);
    screenshotError.set(null);
    void captureDeviceScreenshot(t)
      .then((image) => writeFile(`${homedir()}/Downloads/${deviceScreenshotFileName(props.device.name, Date.now())}`, image))
      .catch((cause: unknown) => screenshotError.set(cause instanceof Error ? cause.message : "Screenshot capture failed. Try again."))
      .finally(() => screenshotPending.set(false));
  };
  const textSizeOpen = signal(false);
  const moreOpen = signal(false);
  useOverlayOpen(() => textSizeOpen() || moreOpen(), "device rail menu");
  const menuRow = (label: string, onSelect: () => void, checked?: boolean, icon?: string) => (
    <MenuItem accessibilityLabel={label} {...(checked === undefined ? {} : { role: "menuitemradio" as const, checked })} class="min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent" onSelect={onSelect}>
      {icon ? <DIcon name={icon} size={14} /> : null}
      <Text class="flex-1 text-sm text-popover-foreground">{label}</Text>
      {checked ? <DIcon name="check" size={14} /> : null}
    </MenuItem>
  );
  const isIos = props.device.platform === "ios";
  // DeviceStreamView's presentation: the 3D phone by default, the flat (MJPEG) view when chosen or when 3D cannot run.
  const isDuo = resolveDeviceModelId(props.device.platform, props.device.name) === "iphone-duo";
  const presentation = signal<"phone" | "flat">("phone");
  const keyboardAttached = signal(false);
  const screen = signal<NonNullable<ViewerReport["screen"]> | null>(null);
  const phoneUnavailable = signal(false);
  const noH264 = signal(false);
  const viewerStatus = signal<"connecting" | "streaming" | "error">("connecting");
  const duoControl = signal<DuoControlState>({ pending: false, requested: null, error: null });
  const reason = () => phoneUnavailableReason({ isDuo, supportsHingeAngle: screen()?.supportsHingeAngle === true, phoneUnavailable: phoneUnavailable(), mjpeg: noH264(), axOverlay: axOverlay() });
  const showPhone = computed(() => presentation() === "phone" && reason() === null);
  const viewStreaming = () => (showPhone() ? viewerStatus() === "streaming" : streaming());
  const onViewerReport = (report: ViewerReport) => {
    if (report.status) viewerStatus.set(report.status);
    if (report.screen) screen.set(report.screen);
    if (report.input) inputConnected.set(report.input.connected);
    if (report.duoControl) duoControl.set(report.duoControl as DuoControlState);
    if (report.phoneUnavailable) phoneUnavailable.set(true);
    if (report.mjpegUrl) noH264.set(true);
    if (report.status) streaming.set(report.status === "streaming");
  };
  effect(() => { void showPhone(); untracked(() => { viewerStatus.set("connecting"); inputConnected.set(false); streaming.set(false); }); });
  const foldKey = deviceScreenKey(backendUrl(), props.device.hostId, props.device.id);
  const renewAccess = async () => {
    const current = untracked(access); const bearer = backendBearer();
    if (!current) return null;
    if (!bearer) return current;
    try { const next = { ...current, query: { ...current.query, wsTicket: await mintMediaTicket(backendUrl(), bearer) } }; access.set(next); return next; } catch { return null; }
  };
  const railTip = (label: string, icon: string, onPress: () => void, pressed?: boolean, disabled?: boolean, description?: string) => (
    <View role="button" accessibilityLabel={label} tooltip={description ?? label} accessibilityState={{ ...(pressed === undefined ? {} : { pressed }), ...(disabled ? { disabled: true } : {}) }} disabled={disabled} onPress={() => { if (!disabled) onPress(); }} class={`size-8 items-center justify-center rounded-md ${disabled ? "opacity-50" : pressed ? "bg-secondary" : "hover:bg-accent"}`}><DIcon name={icon} size={16} /></View>
  );
  const rail = (label: string, icon: string, onPress: () => void, pressed?: boolean, disabled?: boolean) => (
    <View role="button" accessibilityLabel={label} accessibilityState={{ ...(pressed === undefined ? {} : { pressed }), ...(disabled ? { disabled: true } : {}) }} disabled={disabled} onPress={() => { if (!disabled) onPress(); }} class={`size-8 items-center justify-center rounded-md ${disabled ? "opacity-50" : pressed ? "bg-accent" : "hover:bg-accent"}`}><DIcon name={icon} size={16} /></View>
  );
  const switchRow = (label: string, key: string, setting: string) => (
    <View class="min-h-7 flex-row items-center justify-between gap-3"><Text class="text-xs text-muted-foreground">{label}</Text>
      <SettingsSwitch label={label} checked={settings()?.[key] === true} onChange={(next) => void act({ type: "setToggle", setting, value: next })} /></View>
  );
  const dark = () => settings()?.appearance === "dark";
  return (
    <View class="relative min-h-0 min-w-0 flex-1 flex-row" onLayout={(event) => workspaceWidth.set(event.bounds.size.width)} accessibilityLabel={`Device ${props.device.name}`}>
      <View class="relative min-h-0 min-w-0 flex-1 flex-col">
        {screenshotError() || (toolsError() && !toolsOpen()) ? <Text role="alert" class="px-3 py-2 text-xs text-destructive">{screenshotError() ?? toolsError()}</Text> : null}
        <View class="min-h-0 min-w-0 flex-1 flex-row">
          {showPhone() ? (
            <DevicePhoneView device={props.device} hostKind={props.hostKind} hubBasePath={props.hubBasePath} visible={props.visible}
              keyboardAttached={keyboardAttached} foldAngle={() => androidFoldView(foldKey)().angle}
              bind={(send) => { sendCommand = send as (command: DevicePageCommand) => void; }} onReport={onViewerReport} onAccess={(next) => access.set(next)} onNoVideo={() => noH264.set(true)}
              onSse={onSse} onPageReady={() => syncStreams()} />
          ) : (
          <DeviceStreamView device={props.device} hostLabel={props.hostLabel} hostKind={props.hostKind} hubBasePath={props.hubBasePath} visible={props.visible}
            input={{ onConnected: (connected) => inputConnected.set(connected), onStreaming: (next) => streaming.set(next), bind: (send) => { sendCommand = send; }, onAccess: (next) => access.set(next), onPageReady: () => { syncStreams(); if (untracked(axOverlay)) axOverlay.set(true); }, onSse, onScreen: (next) => screen.set(next) }} />
          )}
        </View>
      </View>
      {toolsOpen() ? (
        <DeviceToolsPanel platform={props.device.platform} overlayWidth={() => overlayTools() ? Math.min(288, workspaceWidth()) : undefined} {...(props.hostDiagnostics?.() ? { hostDiagnostics: props.hostDiagnostics()! } : {})} settings={settings} foregroundApp={foregroundApp} pending={busy} error={toolsError}
          act={(body: DeviceActBody) => act(body)} onClose={() => toolsOpen.set(false)}
          axOverlay={axOverlay} onAxOverlayChange={(next) => axOverlay.set(next)} hubAvailable={() => access() !== null}
          eventLog={props.device.platform === "ios" ? { open: eventLogOpen, entries: eventLog, onOpenChange: (next) => eventLogOpen.set(next) } : undefined} />
      ) : null}
      <View class="w-14 shrink-0 items-center justify-center py-3 pr-2" style={webViewsUnderSurface() ? { position: "absolute", top: 0, bottom: 0, right: toolsOpen() && !overlayTools() ? 288 : 0, pointerEvents: "box-none" } : undefined} accessibilityLabel="Device controls">
        <View class="shrink-0 items-center gap-1 rounded-full border border-border-50 bg-background p-2">
        {rail("Home", "house", () => sendCommand({ t3device: "button", button: "home" }), undefined, !inputConnected())}
        {isIos ? (props.hostKind === "simlock" ? null : rail("Rotate device", "rotate-ccw", () => sendCommand({ t3device: "rotate" }), undefined, !inputConnected() || keyboardAttached())) : (
          <>
            {rail("Back", "chevron-left", () => sendCommand({ t3device: "button", button: "back" }), undefined, !inputConnected())}
            {rail("Recents", "square", () => sendCommand({ t3device: "button", button: "recents" }), undefined, !inputConnected())}
            {runsHostCommands ? (
              <Menu open={rotateOpen()} onOpenChange={trackOpenChange(rotateOpen)} align="end" popupClass="min-w-32 w-max rounded-lg border border-border bg-popover-84 p-1 shadow-lg"
                trigger={<View role="button" accessibilityLabel="Rotate device" disabled={busy()} class="size-8 items-center justify-center rounded-md hover:bg-accent"><DIcon name="rotate-ccw" size={16} /></View>}>
                <MenuItem accessibilityLabel="Portrait" class="min-h-7 flex-row items-center rounded-sm px-2 py-1 hover:bg-accent" onSelect={() => void act({ type: "setOrientation", value: "portrait" })}><Text class="text-sm text-popover-foreground">Portrait</Text></MenuItem>
                <MenuItem accessibilityLabel="Landscape" class="min-h-7 flex-row items-center rounded-sm px-2 py-1 hover:bg-accent" onSelect={() => void act({ type: "setOrientation", value: "landscape_left" })}><Text class="text-sm text-popover-foreground">Landscape</Text></MenuItem>
              </Menu>
            ) : null}
          </>
        )}
        {runsHostCommands ? <View class="my-1 h-px w-5 shrink-0 bg-border" /> : null}
        {runsHostCommands ? rail(`Switch device to ${dark() ? "light" : "dark"} mode`, dark() ? "sun" : "moon", () => void act({ type: "setAppearance", value: dark() ? "light" : "dark" }), undefined, busy() || !settings()?.appearance) : null}
        {runsHostCommands ? (
          <Menu open={textSizeOpen()} onOpenChange={trackOpenChange(textSizeOpen)} align="end" popupClass="min-w-40 w-max rounded-lg border border-border bg-popover-84 p-1 shadow-lg"
            trigger={<View role="button" accessibilityLabel="Device text size" tooltip="Device text size" disabled={busy() || !settings()?.textSize} class={`size-8 items-center justify-center rounded-md ${busy() || !settings()?.textSize ? "opacity-50" : "hover:bg-accent"}`}><DIcon name="type" size={16} /></View>}>
            {([["small", "Small"], ["default", "Default"], ["large", "Large"], ["extra-large", "Extra large"]] as const).map(([value, label]) => menuRow(label, () => void act({ type: "setTextSize", value }), settings()?.textSize === value))}
          </Menu>
        ) : null}
        {runsHostCommands ? rail("Device tools", "sliders-horizontal", () => toolsOpen.set(!toolsOpen()), toolsOpen()) : null}
        {props.hostKind === "simlock" ? null : rail(screenshotPending() ? "Capturing screenshot" : "Save screenshot", "camera", saveScreenshot, undefined, !streaming() || screenshotPending() || access() === null)}
        <Menu open={moreOpen()} onOpenChange={trackOpenChange(moreOpen)} align="end" popupClass="min-w-48 w-max rounded-lg border border-border bg-popover-84 p-1 shadow-lg"
          trigger={<View role="button" accessibilityLabel="More device actions" tooltip="More device actions" class="size-8 items-center justify-center rounded-md hover:bg-accent"><DIcon name="ellipsis" size={16} /></View>}>
          {menuRow("Float device over chat", () => closeRightPanelAction(), undefined, "picture-in-picture-2")}
          {menuRow("Close device panel", props.onClose, undefined, "x")}
          <View class="my-1 h-px bg-border" />
          {menuRow(props.hostKind === "simlock" ? "Return device to the pool" : "Power off device", props.onPowerOff, undefined, "power")}
        </Menu>
        <View class="my-1 h-px w-5 shrink-0 bg-border" />
        {railTip("3D view", "box", () => presentation.set("phone"), showPhone(), !viewStreaming() || reason() !== null, reason() ?? undefined)}
        {railTip("Flat view", "smartphone", () => presentation.set("flat"), !showPhone(), !viewStreaming())}
        {showPhone() && hasDeviceKeyboard(props.device.platform, props.device.name) ? railTip(keyboardAttached() ? "Detach Magic Keyboard" : "Attach Magic Keyboard", "keyboard", () => { const next = !keyboardAttached(); keyboardAttached.set(next); sendCommand({ t3viewer: "keyboard", attached: next } as unknown as DevicePageCommand); }, keyboardAttached()) : null}
        {showPhone() ? railTip("Restore 3D view", "maximize", () => sendCommand({ t3viewer: "reset" } as unknown as DevicePageCommand)) : null}
        </View>
        {props.device.platform === "android" ? (
          <View class="mt-2"><DeviceAndroidFoldControls access={access} deviceKey={foldKey} deviceId={props.device.id} visible={props.visible} enabled={viewStreaming} screen={screen} renewAccess={renewAccess} /></View>
        ) : showPhone() && isDuo && screen()?.supportsHingeAngle ? (
          <View class="mt-2"><DeviceDuoControls screen={() => screen()!} state={duoControl} enabled={() => inputConnected()} onCommand={(command: DuoCommand) => sendCommand({ t3viewer: "duo", command } as unknown as DevicePageCommand)} /></View>
        ) : null}
      </View>
    </View>
  );
}

export function DevicePanel(props: { surface: Surface; threadId: string; visible: () => boolean; onCloseSurface: () => void; onOpened: (target: { hostId: string; deviceId: string; platform: "ios" | "android"; name: string }) => void; subscribe?: Subscribe; request?: DeviceRequest }) {
  const request = props.request ?? requestBackend;
  const watch = watchDeviceState(props.subscribe);
  const state = () => watch.state();
  const operation = signal<{ pending: DeviceSummary | null; error: string | null }>({ pending: null, error: null });
  const retrying = signal<string | null>(null);
  const setupOpen = signal(true);
  const sessions = () => state().sessions.filter((session) => session.threadId === props.threadId);
  const activeSession = () => (props.surface.target ? sessions().find((s) => s.deviceId === props.surface.target?.deviceId && s.hostId === props.surface.target.hostId) : undefined);
  const activeDevice = () => { const s = activeSession(); return s ? state().devices.find((d) => d.hostId === s.hostId && d.id === s.deviceId) : undefined; };
  const activeHost = () => { const d = activeDevice(); return d ? state().hosts.find((h) => h.id === d.hostId) : undefined; };
  // The reference probes once per mount (useAtomMount(deviceHostProbeAtom), gated on visible/loaded/!disabled), not on
  // every snapshot. `state()` is replaced on every subscribeDeviceState push while a device boots, so reading it directly
  // here re-fired device.list on each push -- a slow request stacked on the server for every progress update. `ready`
  // is a computed boolean: it only changes (and only then re-runs the effect) when the probe condition actually flips.
  const ready = computed(() => props.visible() && watch.loaded() && state().hostStatus !== "disabled");
  effect(() => { if (ready()) void deviceList({}, request).catch(() => {}); });
  const needs = () => needsSetup(state(), watch.loaded());
  const readiness = () => deviceHubReadiness(state());
  const loading = () => !activeDevice() && (operation().pending !== null || readiness().busy || !watch.loaded());
  const loadError = () => (watch.loaded() ? null : watch.error());
  async function select(device: DeviceSummary) {
    operation.set({ pending: device, error: null });
    try {
      const result = (await deviceOpen({ threadId: props.threadId, hostId: device.hostId, deviceId: device.id, platform: device.platform }, request)) as { hostId?: string; deviceId?: string };
      props.onOpened({ hostId: result.hostId ?? device.hostId, deviceId: result.deviceId ?? device.id, platform: device.platform, name: device.name });
      operation.set({ pending: null, error: null });
    } catch (cause) { operation.set({ pending: null, error: errorMessage(cause) }); }
  }
  async function closeActive(powerOff: boolean) {
    const session = activeSession();
    if (!powerOff || !session) { props.onCloseSurface(); return; }
    operation.set({ pending: null, error: null });
    try { await deviceClose({ threadId: props.threadId, hostId: session.hostId, deviceId: session.deviceId, shutdown: true }, request); props.onCloseSurface(); }
    catch (cause) { operation.set({ pending: null, error: errorMessage(cause) }); }
  }
  const diagnostics = () => hostDiagnostics(state());
  return (
    <View class="min-h-0 w-full min-w-0 flex-1" accessibilityLabel="Device">
      <DeviceSetupDialog open={() => needs() && props.visible() && setupOpen()} state={state} onClose={() => { setupOpen.set(false); props.onCloseSurface(); }} request={request} />
      {needs() ? null : (
        <View class="min-h-0 flex-1">
          <View class="shrink-0 bg-background">
            {activeDevice() ? null : diagnostics().map((d) => <Warning label={d.label} detail={d.detail} platforms={d.incompletePlatforms} onRetry={() => deviceList({}, request)} />)}
            {state().hosts.map((host) => {
              const status = state().hostStatuses[host.id];
              if (!status || !["installing", "starting", "failed"].includes(status.status)) return null;
              const failed = status.status === "failed";
              return (
                <View class="mx-3 my-1 flex-row items-start gap-3 rounded-md border border-border-60 px-3 py-2">
                  <View class="min-w-0 flex-1"><Text class="text-xs font-medium text-foreground">{host.label}</Text><Text class="text-xs text-muted-foreground">{hostUpdateDetail(status)}</Text>
                    {failed ? <Text class="mt-1 text-xs text-muted-foreground">Check the host connection and network access, then retry. Your device settings are saved.</Text> : null}</View>
                  {failed && state().supportsHostRetry ? <SettingsButton label={retrying() === host.id ? "Retrying…" : "Retry"} disabled={retrying() !== null} onPress={() => { retrying.set(host.id); void deviceList({ retryHostId: host.id }, request).catch(() => {}).finally(() => retrying.set(null)); }} /> : null}
                </View>
              );
            })}
            {state().bootingDevices.filter((d) => d.threadId === props.threadId).length > 0 ? <Text class="border-b border-border px-3 py-2 text-xs text-muted-foreground">{`Starting ${state().bootingDevices.filter((d) => d.threadId === props.threadId).map((d) => d.name).join(", ")}… This can take a minute.`}</Text> : null}
            {operation().error ? <Notice text={operation().error!} onDismiss={() => operation.set({ pending: null, error: null })} /> : null}
          </View>
          {activeDevice() && activeSession() ? (
            <Each of={[activeDevice()!]} key={(device: DeviceSummary) => `${deviceKey(device)}\u0000${device.platform}`}>
              {(device: () => DeviceSummary) => <Workspace device={device()} hostLabel={activeHost()?.label ?? "Device host"} hostKind={activeHost()?.kind} hostDiagnostics={() => diagnostics().find(({ hostId }) => hostId === device().hostId)?.detail} hubBasePath={state().hubBasePath} visible={props.visible} request={request} onClose={() => void closeActive(false)} onPowerOff={() => void closeActive(true)} />}
            </Each>
          ) : loading() ? (
            <Loading
              name={operation().pending?.name ?? "Devices"}
              description={operation().pending ? `${state().hosts.find((h) => h.id === operation().pending!.hostId)?.label ?? "Device host"} · ${operation().pending!.version}` : ""}
              message={loadingMessage({ loadError: loadError(), pending: operation().pending, hostStatus: state().hostStatus, ...(state().hostStatusDetail ? { hostStatusDetail: state().hostStatusDetail } : {}) })}
              error={loadError() !== null} onRetry={watch.refresh}
            />
          ) : (
            <Scroll class="min-h-0 flex-1" contentClass="px-5 py-8">
              <View class={`mx-auto w-full max-w-xl gap-6 ${groupDevices(state()).length === 0 ? "items-center" : ""}`}>
                {groupDevices(state()).length === 0 ? <><DIcon name="smartphone" size={24} /><Text class="max-w-sm text-center text-sm text-muted-foreground">{emptyListMessage(state())}</Text></> : null}
                {readiness().ready ? groupDevices(state()).map((group) => (
                  <View class="gap-3" accessibilityLabel={platformGroupLabel(group.platform)}>
                    <View class="flex-row items-center gap-2"><DIcon name="smartphone" size={16} /><Text class="text-sm font-medium text-muted-foreground">{platformGroupLabel(group.platform)}</Text></View>
                    <View class="overflow-hidden rounded-xl border border-border-70 bg-background">
                      {group.devices.map((device, index) => (
                        <View class={`flex-row items-center gap-3 px-3 py-3 ${index === 0 ? "" : "border-t border-border-60"}`}>
                          <View class="size-8 shrink-0 items-center justify-center rounded-md border border-border-60"><DIcon name="smartphone" size={16} /></View>
                          <View class="min-w-0 flex-1"><Text class="truncate text-sm font-medium text-foreground">{device.name}</Text>
                            <Text class="truncate text-xs text-muted-foreground">{`${state().hosts.find((h) => h.id === device.hostId)?.label} · ${device.version} · ${device.booted ? "Running" : "Stopped"}`}</Text></View>
                          <DeviceListButton label={device.booted ? "Open" : "Start"} icon={device.booted ? "arrow-up-right" : "play"} accessibilityLabel={`${device.booted ? "Open" : "Start"} ${device.name}`} disabled={operation().pending !== null} onPress={() => void select(device)} />
                        </View>
                      ))}
                    </View>
                  </View>
                )) : null}
                {showsAndroidHint(state()) ? <Text class="max-w-sm text-xs text-muted-foreground">No Android virtual devices found. Create one in Android Studio's Device Manager, then refresh.</Text> : null}
                {watch.loaded() && !readiness().busy ? <View class={groupDevices(state()).length > 0 ? "self-start" : "self-center"}><DeviceListButton label="Refresh devices" onPress={() => void deviceList({}, request).catch(() => {})} /></View> : null}
              </View>
            </Scroll>
          )}
        </View>
      )}
    </View>
  );
}
