// Counts how often each native web view is made. A WebView element made again is a new WKWebView: the page
// reloads and loses its scroll position, form input and history. Tests read the counts to assert that a web
// view survives a panel resize, a tab switch or an overlay opening; `ref={trackWebView(key, ...)}` feeds them.
import { signal, untracked } from "nsh";

const counts = signal<Record<string, number>>({});

/** How many times the web view named `key` was made (0: never). */
export function webViewMountCount(key: string): number {
  return counts()[key] ?? 0;
}

/** Every web view made so far, by key (tests print it). */
export function webViewMounts(): Record<string, number> {
  return counts();
}

/** Wraps a WebView's `ref` callback: counts one mount per node handed over, then calls `next`. */
export function trackWebView<T>(key: string, next?: (node: T) => void): (node: T) => void {
  return (node) => {
    // Deferred: a ref runs while its region is being made, and a signal written there could run that region again.
    if (node) queueMicrotask(() => untracked(() => counts.update((all) => ({ ...all, [key]: (all[key] ?? 0) + 1 }))));
    next?.(node);
  };
}
