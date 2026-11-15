import { mount, signal, Text, View } from "nsh";
import { BannerLane } from "./BannerLane";
import { ComposerBannerStack } from "./ComposerBanners";
import { ThreadNow } from "./ThreadNow";
import { providerStatus, shellThread } from "./bannerFixtures";
import { branchMismatchItem, environmentUnavailableItem, extensionStatusItem, threadNowSlots, usageLimitRecoveryItem } from "./bannerLogic";
import { orderComposerBanners } from "./bannerLogic";
import { threadBannerFromShell } from "./threadBannerShell";
import { setThreadError, threadLocalError } from "../../store";
import type { Thread } from "../../store";
import type { BannerItem } from "./bannerTypes";

const raw = signal<unknown>(null);
const status = signal({ ...providerStatus, status: "error", authStatus: "unauthenticated", canAuthenticate: true });
const error = signal<string | undefined>(JSON.stringify({ error: { message: "Overloaded, retry later." } }));
const thread = (): Thread => ({ id: "thread-1", projectId: "p", title: "t", status: "idle", pinned: false, updatedAt: 0, error: error(), banner: threadBannerFromShell(shellThread({ lastErrorClass: "provider_error" })) });

const noop = () => {};
const log = signal<string[]>([]);
// Built in the composer's own order (recovery, extension status, environment, branch mismatch), then grouped.
const stackItems = (): BannerItem[] => orderComposerBanners([
  usageLimitRecoveryItem({ runId: "r", errorCode: null, resetAt: "2999-01-01T00:00:00.000Z", stoppedAt: "2026-01-01T00:00:00.000Z", settled: false, requestPending: false, snoozedUntil: null, recovery: null, now: 0, formatUpcoming: () => "later", pending: false, onToggle: (a) => log.update((l) => [...l, a]), onCopyAdminRequest: noop, onOpenChatGptUsage: noop }),
  extensionStatusItem([{ key: "a", text: "Indexing" }])!,
  environmentUnavailableItem({ status: "disconnected", label: "Local", error: null, graceElapsed: true, updateRunning: false, onReconnect: () => log.update((l) => [...l, "reconnect"]) })!,
  branchMismatchItem({ key: "k", mismatch: { threadBranch: "feature", currentBranch: "main" }, restoreDisabled: false, restoring: false, onRestore: () => log.update((l) => [...l, "restore"]), onDismiss: () => log.update((l) => [...l, "dismissed branch"]) }),
]);

const slots = () => threadNowSlots({
  shell: threadBannerFromShell(shellThread({ goal: { objective: "Ship the port", status: "paused" } })),
  sessionRuns: { runs: [], interrupts: [] }, isWorking: false, children: [{ id: "c", title: "Reviewer", sideChat: false, hasPendingApprovals: false }], parentAwaitingUser: false, threadId: "thread-1",
  canOperate: true, canForceStop: false, forceStopping: false, stoppingBackground: false, taskStartedAt: () => null, taskActivity: () => null,
  onSendCommand: (text) => log.update((l) => [...l, text]), onForceStop: noop, onStopBackground: noop, onOpenThread: (id) => log.update((l) => [...l, `open ${id}`]),
});

function Fixture() {
  return (
    <View class="relative h-[700px] w-[700px] bg-background">
      <BannerLane providerStatus={() => status()} rawProvider={() => raw()} thread={thread} connected={() => true} />
      <View class="mt-48"><ThreadNow slots={slots} /></View>
      <View class="mt-4"><ComposerBannerStack items={stackItems} /></View>
      <View accessibilityLabel="Fail a send" onPress={() => setThreadError("thread-1", "Failed to send message.")}><Text>fail</Text></View>
      <Text>{`local:${threadLocalError("thread-1") ?? "none"}`}</Text>
      <View testID="log">{log().map((entry) => <Text>{entry}</Text>)}</View>
    </View>
  );
}
mount(Fixture);
