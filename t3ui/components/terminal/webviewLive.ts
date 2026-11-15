import { open } from "nsh/test";

/**
 * Whether the engine running the tests executes WebView pages. The headless
 * engine does not (a WebView is laid out but its page never loads), so tests
 * that need the real terminal renderer only run under `nsh test --target <window>`.
 * Only a timeout counts as "not live"; any other failure (a missing probe, a
 * bundle error) is rethrown so it cannot silently skip the real checks.
 */
export async function webViewLive(): Promise<boolean> {
  const app = await open("./components/terminal/WebViewLiveProbe.tsx", { width: 200, height: 100 });
  try {
    await app.waitFor("text:webview-live", { timeout: 5000 });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ETIMEDOUT") return false;
    throw error;
  }
}
