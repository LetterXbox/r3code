// chat/TimelineToolActivityIcon.tsx: a tool call's own icon (website favicon, themed logo) drawn in the work entry's 16pt slot once it
// has loaded, the tool's kind mark until then and when it cannot load.
import { colorScheme, computed, effect, Image, signal, View } from "nsh";
import { IconSlot } from "../markdown/TimelineIcon";
import { toolIconImageUrl, type ToolIconFields } from "./toolIcon";
import { assetUrlFor } from "../../sidebar/projectIcon";
import { backendUrl, requestBackend } from "../../../store";

/** URLs that loaded once: a row drawn again shows its icon at once. */
const loaded = new Set<string>();

/** NativeAppToolActivityIcon: a native app's icon is the environment's native-app-icon asset, minted once per app. */
const nativeAppUrls = new Map<string, Promise<string | null>>();
export function nativeAppIconUrl(app: Record<string, unknown>, request: (method: string, payload: unknown) => Promise<unknown> = requestBackend, endpoint: () => string = backendUrl): Promise<string | null> {
  const key = JSON.stringify(app);
  let pending = nativeAppUrls.get(key);
  if (!pending) {
    pending = request("assets.createUrl", { resource: { _tag: "native-app-icon", app } })
      .then((value) => assetUrlFor(endpoint(), (value as { relativeUrl?: unknown } | null)?.relativeUrl), () => { nativeAppUrls.delete(key); return null; });
    nativeAppUrls.set(key, pending);
  }
  return pending;
}

export function ToolActivityIconView(props: { icon: () => ToolIconFields | undefined; fallback: () => string; muted?: boolean }) {
  const nativeUrl = signal<string | null>(null);
  effect(() => {
    const icon = props.icon();
    nativeUrl.set(null);
    if (icon?.tag !== "native-app" || !icon.app) return;
    let current = true;
    void nativeAppIconUrl(icon.app).then((value) => { if (current) nativeUrl.set(value); });
    return () => { current = false; };
  });
  const url = computed(() => { colorScheme(); return props.icon()?.tag === "native-app" ? nativeUrl() : toolIconImageUrl(props.icon(), colorScheme() === "dark"); });
  const shown = signal<string | null>(null);
  effect(() => {
    const target = url();
    if (target === null) { shown.set(null); return; }
    if (loaded.has(target) || target.startsWith("data:")) { shown.set(target); return; }
    shown.set(null);
    let current = true;
    Image.prefetch(target).then(() => { loaded.add(target); if (current) shown.set(target); }, () => { if (current) shown.set(null); });
    return () => { current = false; };
  });
  return (
    <View class="size-4 shrink-0 items-center justify-center">
      {shown() === null
        ? <IconSlot name={props.fallback()} size={16} />
        : (
          <View class="size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-background" accessibilityLabel="Tool icon">
            <Image src={shown() ?? ""} style={{ width: 16, height: 16, objectFit: "contain", opacity: props.muted === false ? 1 : 0.9 }} />
          </View>
        )}
    </View>
  );
}
