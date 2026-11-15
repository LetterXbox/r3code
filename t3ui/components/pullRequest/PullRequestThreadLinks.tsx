// Threads linked to the pull request (PullRequestThreadLinks.tsx): the count button in the header, which lists
// them, and the picker that links one more. The web opens the command palette on the linked threads; this lists
// them in a popup beside the button.
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import type { PullRequestThreadLinksModel } from "./pullRequestThreadLinksModel";
import { threadPickerCandidates, type LinkedThread } from "./pullRequestThreadLinks.logic";

interface PickerThread { id: string; title: string; projectId: string; updatedAt: number }

export function PullRequestLinkedThreads(props: { links: PullRequestThreadLinksModel; projectName: (projectId: string) => string; onOpenThread: (threadId: string) => void; /** The web opens the command palette on the linked threads instead of a popup beside the button. */ onOpenInPalette?: (threads: LinkedThread[]) => void }) {
  const open = signal(false);
  const anchor = createAnchor();
  return (
    <View>
      {props.links.visible() ? (
        <View
          ref={anchor.ref}
          role="button"
          tooltip={`${props.links.label()}.`}
          accessibilityLabel={props.links.label()}
          onPress={() => { if (props.links.failed() && props.links.count() === 0) void props.links.load(); else if (props.onOpenInPalette) props.onOpenInPalette(props.links.linked() ?? []); else open.set(!open()); }}
          class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50"
        >
          <PRIcon name="message-square" size={14} />
          <Text class="text-xs text-foreground">{props.links.count() || "?"}</Text>
        </View>
      ) : null}
      {open() && props.links.visible() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="end" class="w-72">
          <View class="flex-col p-1">
            <Each of={props.links.linked() ?? []} key={(thread: LinkedThread) => thread.id}>
              {(thread) => (
                <View role="button" accessibilityLabel={`Open thread ${thread().title || "Untitled thread"}`} onPress={() => { open.set(false); props.onOpenThread(thread().id); }} class="flex-row items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent-50">
                  <PRIcon name="message-square" size={16} />
                  <View class="min-w-0 flex-1 flex-col">
                    <Text class="truncate text-sm text-foreground">{thread().title || "Untitled thread"}</Text>
                    <Text class="truncate text-xs text-muted-foreground">{props.projectName(thread().projectId)}</Text>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </Popup>
      ) : null}
    </View>
  );
}

/** The thread picker the "Link to thread" menu item opens: search, then press a thread to link it. */
export function PullRequestThreadPicker(props: {
  links: PullRequestThreadLinksModel;
  threads: () => PickerThread[];
  projectName: (projectId: string) => string;
  linkedIds: () => Set<string>;
  anchor: () => import("nsh").ViewRef | null;
  onClose: () => void;
}) {
  const query = signal("");
  const candidates = () => threadPickerCandidates(props.threads(), (thread) => props.projectName(thread.projectId), query());
  return (
    <Popup anchor={props.anchor} onClose={props.onClose} placement="bottom" align="end" class="w-80">
      <View class="flex-col" accessibilityLabel="Choose a thread">
        <Input autoFocus accessibilityLabel="Search threads or projects" placeholder="Search threads or projects..." value={query()} onChange={(event) => query.set(event.value)} class="h-9 border-b border-border-60 bg-transparent px-3 text-sm text-foreground" />
        <View class="max-h-80 flex-col p-1">
          {candidates().length === 0 ? <Text class="px-3 py-6 text-center text-sm text-muted-foreground">No active threads found.</Text> : null}
          <Each of={candidates()} key={(thread: PickerThread) => thread.id}>
            {(thread) => {
              const linked = () => props.linkedIds().has(thread().id);
              return (
                <View
                  role="button"
                  accessibilityLabel={`Link thread ${thread().title || "Untitled thread"}`}
                  accessibilityState={{ disabled: props.links.pending() || linked() }}
                  onPress={() => { if (!props.links.pending() && !linked()) void props.links.changeLink(thread().id, false).then((done) => { if (done) props.onClose(); }); }}
                  class={`flex-row items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent-50 ${props.links.pending() || linked() ? "opacity-60" : ""}`}
                >
                  <PRIcon name="message-square" size={16} />
                  <View class="min-w-0 flex-1 flex-col">
                    <Text class="truncate text-sm text-foreground">{thread().title || "Untitled thread"}</Text>
                    <Text class="truncate text-xs text-muted-foreground">{props.projectName(thread().projectId)}</Text>
                  </View>
                  {linked() ? <><PRIcon name="check" size={14} /><Text class="text-xs text-muted-foreground">Linked</Text></> : null}
                </View>
              );
            }}
          </Each>
        </View>
      </View>
    </Popup>
  );
}

