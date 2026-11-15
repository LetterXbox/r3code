// DeviceStreamView's 3D presentation: the bundled viewer page (deviceViewer.ts) in a WebView, with the hub access a
// bearer connection needs (a media ticket, minted again when the hub says it expired). The page owns the video and input
// connection while it is shown; the app's rail sends commands into it and reads its reports.
import { computed, effect, signal, Text, untracked, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { backendBearer, backendUrl } from "../../store";
import { measureInto, panelViewOccluded, type PageRect } from "../rightPanel/nativeOcclusion";
import type { DeviceSummary } from "./deviceLogic";
import { errorMessage } from "./deviceState";
import { hubHttpBase, mintMediaTicket, type DeviceHubAccess } from "./deviceStream";
import { buildViewerPage, readViewerReport, viewerFirstFrameMs, type ViewerReport } from "./deviceViewer";

export function DevicePhoneView(props: {
  device: DeviceSummary;
  hostKind: string | undefined;
  hubBasePath: string;
  visible: () => boolean;
  keyboardAttached: () => boolean;
  foldAngle: () => number | null;
  bind: (send: (command: Record<string, unknown>) => void) => void;
  onReport: (report: ViewerReport) => void;
  /** The hub's SSE streams the page relays (foreground app, event log), as on the flat page. */
  onSse?: (name: string, data: unknown) => void;
  /** The page started (its first report): the app opens its hub streams there again. */
  onPageReady?: () => void;
  onAccess: (access: DeviceHubAccess) => void;
  /** No frame within VIEWER_FIRST_FRAME_MS (the H.264 path did not start here): the panel falls back to the flat view. */
  onNoVideo: () => void;
  occluded?: (own: PageRect | null) => boolean;
}) {
  const page = signal<string | null>(null);
  const failure = signal("");
  const renew = signal(0);
  const ownRect = signal<PageRect | null>(null);
  let host: { measure(): Promise<any> } | undefined;
  let webView: WebViewRef | undefined;
  let loadedFor = "";
  let streamed = false;
  const viewerReady = signal(false);
  props.bind((command) => webView?.postMessage(JSON.stringify(command)));
  const visible = computed(() => props.visible());
  effect(() => {
    if (!visible()) return;
    const revision = renew();
    const endpoint = backendUrl(); const bearer = backendBearer();
    const device = props.device;
    const hostKind = props.hostKind;
    const hubBasePath = props.hubBasePath;
    const wanted = JSON.stringify([endpoint, bearer, revision, hubBasePath, hostKind, device.hostId, device.id, device.platform, device.name]);
    if (wanted === loadedFor) return;
    if (loadedFor) {
      page.set(null);
      viewerReady.set(false);
      streamed = false;
      props.onReport({ t3: "viewer", status: "connecting", input: { connected: false, detail: null } });
    }
    const base = hubHttpBase(endpoint, hubBasePath);
    if (!base) { failure.set("The environment address is not available."); props.onNoVideo(); return; }
    let stale = false;
    failure.set("");
    void (async () => {
      try {
        const query: Record<string, string> = { hostId: device.hostId };
        if (bearer) query.wsTicket = await mintMediaTicket(endpoint, bearer);
        const access = { httpBase: base, query };
        const html = await buildViewerPage({
          platform: device.platform, deviceId: device.id, deviceName: device.name, serveSimOnly: hostKind === "simlock", access,
          keyboardAttached: untracked(props.keyboardAttached), foldAngle: untracked(props.foldAngle),
        });
        if (stale) return;
        loadedFor = wanted;
        streamed = false;
        viewerReady.set(false);
        page.set(html);
        props.onAccess(access);
      } catch (cause) { if (!stale) { failure.set(errorMessage(cause)); props.onNoVideo(); } }
    })();
    return () => { stale = true; };
  });
  // The WebView can take time to start after its HTML has been built. Give it a
  // separate startup deadline; only time the video once the page reports ready.
  const pageReady = computed(() => page() !== null);
  effect(() => {
    if (!visible() || !pageReady()) return;
    const ready = viewerReady();
    const timer = setTimeout(() => { if (!streamed) props.onNoVideo(); }, viewerFirstFrameMs() * (ready ? 1 : 2));
    return () => clearTimeout(timer);
  });
  effect(() => { const angle = props.foldAngle(); untracked(() => webView?.postMessage(JSON.stringify({ t3viewer: "foldAngle", angle }))); });
  const occluded = () => !visible() || (props.occluded ?? panelViewOccluded)(ownRect());
  return (
    <View ref={(node: any) => { host = node; }} onLayout={() => measureInto(host, ownRect)} class="min-h-0 min-w-0 flex-1 bg-background">
      {failure() ? <Text role="alert" class="px-3 py-2 text-xs text-destructive">{failure()}</Text> : null}
      {occluded() && !failure() ? <View class="min-h-0 flex-1 bg-background" /> : null}
      {page() && !failure() ? (
        <WebView
          ref={(node: WebViewRef) => { webView = node; }}
          html={page()!}
          class={occluded() ? "hidden bg-background" : "min-h-0 flex-1 bg-background"}
          onMessage={(event) => {
            const report = readViewerReport(event.data);
            if (!report) return;
            if (report.status === "streaming") streamed = true;
            if (report.ready) { viewerReady.set(true); props.onPageReady?.(); }
            if ((report as { sse?: string }).sse) { props.onSse?.(String((report as { sse?: string }).sse), (report as { data?: unknown }).data); return; }
            // One renewal per view; a hub that refuses the new ticket too gives way to the flat view.
            if (report.unauthorized) { if (renew() === 0) renew.set(1); else props.onNoVideo(); return; }
            props.onReport(report);
          }}
        />
      ) : null}
      {!page() && !failure() ? <Text class="px-3 py-2 text-xs text-muted-foreground">Connecting video…</Text> : null}
    </View>
  );
}
