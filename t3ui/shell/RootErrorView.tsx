// RootRouteErrorView: what the window shows when rendering throws: "Something went wrong.", the message, Try again,
// Copy error and the error report. (The web's Reload app has no counterpart here: an NSH app cannot reload itself.)
import { Clipboard, ErrorBoundary, Image, Scroll, signal, Text, View } from "nsh";
import wordmark from "../components/sidebar-wordmark.svg";
import copyIcon from "../icons/copy.svg";
import checkIcon from "../icons/check.svg";
import { appVersionLabel } from "../pages/settings/StaticControls";
import { rootErrorMessage, rootErrorReport } from "./rootErrorReport";

function RootErrorView(props: { error: unknown; reset: () => void }) {
  const copied = signal(false);
  const report = rootErrorReport(props.error, { appName: "R3 Code", version: appVersionLabel(), path: "/" });
  return (
    <View class="flex-1 items-center justify-center bg-background px-6 py-10" accessibilityLabel="Something went wrong">
      <View class="w-full max-w-xl rounded-2xl border border-border bg-popover p-6">
        <View class="flex-row items-end gap-1.5">
          <Image src={wordmark} style={{ width: 20, height: 12, marginBottom: 7, tintColor: "#ffffff" }} />
          <Text class="text-lg font-medium text-muted-foreground">Code</Text>
        </View>
        <Text class="mt-6 text-xl font-semibold leading-tight text-foreground" role="header">Something went wrong.</Text>
        <Text class="mt-2 text-sm text-muted-foreground">{rootErrorMessage(props.error)}</Text>
        <View class="mt-5 flex-row flex-wrap gap-2">
          <View role="button" accessibilityLabel="Try again" onPress={props.reset} class="h-8 items-center justify-center rounded-lg bg-primary px-2.5 active:scale-[0.97] transition-transform duration-150 ease-in-out">
            <Text class="text-sm font-medium text-primary-foreground">Try again</Text>
          </View>
          <View
            role="button"
            accessibilityLabel={copied() ? "Copied" : "Copy error"}
            onPress={() => { void Clipboard.writeText(report).then(() => { copied.set(true); setTimeout(() => copied.set(false), 2000); }).catch(() => undefined); }}
            class="h-8 flex-row items-center justify-center gap-1.5 rounded-lg border border-input bg-popover px-2.5 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"
          >
            <Image src={copied() ? checkIcon : copyIcon} fadeDuration={0} style={{ width: 14, height: 14, tintColor: "#ffffff" }} />
            <Text class="text-sm font-medium text-foreground">{copied() ? "Copied" : "Copy error"}</Text>
          </View>
        </View>
        <View class="mt-5 overflow-hidden rounded-lg border border-border-70 bg-background">
          <Text class="px-3 py-1.5 text-xs font-medium text-muted-foreground">Error report</Text>
          <Scroll class="max-h-64 border-t border-border-70 px-3 py-2">
            <View selectable><Text class="text-xs text-foreground">{report}</Text></View>
          </Scroll>
        </View>
      </View>
    </View>
  );
}

/** Wraps the app: a render error shows the root error view instead of an empty window; Try again renders the app again. */
export function RootErrorBoundary(props: { children?: any }) {
  return <ErrorBoundary fallback={(error: unknown, reset: () => void) => <RootErrorView error={error} reset={reset} />}>{props.children}</ErrorBoundary>;
}
