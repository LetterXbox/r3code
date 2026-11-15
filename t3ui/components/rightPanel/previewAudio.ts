// A browser tab's sound: the speaker button of its tab and the "Mute tab" menu item (RightPanelTabs.tsx tabAudioState,
// tabMuteMenuItem). The reference mutes the Electron guest with `webContents.setAudioMuted` and learns that it is audible from
// the guest's audio events. The NSH WebView has no audio API (WebViewRef: reload, goBack, goForward, stopLoading,
// injectJavaScript, postMessage, sendInput), so the page is reached through script instead: every <audio> and <video> element is
// muted and watched, which covers pages that play through media elements. Web Audio contexts and media inside cross-origin
// frames are not reachable from the page's own script and stay audible.
import { signal, untracked } from "nsh";

export type TabAudioState = "none" | "audible" | "muted";

interface TabAudio { audible: boolean; muted: boolean; ready: boolean }

const tabs = signal<Record<string, TabAudio>>({});
const controllers = new Map<string, (muted: boolean) => void>();

const read = (id: string): TabAudio => tabs()[id] ?? { audible: false, muted: false, ready: false };
const write = (id: string, patch: Partial<TabAudio>) => tabs.update((all) => ({ ...all, [id]: { ...(all[id] ?? { audible: false, muted: false, ready: false }), ...patch } }));

/** tabAudioState: nothing shows until the page makes sound; then the speaker, crossed out while the tab is muted. */
export function tabAudioState(id: string): TabAudioState {
  const tab = read(id);
  if (!tab.audible) return "none";
  return tab.muted ? "muted" : "audible";
}

export const isTabMuted = (id: string): boolean => read(id).muted;
/** Mute is offered once the tab's page exists to mute. */
export const isTabAudioReady = (id: string): boolean => read(id).ready;

/** The browser tab registers how to mute its page; returns the release. */
export function registerTabAudio(id: string, setMuted: (muted: boolean) => void): () => void {
  controllers.set(id, setMuted);
  // Read untracked: the browser tab registers from an effect that must not re-run each time the tab's sound state changes.
  untracked(() => { write(id, { ready: true }); setMuted(read(id).muted); });
  return () => {
    if (controllers.get(id) === setMuted) controllers.delete(id);
    write(id, { ready: false, audible: false });
  };
}

/** setAudioMuted: the speaker button and the menu item. */
export function setTabMuted(id: string, muted: boolean) {
  if (!controllers.has(id)) return;
  write(id, { muted });
  controllers.get(id)?.(muted);
}

export function reportTabAudible(id: string, audible: boolean) {
  if (read(id).audible !== audible) write(id, { audible });
}

/** The page's report (`window.nsh.postMessage`): true or false for audible, null for anything else a page may post. */
export function parseAudioMessage(data: string): boolean | null {
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null) return null;
    const entry = message as { t3?: unknown; audible?: unknown };
    return entry.t3 === "audio" && typeof entry.audible === "boolean" ? entry.audible : null;
  } catch {
    return null;
  }
}

/** Runs before a page's own scripts (`injectedJavaScriptBeforeContentLoaded`), and again to change the state of a loaded page. */
export function audioScript(muted: boolean): string {
  return `(function () {
  try {
    if (window.__t3Audio) { window.__t3Audio.set(${muted ? "true" : "false"}); return; }
    var muted = ${muted ? "true" : "false"}, last = null, tracked = [];
    function post(audible) {
      if (audible === last) return;
      last = audible;
      try { window.nsh.postMessage(JSON.stringify({ t3: "audio", audible: audible })); } catch (e) {}
    }
    function pageMuted(el) { return el.__t3Muted ? el.__t3Muted.page : el.muted; }
    function sync(el) {
      if (muted) {
        if (!el.__t3Muted) el.__t3Muted = { page: el.muted };
        if (!el.muted) el.muted = true;
      } else if (el.__t3Muted) {
        var was = el.__t3Muted.page;
        delete el.__t3Muted;
        el.muted = was;
      }
    }
    function report() {
      var any = false;
      for (var i = 0; i < tracked.length; i++) {
        var el = tracked[i];
        if (!el.paused && !el.ended && el.readyState > 2 && !pageMuted(el) && el.volume > 0) any = true;
      }
      post(any);
    }
    function track(el) {
      if (el.__t3Tracked) return;
      el.__t3Tracked = true;
      tracked.push(el);
      ["play", "playing", "pause", "ended", "emptied", "volumechange"].forEach(function (name) {
        el.addEventListener(name, function () {
          if (name === "volumechange" && el.__t3Muted && !el.muted) { el.__t3Muted.page = false; el.muted = true; }
          report();
        });
      });
      sync(el);
      report();
    }
    function scan(root) {
      if (!root || !root.querySelectorAll) return;
      var list = root.querySelectorAll("audio,video");
      for (var i = 0; i < list.length; i++) track(list[i]);
    }
    var play = window.HTMLMediaElement && HTMLMediaElement.prototype.play;
    if (play) HTMLMediaElement.prototype.play = function () { track(this); return play.apply(this, arguments); };
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === "AUDIO" || node.tagName === "VIDEO") track(node);
          scan(node);
        }
      }
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", function () { scan(document); });
    window.__t3Audio = { set: function (value) { muted = value; tracked.forEach(sync); report(); } };
    scan(document);
  } catch (e) {}
})(); true;`;
}
