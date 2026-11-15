// ProviderAuthTerminal.tsx: the sign-in terminal. The app's Ghostty renderer (the terminal drawer's
// document) shows the raw PTY stream, escape sequences included, and sends raw key input and the
// terminal's size back as provider.auth terminal responses.
import { effect, openUrl, signal, Text, token, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { registeredOverlayOpen, webViewsUnderSurface } from "../../../components/rightPanel/nativeOcclusion";
import { loadTerminalDocument } from "../../../components/terminal/terminalDocument";
import { terminalResponseFor, terminalWrite, type TerminalResponse } from "./authTerminal";

export function ProviderAuthTerminal(props: { output: string; outputOffset?: number; onResponse: (response: TerminalResponse) => void }) {
  const document = signal<string | null>(null);
  const error = signal<string | null>(null);
  let view: WebViewRef | undefined;
  let ready = false;
  let written = 0;
  let pending: string[] = [];

  const post = (message: Record<string, unknown>) => {
    const text = JSON.stringify(message);
    if (ready && view) view.postMessage(text); else pending.push(text);
  };
  const sendTheme = () => {
    if (ready && view) view.postMessage(JSON.stringify({ type: "theme", background: token("terminal-background"), foreground: token("terminal-foreground"), cursor: token("terminal-cursor") }));
  };
  effect(() => { sendTheme(); });
  effect(() => {
    let active = true;
    void loadTerminalDocument().then((html) => { if (active) document.set(html); })
      .catch(() => { if (active) error.set("Could not load the sign-in terminal. Cancel and retry sign-in."); });
    return () => { active = false; };
  });
  // New output goes to the renderer as a tail; a rewound or skipped offset replays the whole buffer.
  effect(() => {
    const plan = terminalWrite(props.output, props.outputOffset, written);
    written = plan.offset;
    if (plan.write.kind === "append") post({ type: "output", data: plan.write.data });
    else if (plan.write.kind === "reset") post({ type: "reset", data: plan.write.data });
  });

  function onMessage(data: string) {
    let message: unknown;
    try { message = JSON.parse(data); } catch { return; }
    if (typeof message !== "object" || message === null) return;
    const item = message as Record<string, unknown>;
    if (item.type === "ready") {
      ready = true;
      sendTheme();
      for (const text of pending) view?.postMessage(text);
      pending = [];
    }
    if (item.type === "open-link") {
      if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) void openUrl(item.url).catch(() => error.set("Could not open the provider link."));
      return;
    }
    if (item.type === "error") { error.set("Could not load the sign-in terminal. Cancel and retry sign-in."); return; }
    const response = terminalResponseFor(item);
    if (response) props.onResponse(response);
  }

  // The terminal steps aside for a menu or dialog only where WebViews are drawn above the app (nativeOcclusion.ts).
  const steppedAside = () => registeredOverlayOpen() && !webViewsUnderSurface();
  return <View class="gap-2">
    <View accessibilityLabel="Provider sign-in terminal" testID="Provider sign-in terminal" class="relative h-64 overflow-hidden rounded-md border border-border bg-terminal-background">
      {steppedAside() ? <View class="flex-1 bg-terminal-background" testID="Provider sign-in terminal occluded" /> : null}
      {document() ? <WebView ref={(node) => { view = node; }} html={document() ?? ""} class={steppedAside() ? "hidden" : "flex-1"}
        onPress={() => view?.postMessage(JSON.stringify({ type: "focus" }))}
        onMessage={(event) => onMessage(event.data)} onError={() => error.set("Could not load the sign-in terminal. Cancel and retry sign-in.")} /> : null}
    </View>
    {error() ? <Text role="alert" class="text-xs text-destructive-foreground">{error()}</Text> : null}
  </View>;
}
