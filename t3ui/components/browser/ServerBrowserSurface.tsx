// ServerBrowserSurface.tsx (apps/web/src/browser): a server-hosted browser tab (the server's own Chromium, the tab an
// agent's preview_open made). The frame stream and its input run inside a WebView page (serverBrowserPage.ts); this
// component draws the reference's control bar, dialog, host-setup and refused-connection states natively.
// NOT ported (see STATUS): file chooser upload (no general file picker in NSH), touch gestures and
// growing the frame cap after the first size.
import { Clipboard, computed, effect, openUrl, signal, Text, token, untracked, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { Input } from "nsh/base";
import { backendBearer, backendUrl } from "../../store";
import { mintMediaTicket } from "../device/deviceStream";
import { SettingsButton } from "../SettingsLayout";
import { closeToast, showToast } from "../toast";
import { showPreviewPopup } from "../rightPanel/serverPreviewSync";
import {
  decodeHostSetup, previewStreamControlLabel, previewStreamDownloadUrl, previewStreamHostSetupMessage, previewStreamSocketUrl, serverBrowserPage,
  type PreviewStreamControl, type PreviewStreamHostSetup,
} from "./serverBrowserStream";

const MAX_UNAUTHORIZED_REFUSALS = 3;

export function ServerBrowserSurface(props: { threadId: string; tabId: string; visible: () => boolean; hidden?: () => boolean; class?: string; pdfUrl?: () => string | null; followSize?: () => boolean }) {
  const page = signal<string | null>(null);
  const control = signal<PreviewStreamControl | null>(null);
  const hostSetup = signal<PreviewStreamHostSetup | null>(null);
  const accessDenied = signal(false);
  const failure = signal("");
  const promptText = signal("");
  const attempt = signal(0);
  let refusals = 0;
  let view: WebViewRef | undefined;
  const visible = computed(() => props.visible());
  effect(() => {
    void attempt();
    if (!visible() || accessDenied() || hostSetup()) return;
    const endpoint = backendUrl(); const bearer = backendBearer();
    let stale = false;
    failure.set("");
    void (async () => {
      try {
        const query: Record<string, string> = {};
        if (bearer) query.wsTicket = await mintMediaTicket(endpoint, bearer);
        const url = previewStreamSocketUrl(endpoint, query);
        if (!url) throw new Error("The environment address is not available.");
        if (!stale) page.set(serverBrowserPage({ url, threadId: props.threadId, tabId: props.tabId, followSize: untracked(() => props.followSize?.() ?? true) }, { primary: String(token("primary")), background: String(token("background")) }));
      } catch (cause) { if (!stale) failure.set(cause instanceof Error ? cause.message : String(cause)); }
    })();
    return () => { stale = true; };
  });
  const send = (input: Record<string, unknown>) => view?.postMessage(JSON.stringify({ t3sb: "send", input }));
  effect(() => { const follow = props.followSize?.() ?? true; view?.postMessage(JSON.stringify({ t3sb: "followSize", value: follow })); });
  function onMessage(data: string) {
    let m: Record<string, unknown>;
    try { m = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    if (m.t3 !== "sb") return;
    if (m.type === "started") view?.postMessage(JSON.stringify({ t3sb: "followSize", value: props.followSize?.() ?? true }));
    else if (m.type === "control") {
      const next = m.control as PreviewStreamControl;
      const previous = untracked(control);
      if (next.dialog?.message !== previous?.dialog?.message || next.dialog?.defaultValue !== previous?.dialog?.defaultValue) promptText.set(next.dialog?.defaultValue ?? "");
      control.set(next);
      refusals = 0;
    } else if (m.type === "connected" && m.connected === false) control.set(null);
    // ServerBrowserSurface.tsx:107-140, 399-401: the page's copied text goes to the clipboard (the reference's toast is
    // only its fallback when the browser refuses a late write; the native clipboard does not); a download offers Save.
    else if (m.type === "clipboard" && typeof m.text === "string") Clipboard.writeText(m.text);
    else if (m.type === "download" && typeof m.id === "string" && typeof m.fileName === "string") offerDownload(m.id, m.fileName);
    else if (m.type === "popup" && typeof m.tabId === "string") showPreviewPopup(props.threadId, m.tabId);
    else if (m.type === "hostSetup") hostSetup.set(decodeHostSetup(String(m.reason ?? "")));
    else if (m.type === "unauthorized") {
      refusals += 1;
      page.set(null);
      if (refusals >= MAX_UNAUTHORIZED_REFUSALS) accessDenied.set(true);
      else setTimeout(() => attempt.update((n) => n + 1), refusals === 1 ? 0 : 1000 * 2 ** (refusals - 1));
    }
  }
  function offerDownload(id: string, fileName: string) {
    const toastId = showToast({ type: "info", title: `Downloaded ${fileName}`, actionLayout: "inline", actions: [{ label: "Save", run: () => {
      closeToast(toastId);
      void (async () => {
        const endpoint = backendUrl(); const bearer = backendBearer();
        const query: Record<string, string> = bearer ? { wsTicket: await mintMediaTicket(endpoint, bearer) } : {};
        const url = previewStreamDownloadUrl(endpoint, { threadId: props.threadId, tabId: props.tabId }, id, query);
        if (url) await openUrl(url);
      })().catch(() => {});
    } }] });
  }
  const c = () => control();
  return (
    <View class={props.class ?? "min-h-0 min-w-0 flex-1"} accessibilityLabel="Server browser">
      <View class="h-8 shrink-0 flex-row items-center justify-between gap-2 border-b border-border bg-background px-2 py-1">
        <Text accessibilityLabel="Browser control status" class="text-xs text-muted-foreground">{previewStreamControlLabel(c())}</Text>
        {c()?.canOperate ? (
          <SettingsButton label={c()!.controller === "you" ? "Release control" : "Take control"} disabled={c()!.controller === "another-viewer"}
            onPress={() => send({ type: c()!.controller === "you" ? "releaseControl" : "takeControl" })} />
        ) : null}
      </View>
      <View class="relative min-h-0 flex-1">
        {failure() ? <Text role="alert" class="p-3 text-xs text-muted-foreground">{failure()}</Text> : null}
        {page() && !failure() ? (
          <WebView ref={(node: WebViewRef) => { view = node; }} html={page()!} accessibilityLabel="Browser page"
            class={props.hidden?.() || props.pdfUrl?.() ? "hidden" : "min-h-0 flex-1"} onMessage={(event) => onMessage(event.data)} />
        ) : null}
        {/* ServerBrowserSurface.tsx:772-779: a PDF asset is drawn as the document in place of the frames. */}
        {props.pdfUrl?.() ? <WebView src={props.pdfUrl()!} accessibilityLabel="PDF document" class={props.hidden?.() ? "hidden" : "min-h-0 flex-1"} /> : null}
        {c()?.dialog ? (
          <View accessibilityLabel="Browser dialog" class="absolute inset-x-2 top-2 gap-2 rounded-lg border border-border bg-background p-3 shadow-lg">
            <Text class="text-sm text-foreground">{c()!.dialog!.message}</Text>
            {c()!.controller === "you" ? (
              <>
                {c()!.dialog!.type === "prompt" ? <Input accessibilityLabel="Dialog response" value={promptText()} onChange={(e: { value: string }) => promptText.set(e.value)} class="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground" /> : null}
                <View class="flex-row justify-end gap-2">
                  <SettingsButton label="Dismiss" onPress={() => send({ type: "dialog", accept: false })} />
                  <SettingsButton label="Accept" tone="primary" onPress={() => send({ type: "dialog", accept: true, ...(c()?.dialog?.type === "prompt" ? { promptText: promptText() } : {}) })} />
                </View>
              </>
            ) : <Text class="text-xs text-muted-foreground">Take control to respond.</Text>}
          </View>
        ) : null}
      </View>
      {visible() && hostSetup() ? (
        <View class="absolute inset-0 items-center justify-center gap-3 bg-background p-4">
          <Text role="alert" class="max-w-sm text-center text-sm text-muted-foreground">{previewStreamHostSetupMessage(hostSetup()!)}</Text>
          <Text class="w-full max-w-md rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground">{hostSetup()!.command}</Text>
          <SettingsButton label="Try again" onPress={() => hostSetup.set(null)} />
        </View>
      ) : null}
      {visible() && accessDenied() ? (
        <View class="absolute inset-0 items-center justify-center gap-2 bg-background p-3">
          <Text role="alert" class="text-xs text-muted-foreground">Browser connection was refused.</Text>
          <SettingsButton label="Reconnect" onPress={() => { refusals = 0; accessDenied.set(false); attempt.update((n) => n + 1); }} />
        </View>
      ) : null}
    </View>
  );
}
