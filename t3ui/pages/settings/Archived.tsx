// Archive, ported from ArchivedThreadsPanel.tsx: one section per project, each
// archived thread a row ("Archived 2d ago · Created 5d ago") with Unarchive and
// Delete icon buttons. With no threads the section reads "No archived
// threads" / "Archived threads will appear here."; disconnected it says to
// connect an environment instead of claiming the archive is empty.
import { effect, signal, Text, untracked, View } from "nsh";
import { SettingsRow, SettingsSection } from "../../components/SettingsLayout";
import { confirm, showToast } from "../../components/toast";
import {
  allProjects, archiveLoading, archivedError, archivedThreads, backendError, backendStatus,
  refreshArchivedThreads, requestBackend, restoreThread, settingValue,
} from "../../store";
import type { BackendStatus } from "../../store";
import { groupArchived, relativeTime, type ArchivedItem } from "./archivedLogic";
import { deleteUnlistedThread } from "../../components/sidebar/threadActions";
import { SettingsIcon } from "./SettingsIcon";

export function ArchivedView(props: {
  status: BackendStatus;
  loading: boolean;
  error: string | null;
  threads: ArchivedItem[];
  projectName: (projectId: string) => string | null;
  confirmDelete: boolean;
  now: number;
  onRefresh: () => void;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const pending = signal<string[]>([]);

  async function act(id: string, action: () => Promise<void>, failure: string) {
    if (pending().includes(id)) return;
    pending.update((items) => [...items, id]);
    try {
      await action();
      props.onRefresh();
    } catch (cause) {
      showToast({ type: "error", title: failure, description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      pending.update((items) => items.filter((item) => item !== id));
    }
  }

  const empty = () => props.status === "connected" && !props.loading && !props.error && props.threads.length === 0;
  const groups = () => groupArchived(props.threads, props.projectName);
  const message = () => props.error || "";
  /** confirmAndDeleteThread: the shared confirmation, then the delete. */
  async function deleteThread(thread: ArchivedItem) {
    if (props.confirmDelete) {
      const confirmed = await confirm([`Delete thread "${thread.title}"?`, "This permanently clears conversation history for this thread.", "This action cannot be undone."].join("\n"), { variant: "destructive" });
      if (!confirmed) return;
    }
    await act(thread.id, () => props.onDelete(thread.id), "Failed to delete thread");
  }

  return (
    <>
      {props.status !== "connected" || props.loading || empty() || props.error ? (
        <SettingsSection title="Archive">
          <SettingsRow
            title={
              props.status !== "connected" ? "Connect an environment to see archived threads."
                : props.loading ? "Loading archived threads"
                : props.error ? "Could not load archived threads"
                : "No archived threads"
            }
            description={
              props.status !== "connected" ? undefined
                : props.loading ? "Checking connected environments."
                : props.error ? props.error
                : "Archived threads will appear here."
            }
          />
        </SettingsSection>
      ) : null}
      {message() && props.threads.length > 0 ? <View class="px-4"><Text class="text-xs text-destructive-foreground">{message()}</Text></View> : null}
      <Each of={groups()} key={(group) => group.key}>
        {(group) => (
          <SettingsSection title={group().title}>
            <Each of={group().threads} key={(thread) => thread.id}>
              {(thread, index) => (
                <View>
                  {index() > 0 ? <View class="h-px bg-border-50" /> : null}
                  <SettingsRow
                    title={thread().title}
                    description={`Archived ${relativeTime(thread().updatedAt, props.now)} · Created ${relativeTime(thread().createdAt ?? 0, props.now)}`}
                    control={
                      <View class="flex-row items-center gap-2">
                        <View
                          class="size-7 items-center justify-center rounded-lg border border-input bg-background hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
                          accessibilityLabel={`Unarchive ${thread().title}`}
                          disabled={pending().includes(thread().id)}
                          onPress={() => void act(thread().id, () => props.onRestore(thread().id), "Failed to unarchive thread")}
                        >
                          <SettingsIcon name="rotate-ccw" size={14} />
                        </View>
                        <View
                          class="size-7 items-center justify-center rounded-lg border border-destructive bg-background hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
                          accessibilityLabel={`Delete ${thread().title}`}
                          disabled={pending().includes(thread().id)}
                          onPress={() => void deleteThread(thread())}
                        >
                          <SettingsIcon name="trash-2" size={14} />
                        </View>
                      </View>
                    }
                  />
                </View>
              )}
            </Each>
          </SettingsSection>
        )}
      </Each>
    </>
  );
}

async function deleteThread(id: string) {
  // useThreadActions deleteThread (unresolved target): the delete, then the thread's and its side chats' drafts.
  await deleteUnlistedThread(id);
}

export function ArchivedSettings() {
  effect(() => {
    if (backendStatus() === "connected") void untracked(() => refreshArchivedThreads());
  });
  return (
    <ArchivedView
      status={backendStatus()}
      loading={archiveLoading()}
      error={archivedError() ?? (backendStatus() === "error" ? backendError() : null)}
      threads={archivedThreads()}
      projectName={(id) => allProjects().find((project) => project.id === id)?.name ?? null}
      confirmDelete={settingValue("confirmThreadDelete") !== false}
      now={Date.now()}
      onRefresh={() => void refreshArchivedThreads()}
      onRestore={restoreThread}
      onDelete={deleteThread}
    />
  );
}
