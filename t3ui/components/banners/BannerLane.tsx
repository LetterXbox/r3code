// ChatBannerLane.tsx: the banners pinned under the header, over the top of the transcript: the provider status
// alert, then the thread error alert. Both are glass alerts centred in the chat column; the lane takes no touches
// itself so the find bar and the first rows stay reachable. Mounted once in ThreadView's chat column.
import { signal, View } from "nsh";
import { backendStatus, openThread, providerStatuses, rawProviderRecords, selectedModel, openSettings, setThreadError, threadLocalError } from "../../store";
import type { ProviderStatus, Thread } from "../../store";
import { LaneAlertCard } from "./BannerParts";
import { limitRecoveryActive, providerStatusAlert, providerStatusBannerKey, readCompatibilityAdvisory, threadErrorAlert } from "./bannerLogic";
import { copyAdminRequest, dismissProviderStatusBanner, dismissedProviderKey, dismissThreadError, openChatGptUsage, refreshProviderStatuses, threadErrorDismissTick } from "./bannerRuntime";
import { isThreadErrorBannerDismissedForSession, getThreadErrorBannerKey } from "../thread/timeline/threadError";

export interface BannerLaneProps {
  /** Test seams: the provider status the open thread's model selection resolves to, its raw snapshot, and the thread. */
  providerStatus?: () => ProviderStatus | null;
  rawProvider?: () => unknown;
  thread?: () => Thread | undefined;
  connected?: () => boolean;
  /** The lane's end inset (the reference's --chat-lane-inset-end: mini player and docked details card). */
  insetEnd?: () => number;
}

export function BannerLane(props: BannerLaneProps = {}) {
  const refreshing = signal(false);
  const thread = props.thread ?? (() => openThread());
  const connected = props.connected ?? (() => backendStatus() === "connected");
  const status = props.providerStatus ?? (() => providerStatuses().find((item) => item.instanceId === selectedModel()?.provider) ?? null);
  const raw = props.rawProvider ?? (() => { const id = status()?.instanceId; return rawProviderRecords().find((item) => item.instanceId === id) ?? null; });

  async function refresh() {
    const current = status();
    if (!current || refreshing()) return;
    refreshing.set(true);
    try { await refreshProviderStatuses({ instanceId: current.instanceId, refreshModels: true }); }
    catch { /* The banner stays; the next status push replaces it. */ }
    finally { refreshing.set(false); }
  }

  const providerAlert = () => !connected() ? null : providerStatusAlert({
    status: status(), advisory: readCompatibilityAdvisory(raw()), dismissedKey: dismissedProviderKey(), refreshing: refreshing(), canRefresh: true,
    onRefresh: () => void refresh(), onOpenSetup: () => openSettings("/settings/providers"),
    onDismiss: () => { const current = status(); dismissProviderStatusBanner(current ? providerKey(current) : null); },
  });
  const errorAlert = () => {
    threadErrorDismissTick();
    const current = thread();
    if (!current) return null;
    const shell = current.banner;
    // ChatView: a local send/rewind/fork error shows ahead of the server's lastError, and only the server's carries a class and code.
    const local = threadLocalError(current.id);
    const error = local ?? current.error ?? null;
    const errorSource = local !== null ? "local" : shell?.lastErrorAt ?? "server";
    return threadErrorAlert({
      error, errorClass: local === null ? shell?.lastErrorClass ?? null : null, errorCode: local === null ? shell?.lastErrorCode ?? null : null,
      limitRecoveryShown: limitRecoveryActive(shell),
      dismissed: isThreadErrorBannerDismissedForSession(getThreadErrorBannerKey(current.id, error, errorSource)),
      onCopyAdminRequest: copyAdminRequest, onOpenChatGptUsage: openChatGptUsage,
      onDismiss: () => { setThreadError(current.id, null); dismissThreadError(current.id, error, errorSource); },
    });
  };
  return (
    <View testID="Banner lane" class="absolute inset-x-0 top-0 z-30 flex-col" style={{ pointerEvents: "box-none", right: props.insetEnd?.() ?? 0 }}>
      <If when={providerAlert()}>{(alert) => <LaneAlertCard alert={alert} />}</If>
      <If when={errorAlert()}>{(alert) => <LaneAlertCard alert={alert} />}</If>
    </View>
  );
}

function providerKey(status: ProviderStatus): string | null {
  return providerStatusBannerKey(status, readCompatibilityAdvisory(rawProviderRecords().find((item) => item.instanceId === status.instanceId)));
}
