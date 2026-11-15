// The browser surface's empty state (preview/PreviewEmptyState.tsx, PreviewRecentUrlCard.tsx,
// PreviewLocalServerCard.tsx, PreviewFaviconIcon.tsx): "Recently used" pages and the "Local servers" the
// environment reports (`subscribeDiscoveredLocalServers`), else the plain "No preview yet" copy.
import { computed, effect, Image, Scroll, signal, Storage, Text, View } from "nsh";
import { allProjects, backendStatus, backendUrl, openThread, subscribeBackend } from "../../store";
import { HIcon } from "../header/HeaderIcons";
import { retryingStream } from "../../environments/environmentSession";
import { sidebarRelativeTime } from "../SidebarUtils";
import { boundConfiguredLocalServerUrls, configuredPreviewUrls, evictExcessProjects, faviconUrl, mergeServers, readDiscoveredServers, recentEntries, recentLabel, recordVisit, type BrowserHistoryEntry } from "./previewLogic";

const HISTORY_KEY = "browserHistory";
// browserHistoryStore.ts: recents are kept per project (50 each, the 20 most recent projects). A copy saved before that
// (one list for every project) is read as the recents of threads without a project.
const NO_PROJECT = "";
const historyByProject = signal<Record<string, BrowserHistoryEntry[]>>({});
let historyLoaded = false;

const projectKey = () => openThread()?.projectId ?? NO_PROJECT;
const history = () => historyByProject()[projectKey()] ?? [];
const environmentHostname = () => (URL.canParse(backendUrl()) ? new URL(backendUrl()).hostname : null);
const validEntries = (value: unknown): BrowserHistoryEntry[] => (Array.isArray(value) ? value.filter((item): item is BrowserHistoryEntry => typeof item === "object" && item !== null && typeof (item as BrowserHistoryEntry).url === "string" && typeof (item as BrowserHistoryEntry).lastVisitedAt === "number" && Number.isFinite((item as BrowserHistoryEntry).lastVisitedAt)) : []);

function persistHistory() { void Storage.setItem(HISTORY_KEY, JSON.stringify({ byProjectKey: historyByProject() })).catch(() => {}); }

void Storage.getItem(HISTORY_KEY).then((text) => {
  if (historyLoaded || !text) return;
  try {
    const parsed: unknown = JSON.parse(text);
    const saved: Record<string, BrowserHistoryEntry[]> = Array.isArray(parsed)
      ? { [NO_PROJECT]: validEntries(parsed) }
      : typeof parsed === "object" && parsed !== null && typeof (parsed as { byProjectKey?: unknown }).byProjectKey === "object" && (parsed as { byProjectKey?: unknown }).byProjectKey !== null
        ? Object.fromEntries(Object.entries((parsed as { byProjectKey: Record<string, unknown> }).byProjectKey).map(([key, list]) => [key, validEntries(list)]))
        : {};
    historyByProject.update((current) => {
      const merged: Record<string, BrowserHistoryEntry[]> = { ...saved };
      for (const [key, list] of Object.entries(current)) merged[key] = [...list, ...(saved[key] ?? []).filter((entry) => !list.some((item) => item.url === entry.url))];
      return evictExcessProjects(merged);
    });
  } catch { /* an unreadable copy is ignored */ }
}).catch(() => {}).finally(() => { historyLoaded = true; });

/** A page was opened in a browser tab (and, once it loads, its title). */
export function recordBrowserVisit(url: string, title?: string) {
  historyLoaded = true;
  const key = projectKey();
  historyByProject.update((all) => evictExcessProjects({ ...all, [key]: recordVisit(all[key] ?? [], url, Date.now(), title, environmentHostname()) }));
  persistHistory();
}

/** removeUrlForThread: drops one recent of this project. */
export function removeBrowserVisit(url: string) {
  historyLoaded = true;
  const key = projectKey();
  historyByProject.update((all) => ({ ...all, [key]: (all[key] ?? []).filter((entry) => entry.url !== url) }));
  persistHistory();
}

// browserFaviconStore / usePreviewBridge: the icon a page reports (<link rel="icon">) is remembered by page and by site,
// on this device; the icon sources are tried in order (the page's, the site's, /favicon.ico) and a failed one is dropped.
const FAVICON_KEY = "browserFavicons:v1";
const FAVICON_MAX = 300;
const reportedFavicons = signal<Record<string, string>>({});
let faviconsLoaded = false;
void Storage.getItem(FAVICON_KEY).then((text) => {
  if (faviconsLoaded || !text) return;
  try { const parsed = JSON.parse(text) as Record<string, unknown>; reportedFavicons.set({ ...Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")), ...reportedFavicons() }); } catch { /* ignored */ }
}).catch(() => {}).finally(() => { faviconsLoaded = true; });
const pageKey = (url: string) => { if (!URL.canParse(url)) return null; const parsed = new URL(url); parsed.hash = ""; return parsed.href; };
const siteKey = (url: string) => (URL.canParse(url) ? new URL(url).origin : null);

/** A page reported its icon (previewLinks.ts parseFaviconMessage). */
export function recordPageFavicon(page: string, href: string) {
  const byPage = pageKey(page); const bySite = siteKey(page);
  if (!byPage || !bySite) return;
  faviconsLoaded = true;
  const next = { ...reportedFavicons(), [byPage]: href, [bySite]: href };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - FAVICON_MAX))) delete next[key];
  reportedFavicons.set(next);
  void Storage.setItem(FAVICON_KEY, JSON.stringify(next)).catch(() => {});
}

/** The icon sources for a page, in order, without duplicates. */
export function faviconSources(url: string): string[] {
  const all = reportedFavicons();
  const byPage = pageKey(url); const bySite = siteKey(url);
  return [...new Set([byPage ? all[byPage] : undefined, bySite ? all[bySite] : undefined, faviconUrl(url) ?? undefined].filter((value): value is string => !!value))];
}

/** The site's favicon, or a globe while it has none. */
export function FaviconIcon(props: { url: string; size?: number }) {
  const failed = signal<string[]>([]);
  const src = () => faviconSources(props.url).find((source) => !failed().includes(source)) ?? null;
  const size = props.size ?? 16;
  return (
    <>
      {src() === null
        ? <HIcon name="globe" size={size} />
        : <Image src={src() ?? ""} fadeDuration={0} accessibilityLabel="Site icon" onError={() => { const bad = src(); if (bad) failed.update((all) => [...all, bad]); }} style={{ width: size, height: size }} />}
    </>
  );
}

/** BrowserMockup.tsx: the window thumbnail a discovered page shows until it has a favicon. */
export function BrowserMockup() {
  return (
    <View class="size-7 shrink-0 flex-col gap-0.5 overflow-hidden rounded-sm border border-border-60 bg-card p-1" accessibilityLabel="Browser window">
      <View class="flex-row gap-0.5">
        <View class="size-[3px] rounded-full bg-destructive" style={{ opacity: 0.8 }} />
        <View class="size-[3px] rounded-full bg-warning" style={{ opacity: 0.8 }} />
        <View class="size-[3px] rounded-full bg-success" style={{ opacity: 0.8 }} />
      </View>
      <View class="mt-px flex-1 gap-0.5">
        <View class="h-[2px] w-full rounded-full bg-muted-foreground" style={{ opacity: 0.3 }} />
        <View class="h-[2px] w-3/5 rounded-full bg-muted-foreground" style={{ opacity: 0.2 }} />
      </View>
    </View>
  );
}

/** PreviewFaviconIcon: the page's favicon at 28pt, the window thumbnail while it has none. */
function RowIcon(props: { url: string }) {
  const failed = signal<string[]>([]);
  const src = () => faviconSources(props.url).find((source) => !failed().includes(source)) ?? null;
  return (
    <>
      {src() === null
        ? <BrowserMockup />
        : <Image src={src() ?? ""} fadeDuration={0} accessibilityLabel="Site icon" onError={() => { const bad = src(); if (bad) failed.update((all) => [...all, bad]); }} style={{ width: 28, height: 28 }} />}
    </>
  );
}

function Row(props: { label: string; icon: string; title: string; description: string; onOpen: () => void; onRemove?: () => void; url: string }) {
  return (
    <View class="relative w-full flex-row items-center border-t border-border-60">
      <View role="button" accessibilityLabel={props.label} onPress={props.onOpen} class="w-full flex-row items-center gap-3 px-3 py-3 pr-10 hover:bg-accent-50">
        <RowIcon url={props.url} />
        <View class="min-w-0 flex-1">
          <Text class="truncate text-sm font-medium text-foreground">{props.title}</Text>
          <Text class="truncate text-xs text-muted-foreground">{props.description}</Text>
        </View>
      </View>
      {props.onRemove ? (
        <View role="button" accessibilityLabel={`Remove ${recentLabel(props.url)} from history`} onPress={props.onRemove} class="absolute right-3 rounded p-1 hover:bg-accent"><HIcon name="x" size={14} /></View>
      ) : null}
    </View>
  );
}

export function PreviewEmptyState(props: { configuredUrls?: readonly string[]; onOpenUrl: (url: string) => void }) {
  const found = signal<{ host: string; port: number; url: string; processName: string | null }[]>([]);
  const probing = signal(true);
  // PreviewPanel: the configured URLs are the open project's script previewUrls, bounded before they reach the scan.
  // A joined key, so a shell update that leaves the URL set as it was does not restart the scan subscription.
  const configuredKey = computed(() => boundConfiguredLocalServerUrls(props.configuredUrls ?? configuredPreviewUrls(allProjects().find((project) => project.id === openThread()?.projectId)?.scripts)).join("\n"));
  const configuredUrls = () => (configuredKey() === "" ? [] : configuredKey().split("\n"));
  effect(() => {
    const connected = backendStatus() === "connected";
    void backendUrl();
    if (!connected) { found.set([]); return; }
    const urls = configuredUrls();
    // Failures leave the list as it was: the empty state must not show an error for a scan.
    // state/preview.ts discoveredLocalServers is a retried stream: an error or end resubscribes (250 ms .. 30 s).
    return retryingStream(subscribeBackend, "subscribeDiscoveredLocalServers", urls.length ? { configuredUrls: urls } : {}, (value) => { const read = readDiscoveredServers(value); found.set(read.servers); probing.set(read.configuredUrlProbing); });
  });
  const servers = () => mergeServers(found(), configuredUrls(), probing());
  const recents = () => recentEntries(history());
  return (
    <>
      {servers().length === 0 && recents().length === 0 ? (
        <View class="min-h-0 flex-1 items-center justify-center px-6" accessibilityLabel="No preview yet">
          <HIcon name="globe" size={18} />
          <Text class="mt-2 text-sm font-medium text-foreground">No preview yet</Text>
          <Text class="mt-1 max-w-xs text-center text-xs text-muted-foreground">Type a URL above, or run a dev script. Local servers this thread starts will show up here automatically.</Text>
        </View>
      ) : (
        <Scroll class="min-h-0 flex-1" contentClass="w-full px-5 py-8">
          <View class="mx-auto w-full max-w-xl gap-6">
          {recents().length > 0 ? (
            <View class="gap-3" accessibilityLabel="Recently used">
              <View class="flex-row items-center gap-2"><HIcon name="history" size={16} /><Text class="text-sm font-medium text-muted-foreground">Recently used</Text></View>
              <View class="overflow-hidden rounded-xl border border-border-70 bg-background">
                <View class="-mt-px"><Each of={recents()} key={(entry) => entry.url}>
                  {(entry) => (
                    <Row
                      url={entry().url}
                      label={`Open ${recentLabel(entry().url)}`}
                      icon="globe"
                      title={entry().title ?? recentLabel(entry().url)}
                      description={`${entry().title ? `${recentLabel(entry().url)} · ` : ""}${sidebarRelativeTime(entry().lastVisitedAt)}`}
                      onOpen={() => props.onOpenUrl(entry().url)}
                      onRemove={() => removeBrowserVisit(entry().url)}
                    />
                  )}
                </Each>
                </View>
              </View>
            </View>
          ) : null}
          {servers().length > 0 ? (
            <View class="gap-3" accessibilityLabel="Local servers">
              <View class="flex-row items-center gap-2"><HIcon name="radio-tower" size={16} /><Text class="text-sm font-medium text-muted-foreground">Local servers</Text></View>
              <View class="overflow-hidden rounded-xl border border-border-70 bg-background">
                <View class="-mt-px"><Each of={servers()} key={(server) => `${server.host}:${server.port}`}>
                  {(server) => <Row url={server().requestedUrl} label={`Open ${server().host}:${server().port}`} icon="globe" title={server().processName ?? "Listening"} description={`${server().host}:${server().port}`} onOpen={() => props.onOpenUrl(server().requestedUrl)} />}
                </Each>
                </View>
              </View>
              <Text class="px-1 text-xs text-muted-foreground">Select a live local server to open it in this browser tab.</Text>
            </View>
          ) : null}
          </View>
        </Scroll>
      )}
    </>
  );
}
