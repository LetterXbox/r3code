// ThreadNow.tsx: the lines of thread state at the end of the timeline (what needs you, background work or a Stop, the
// goal), each one line like ThreadStatusLine: icon, title with its detail dimmed, an elapsed readout, then actions.
// Mount it in ThreadView just above ThreadStatusLine.
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../../backend/sessionScopes";
import { computed, Text, token, View } from "nsh";
import { createHover } from "../hoverReveal";
import { allThreads, openThread, openThreadById, threadWorking } from "../../store";
import { chatWidthClass } from "../thread/layout";
import { enterStyle } from "../motion/Motion";
import { fadeInStart } from "../motion/motionTokens";
import { BannerActionButton, BannerTip, Elapsed } from "./BannerParts";
import { BannerIcon } from "./BannerIcon";
import { threadNowSlots, isBackgroundWorkStopPending, type ThreadNowItem, type ThreadNowSlots } from "./bannerLogic";
import { backgroundStopFor, forceStoppingThreadId, forceStopThread, sendGoalCommand, stopBackgroundWork } from "./bannerRuntime";
import { childThreadInputs } from "./childInputs";
import { threadSessionState } from "./threadSessionState";
import { serverEnvironmentCapabilities } from "./serverCaps";

function ThreadNowLine(props: { item: () => ThreadNowItem; announce?: boolean }) {
  const item = () => props.item();
  const tint = () => (item().tone === "info" ? token("info-foreground") : item().tone === "warning" ? token("warning-foreground") : token("muted-foreground"));
  return (
    <View class="shrink-0 px-3">
      <View
        role={props.announce ? "alert" : undefined}
        testID="Thread now line"
        accessibilityLabel={item().title}
        class={`mx-auto w-full ${chatWidthClass()} min-w-0 flex-row items-baseline gap-1.5 px-1 pb-2`}
        // ThreadNow.tsx:24 `transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none`.
        style={enterStyle(fadeInStart)}
      >
        <View class="size-3.5 shrink-0 self-center items-center justify-center"><BannerIcon name={item().icon} size={14} tint={tint()} /></View>
        <View class="min-w-0 shrink flex-row items-baseline gap-1" tooltip={<BannerTip text={`${item().title}${item().description ? ` ${item().description}` : ""}`} />}>
          <Text class="min-w-0 shrink truncate text-xs text-muted-foreground">{item().title}</Text>
          {item().description ? <Text class="min-w-0 shrink truncate text-xs text-muted-foreground-80">{item().description}</Text> : null}
          <Each of={item().threads ?? []} key={(thread) => thread.id}>
            {(thread) => {
              const hover = createHover();
              return (
                <View role="button" accessibilityLabel={thread().title} onPress={() => openThreadById(thread().id)} class="shrink-0" {...hover.bind}>
                  <Text class={`text-xs font-medium text-muted-foreground ${hover.hovered() ? "underline" : ""}`}>{thread().title}</Text>
                </View>
              );
            }}
          </Each>
        </View>
        <View class="ml-1.5 shrink-0 flex-row items-baseline gap-2.5">
          {item().elapsedSince ? <Elapsed since={() => item().elapsedSince} /> : null}
          <Each of={item().actions} key={(action) => action.id}>{(action) => <BannerActionButton action={action()} surface="notice" />}</Each>
        </View>
      </View>
    </View>
  );
}

/** The slots for the open thread, from the store's shell fields and the session state. */
export function openThreadNowSlots(): ThreadNowSlots {
  const thread = openThread();
  if (!thread) return { attention: null, work: null, goal: null };
  const shell = thread.banner;
  const session = threadSessionState();
  const threadKey = thread.id;
  const tasks = shell?.pendingBackgroundTasks ?? [];
  const stopping = isBackgroundWorkStopPending(backgroundStopFor(threadKey), threadKey, tasks, (() => { const retry = backgroundStopFor(threadKey)?.retryAt; return retry != null && retry <= Date.now(); })());
  return threadNowSlots({
    shell, sessionRuns: session, isWorking: threadWorking(),
    children: childThreadInputs(allThreads(), thread.id),
    parentAwaitingUser: thread.meta?.pendingRequestKind != null || shell?.hasPendingUserInput === true,
    threadId: thread.id, canOperate: scopeAllows(ORCHESTRATION_OPERATE_SCOPE),
    canForceStop: serverEnvironmentCapabilities().threadForceStop === true, forceStopping: forceStoppingThreadId() === thread.id, stoppingBackground: stopping,
    taskStartedAt: (id) => session.tasks[id]?.startedAt ?? null, taskActivity: (id) => session.tasks[id]?.progress ?? null,
    onSendCommand: (text, failure) => void sendGoalCommand(text, failure),
    onForceStop: (runId) => void forceStopThread(thread.id, runId),
    onStopBackground: () => void stopBackgroundWork(threadKey, tasks.map((task) => task.taskId)),
    onOpenThread: openThreadById,
  });
}

export function ThreadNow(props: { slots?: () => ThreadNowSlots } = {}) {
  const slots = computed(() => (props.slots ? props.slots() : openThreadNowSlots()));
  return (
    <>
      <If when={slots().attention}>{(item) => <ThreadNowLine item={item} announce />}</If>
      <If when={slots().work}>{(item) => <ThreadNowLine item={item} />}</If>
      <If when={slots().goal}>{(item) => <ThreadNowLine item={item} />}</If>
    </>
  );
}
