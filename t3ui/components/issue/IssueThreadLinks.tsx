// Threads linked to an issue and thread picker using accent-folded search (#39557, IssueThreadLinks.tsx).
import { effect, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../../backend/sessionScopes";
import { requestBackend } from "../../store";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "../pullRequest/PRIcon";
import { threadPickerCandidates } from "../pullRequest/pullRequestThreadLinks.logic";
import { showToast } from "../toast";
import { threadIssueKeyOf, type IssueDetail, type IssueLinkedThread, type IssueRef } from "./issueLogic";
import { cachedIssueLinkedThreads, issueLinkedThreadsSupported, loadIssueLinkedThreads, type RequestFn } from "./issueStore";

export interface IssuePickerThread {
  id: string;
  title: string;
  projectId: string;
  updatedAt: number;
}

export function issueLinkCommand(
  threadId: string,
  target: IssueRef & { host: string; url: string; displayKey: string; title: string },
  linked: boolean,
) {
  const key = { tracker: target.tracker, host: target.host, scope: target.scope, key: target.key };
  return linked
    ? {
        type: "thread.issue.link" as const,
        threadId,
        ...key,
        projectId: target.projectId,
        url: target.url,
        displayKey: target.displayKey,
        title: target.title,
        source: "manual" as const,
      }
    : { type: "thread.issue.unlink" as const, threadId, ...key };
}

export function IssueThreadLinks(props: {
  environmentId: string;
  reference: IssueRef & { host: string };
  issue: Pick<IssueDetail, "url" | "displayKey" | "title">;
  currentThreadId?: () => string | null;
  currentThreadLinkedIds?: () => readonly { tracker: string; host: string; scope: string; key: string }[];
  threads?: {
    all: () => IssuePickerThread[];
    projectName: (projectId: string) => string;
    open: (threadId: string) => void;
  };
  request?: RequestFn;
}) {
  const open = signal(false);
  const pickerOpen = signal(false);
  const pending = signal(false);
  const anchor = createAnchor();
  const pickerAnchor = createAnchor();

  const supported = () => issueLinkedThreadsSupported(props.environmentId);
  const key = () => threadIssueKeyOf(props.reference);

  effect(() => {
    key();
    if (supported()) {
      untracked(() => { void loadIssueLinkedThreads(props.environmentId, props.reference, props.request); });
    }
  });

  const cached = () => cachedIssueLinkedThreads(props.environmentId, props.reference);
  const visibleThreads = () => cached().threads;
  const activeThreadId = () => props.currentThreadId?.() ?? null;
  const linkedHere = () => {
    const currentId = activeThreadId();
    if (!currentId) return false;
    if (props.currentThreadLinkedIds) {
      return props.currentThreadLinkedIds().some((existing) => threadIssueKeyOf(existing) === key());
    }
    return visibleThreads().some((t) => t.id === currentId);
  };

  async function changeLink(threadId: string, shouldLink: boolean): Promise<boolean> {
    if (pending()) return false;
    pending.set(true);
    try {
      const cmd = issueLinkCommand(
        threadId,
        { ...props.reference, url: props.issue.url, displayKey: props.issue.displayKey, title: props.issue.title },
        shouldLink,
      );
      await (props.request ?? requestBackend)("orchestration.dispatchCommand", { ...cmd, commandId: `cmd:${crypto.randomUUID()}` });
      await loadIssueLinkedThreads(props.environmentId, props.reference, props.request);
      return true;
    } catch (cause) {
      showToast({
        type: "error",
        title: shouldLink ? "Could not link thread" : "Could not unlink thread",
        description: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    } finally {
      pending.set(false);
    }
  }

  const canOperate = () => scopeAllows(ORCHESTRATION_OPERATE_SCOPE);
  const query = signal("");
  const candidates = () =>
    threadPickerCandidates(
      props.threads?.all() ?? [],
      (t) => props.threads?.projectName(t.projectId) ?? "",
      query(),
    );
  const linkedIds = () => new Set(visibleThreads().map((t) => t.id));

  return (
    <View class="flex-row items-center gap-1">
      {supported() && visibleThreads().length > 0 ? (
        <View>
          <View
            ref={anchor.ref}
            role="button"
            accessibilityLabel={`Linked from ${visibleThreads().length} ${visibleThreads().length === 1 ? "thread" : "threads"}`}
            onPress={() => open.update((v) => !v)}
            class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50"
          >
            <PRIcon name="message-square" size={14} />
            <Text class="text-xs text-foreground">{String(visibleThreads().length)}</Text>
          </View>
          {open() ? (
            <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="end" class="w-72">
              <View class="flex-col p-1">
                <Each of={visibleThreads()} key={(thread: IssueLinkedThread) => thread.id}>
                  {(thread) => (
                    <View
                      role="button"
                      accessibilityLabel={`Open thread ${thread().title || "Untitled thread"}`}
                      onPress={() => { open.set(false); props.threads?.open(thread().id); }}
                      class="flex-row items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent-50"
                    >
                      <PRIcon name="message-square" size={16} />
                      <View class="min-w-0 flex-1 flex-col">
                        <Text class="truncate text-sm text-foreground">{thread().title || "Untitled thread"}</Text>
                        <Text class="truncate text-xs text-muted-foreground">{props.threads?.projectName(thread().projectId) ?? ""}</Text>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </Popup>
          ) : null}
        </View>
      ) : null}

      {canOperate() ? (
        activeThreadId() ? (
          <View
            role="button"
            accessibilityLabel={linkedHere() ? "Unlink from thread" : "Link to thread"}
            accessibilityState={{ disabled: pending() }}
            onPress={() => { const id = activeThreadId(); if (id) void changeLink(id, !linkedHere()); }}
            class={`h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50 ${pending() ? "opacity-60" : ""}`}
          >
            <PRIcon name={linkedHere() ? "unlink" : "link"} size={14} />
            <Text class="text-xs text-foreground">{linkedHere() ? "Unlink" : "Link"}</Text>
          </View>
        ) : props.threads ? (
          <View>
            <View
              ref={pickerAnchor.ref}
              role="button"
              accessibilityLabel="Link issue to thread"
              onPress={() => { query.set(""); pickerOpen.update((v) => !v); }}
              class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50"
            >
              <PRIcon name="link" size={14} />
              <Text class="text-xs text-foreground">Link</Text>
            </View>
            {pickerOpen() ? (
              <Popup anchor={pickerAnchor.anchor} onClose={() => pickerOpen.set(false)} placement="bottom" align="end" class="w-80">
                <View class="flex-col" accessibilityLabel="Choose a thread">
                  <Input
                    autoFocus
                    accessibilityLabel="Search threads or projects"
                    placeholder="Search threads or projects..."
                    value={query()}
                    onChange={(event) => query.set(event.value)}
                    class="h-9 border-b border-border-60 bg-transparent px-3 text-sm text-foreground"
                  />
                  <View class="max-h-80 flex-col overflow-y-auto p-1">
                    {candidates().length === 0 ? <Text class="px-3 py-6 text-center text-sm text-muted-foreground">No active threads found.</Text> : null}
                    <Each of={candidates()} key={(thread: IssuePickerThread) => thread.id}>
                      {(thread) => {
                        const already = () => linkedIds().has(thread().id);
                        return (
                          <View
                            role="button"
                            accessibilityLabel={`Link thread ${thread().title || "Untitled thread"}`}
                            accessibilityState={{ disabled: pending() || already() }}
                            onPress={() => {
                              if (!pending() && !already()) {
                                void changeLink(thread().id, true).then((ok) => { if (ok) pickerOpen.set(false); });
                              }
                            }}
                            class={`flex-row items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent-50 ${pending() || already() ? "opacity-60" : ""}`}
                          >
                            <PRIcon name="message-square" size={16} />
                            <View class="min-w-0 flex-1 flex-col">
                              <Text class="truncate text-sm text-foreground">{thread().title || "Untitled thread"}</Text>
                              <Text class="truncate text-xs text-muted-foreground">{props.threads?.projectName(thread().projectId) ?? ""}</Text>
                            </View>
                            {already() ? <><PRIcon name="check" size={14} /><Text class="text-xs text-muted-foreground">Linked</Text></> : null}
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                </View>
              </Popup>
            ) : null}
          </View>
        ) : null
      ) : null}
    </View>
  );
}
