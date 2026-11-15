// Mounts the thread's linked pull requests panel on server-shaped links; dispatched commands and opens are listed on screen.
import { mount, signal, Text, View } from "nsh";
import { ThreadPullRequestsPanel } from "./components/pullRequest/ThreadPullRequestsPanel";
import { ToastHost } from "./components/toast";
import type { LinkedPullRequest } from "./components/header/threadRelations";

const NOW = Date.now();
const snap = (patch: Record<string, unknown>) => ({ state: "open", title: "Fix the race", isDraft: false, headBranch: "feature-1", baseBranch: "main", additions: 10, deletions: 2, changedFiles: 3, checksState: "passing", reviewDecision: "approved", ...patch });
const link = (number: number, patch: Partial<LinkedPullRequest>): LinkedPullRequest => ({ host: "github.com", repository: "acme/t3code", number, url: `https://github.com/acme/t3code/pull/${number}`, source: "agent", linkedAt: new Date(NOW - 3_600_000).toISOString(), snapshot: snap({}), watching: false, ...patch });

const links = signal<LinkedPullRequest[]>([
  link(1, {}),
  link(2, { source: "stack", snapshot: snap({ title: "Stack layer", checksState: "failing", reviewDecision: null }) }),
  link(3, { source: "stack-dismissed" }),
  link(4, { source: "manual", snapshot: null }),
  link(5, { snapshot: snap({ state: "merged", title: "Shipped" }), watching: true }),
]);
const log = signal<string[]>([]);
const empty = signal(false);

mount(() => (
  <View class="flex-1 flex-col">
    <View accessibilityLabel="Remove all links" onPress={() => empty.set(true)} class="h-6 w-24"><Text class="text-xs">empty</Text></View>
    <View class="h-96 w-[420px] flex-col">
      <ThreadPullRequestsPanel threadId="thread:a" links={() => (empty() ? [] : links())} now={() => NOW}
        dispatch={async (command) => { log.update((all) => [...all, `dispatch ${JSON.stringify(command)}`]); }}
        onOpen={(item) => log.update((all) => [...all, `open ${item.number}`])} onLink={() => log.update((all) => [...all, "link dialog"])} supportsWatch supported={() => true} />
    </View>
    <Each of={log()} key={(line, index) => `${index}:${line}`}>{(line) => <Text class="text-2xs">{line()}</Text>}</Each>
    <ToastHost />
  </View>
));
