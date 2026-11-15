import { mount, signal, Text, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { loadTerminalDocument } from "./components/terminal/terminalDocument";

let view: WebViewRef | undefined;
const state = signal("loading");
const document = signal<string | null>(null);
void loadTerminalDocument().then((html) => document.set(html)).catch((error: unknown) => state.set(`error:${String(error)}`));

mount(() => (
  <View class="flex-1">
    <Text>{state()}</Text>
    <View accessibilityLabel="Send test key" onPress={() => view?.injectJavaScript(`document.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));`)}><Text>Send test key</Text></View>
    <View accessibilityLabel="Send test control key" onPress={() => view?.injectJavaScript(`document.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true }));`)}><Text>Send test control key</Text></View>
    {document() ? <WebView
      ref={(node) => { view = node; }}
      accessibilityLabel="Terminal canvas"
      onPress={() => view?.postMessage(JSON.stringify({ type: "focus" }))}
      html={document() ?? ""}
      class="flex-1"
      onMessage={(event) => {
        const message = JSON.parse(event.data);
        if (message.type === "ready") {
          view?.postMessage(JSON.stringify({ type: "reset", data: "Terminal test" }));
          view?.injectJavaScript(`requestAnimationFrame(() => requestAnimationFrame(() => {
            const canvas = document.querySelector('canvas');
            const pixels = canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
            let lit = 0;
            if (pixels) for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 400) lit++;
            window.nsh.postMessage(JSON.stringify({type: 'painted', lit}));
          }));`);
        } else if (message.type === "painted") state.set(message.lit > 0 ? "painted" : "blank");
        else if (message.type === "input") state.set(message.data === "\u0003" ? "input:ctrl-c" : `input:${message.data}`);
        else if (message.type === "error") state.set(`error:${message.message}`);
      }}
      onError={(event) => state.set(`error:${event.message}`)}
    /> : null}
  </View>
));
