// "This site can't be reached" (preview/PreviewUnreachable.tsx): shown in place of the page when it fails to load.
import { signal, Text, View } from "nsh";
import { DIcon } from "../device/DeviceIcons";
import { describePreviewError, previewErrorLabel, previewHost } from "./previewLogic";

// ErrorIcon (PreviewUnreachable.tsx:110-132): a crossed-out page, size-12 in muted-foreground/70.
const ErrorIcon = () => <View class="mb-6 opacity-70"><DIcon name="preview-error" size={48} /></View>;

/** PreviewFileNotShown (PreviewUnreachable.tsx:15-52): the page downloaded a file instead of rendering. The WebView has already
 * saved it (onDownload, the app's data directory), so the reference's Download link, which fetches a server-held copy, has no
 * counterpart here (the reference also omits it when it has no download URL). */
export function PreviewFileNotShown(props: { url: string; fileName: string; onOpen: () => void }) {
  return (
    <View class="min-h-0 w-full flex-1 bg-background px-8 py-12" accessibilityLabel="This file can't be shown here" testID="Preview file not shown">
      <View class="mx-auto w-full max-w-xl flex-1">
        <ErrorIcon />
        <Text class="mb-3 text-2xl font-semibold text-foreground">This file can’t be shown here</Text>
        <Text class="text-sm text-muted-foreground"><Text class="font-semibold text-foreground">{props.fileName}</Text>{` from ${previewHost(props.url)} was downloaded instead.`}</Text>
        <View class="mt-auto flex-row items-center gap-2 pt-8">
          <View class="flex-1" />
          <View role="button" accessibilityLabel="Open in browser" onPress={props.onOpen} class="h-7 items-center justify-center rounded-lg border border-input px-3 hover:bg-accent"><Text class="text-xs text-foreground">Open in browser</Text></View>
        </View>
      </View>
    </View>
  );
}

export function PreviewUnreachable(props: { move?: { label: string; onMove: () => void } | undefined; url: string; description: string; code?: string; onReload: () => void }) {
  const details = signal(false);
  const button = (label: string, onPress: () => void, primary = false) => (
    <View role="button" accessibilityLabel={label} onPress={onPress} class={`h-7 items-center justify-center rounded-lg px-3 ${primary ? "bg-primary" : "border border-input hover:bg-accent"}`}>
      <Text class={`text-xs ${primary ? "text-primary-foreground" : "text-foreground"}`}>{label}</Text>
    </View>
  );
  return (
    <View class="min-h-0 w-full flex-1 bg-background px-8 py-12" accessibilityLabel="This site can't be reached" testID="Preview unreachable">
      <View class="mx-auto w-full max-w-xl flex-1">
        <ErrorIcon />
        <Text class="mb-3 text-2xl font-semibold text-foreground">This site can’t be reached</Text>
        <Text class="text-sm text-muted-foreground"><Text class="font-semibold text-foreground">{previewHost(props.url)}</Text>{`: ${describePreviewError(props.description)}.`}</Text>
        {details() ? (
          <View class="mt-6 gap-1 rounded-lg border border-border bg-muted-40 p-4" accessibilityLabel="Details">
            <Text class="mb-1 text-sm font-medium text-foreground">Try:</Text>
            <Text class="text-sm text-muted-foreground">Checking your connection</Text>
            <Text class="text-sm text-muted-foreground">Confirming the dev server is running</Text>
            <Text class="text-sm text-muted-foreground">Checking the proxy and the firewall</Text>
          </View>
        ) : null}
        <Text class="mt-8 text-xs uppercase text-muted-foreground">{previewErrorLabel(props.description, props.code)}</Text>
        <View class="mt-auto flex-row items-center gap-2 pt-8">
          {button(details() ? "Hide details" : "Details", () => details.update((value) => !value))}
          <View class="flex-1" />
          {/* PreviewUnreachable.tsx:100-106: Move tab, outline, before Reload. */}
          {props.move ? button(props.move.label, props.move.onMove) : null}
          {button("Reload", props.onReload, true)}
        </View>
      </View>
    </View>
  );
}
