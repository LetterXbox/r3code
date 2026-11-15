// The toast host's extras: the anchored "Copied!" popup under a button, a thread notification with its status mark and Open thread
// action, and the slow requests toast with its expandable list.
import { mount, signal, Text, View } from "nsh";
import { showAnchoredCopyErrorToast, showAnchoredCopySuccessToast } from "./components/toast";
import { showToast } from "./components/toast/toastState";
import { slowRpcToast } from "./components/coordinators/rpcLatency";
import { notificationToastView } from "./components/coordinators/threadNotifications.logic";
import { ShellOverlays } from "./shell/ShellOverlays";
import { PairingPendingSurface, PairingRouteSurface } from "./environments/StandalonePages";

const pairing = signal<"" | "form" | "pending" | "error">("");

const log = signal<string[]>([]);
let anchor: any;

mount(() => (
  <View class="flex-1 items-center pt-40">
    <View
      role="button"
      accessibilityLabel="Copy path"
      ref={(node: any) => { anchor = node; }}
      onPress={() => { void showAnchoredCopySuccessToast(anchor); }}
      class="h-8 items-center justify-center rounded-md border border-input px-3"
    >
      <Text>Copy path</Text>
    </View>
    <View role="button" accessibilityLabel="Copy fails" onPress={() => { void showAnchoredCopyErrorToast(anchor, new Error("Clipboard is unavailable")); }}><Text>Copy fails</Text></View>
    <View role="button" accessibilityLabel="Notify" onPress={() => {
      const view = notificationToastView("input", "approval");
      showToast({ type: view.type, title: view.title, description: "Fix the build", hideCopyButton: true, leadingIcon: view.leadingIcon, timeoutMs: 0, actions: [{ label: "Open thread", run: () => log.update((all) => [...all, "open thread-1"]) }] });
    }}><Text>Notify</Text></View>
    <View role="button" accessibilityLabel="Slow" onPress={() => {
      showToast(slowRpcToast([{ requestId: "r1", startedAt: "2026-11-11T10:00:00.000Z", startedAtMs: 0, tag: "server.getConfig", thresholdMs: 15000 }]));
    }}><Text>Slow</Text></View>
    {/* One button per toast variant of ui/toast.tsx, for the hover/toast parity shots (workspace/visual/hovertoast). */}
    <View role="button" accessibilityLabel="Variant success" onPress={() => { showToast({ type: "success", title: "Thread copied", description: "The thread link is on the clipboard.", timeoutMs: 0 }); }}><Text>Variant success</Text></View>
    <View role="button" accessibilityLabel="Variant error" onPress={() => { showToast({ type: "error", title: "Could not send message", description: "The server closed the connection before the turn started.", timeoutMs: 0 }); }}><Text>Variant error</Text></View>
    <View role="button" accessibilityLabel="Variant info" onPress={() => { showToast({ type: "info", title: "Appearance: Dark", timeoutMs: 0 }); }}><Text>Variant info</Text></View>
    <View role="button" accessibilityLabel="Variant warning" onPress={() => { showToast({ type: "warning", title: "Keybindings file has errors", description: "Two bindings were skipped.", timeoutMs: 0 }); }}><Text>Variant warning</Text></View>
    <View role="button" accessibilityLabel="Variant loading" onPress={() => { showToast({ type: "loading", title: "Cloning repository" }); }}><Text>Variant loading</Text></View>
    <View role="button" accessibilityLabel="Variant action" onPress={() => { showToast({ type: "error", title: "Send failed", description: "The provider refused the request.", hideCopyButton: true, timeoutMs: 0, actions: [{ label: "Retry", run: () => log.update((all) => [...all, "retry"]) }] }); }}><Text>Variant action</Text></View>
    <View role="button" accessibilityLabel="Variant title only" onPress={() => { showToast({ type: "success", title: "Saved", timeoutMs: 0 }); }}><Text>Variant title only</Text></View>
    <View role="button" accessibilityLabel="Show pairing" onPress={() => pairing.set("form")}><Text>Show pairing</Text></View>
    <View role="button" accessibilityLabel="Show pairing pending" onPress={() => pairing.set("pending")}><Text>Show pairing pending</Text></View>
    <View role="button" accessibilityLabel="Show pairing error" onPress={() => pairing.set("error")}><Text>Show pairing error</Text></View>
    <Each of={log()} key={(line, index) => `${index}${line}`}>{(line) => <Text>{`log ${line()}`}</Text>}</Each>
    <ShellOverlays />
    {pairing() === "form" ? <PairingRouteSurface /> : pairing() === "pending" ? <PairingPendingSurface /> : pairing() === "error" ? <PairingRouteSurface errorMessage="Authentication failed." /> : null}
  </View>
));
