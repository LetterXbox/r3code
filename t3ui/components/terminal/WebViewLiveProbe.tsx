// Reports whether this engine runs a WebView page's scripts. The headless test
// engine lays a WebView out but never loads its page, so it stays "waiting".
import { mount, signal, Text, View, WebView } from "nsh";

const state = signal("waiting");

mount(() => (
  <View class="flex-1">
    <Text>{state()}</Text>
    <WebView
      html="<!doctype html><html><body><script>window.nsh.postMessage('live')</script></body></html>"
      class="size-8"
      onMessage={(event) => { if (event.data === "live") state.set("webview-live"); }}
    />
  </View>
));
