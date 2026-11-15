// The threads linked to the open pull request, and linking another (pullRequests.linkedThreads and the
// thread.pull-request.link / .unlink commands). Pure of rendering so tests drive it with a fake server.
import { effect, signal } from "nsh";
import type { PullRequestRefInput } from "./pullRequestDiff.logic";
import { linkedThreadsLabel, parseLinkedThreads, threadLinkCommand, type LinkedThread, type ThreadLinkTarget } from "./pullRequestThreadLinks.logic";

const LINKED_THREADS_REFRESH_MS = 10_000;

export function createPullRequestThreadLinksModel(deps: {
  request: (method: string, payload: unknown) => Promise<unknown>;
  ref: () => PullRequestRefInput | null;
  target: () => ThreadLinkTarget | null;
  /** Whether the environment has delivered its config: links are "unsupported" until it has. */
  supported: () => boolean;
  toast: (input: { type: "error"; title: string; description: string }) => void;
}) {
  const linked = signal<LinkedThread[] | null>(null);
  const failed = signal(false);
  const pending = signal(false);
  let sequence = 0;

  async function load() {
    const ref = deps.ref();
    const request = ++sequence;
    if (!ref || !deps.supported()) { linked.set(null); failed.set(false); return; }
    try {
      const result = parseLinkedThreads(await deps.request("pullRequests.linkedThreads", ref));
      if (request !== sequence) return;
      linked.set(result);
      failed.set(false);
    } catch {
      // The last count stays; the button then asks for a retry rather than claiming zero.
      if (request === sequence) failed.set(true);
    }
  }

  effect(() => {
    const ref = deps.ref();
    const supported = deps.supported();
    if (ref && supported) void load();
    else { sequence++; linked.set(null); failed.set(false); }
    // linkedThreads: staleTimeMs 0 with refreshIntervalMs 10 s, so a thread linked elsewhere shows up within ten seconds.
    const timer = ref && supported ? setInterval(() => void load(), LINKED_THREADS_REFRESH_MS) : undefined;
    return () => { sequence++; if (timer !== undefined) clearInterval(timer); };
  });

  /** Links the pull request to `threadId`, or takes the link away. */
  async function changeLink(threadId: string, remove: boolean): Promise<boolean> {
    const target = deps.target();
    if (!target || pending()) return false;
    pending.set(true);
    try {
      await deps.request("orchestration.dispatchCommand", { ...threadLinkCommand(threadId, target, !remove), commandId: `command:${crypto.randomUUID()}` });
      pending.set(false);
      await load();
      return true;
    } catch (cause) {
      pending.set(false);
      const term = /\/merge_requests\//u.test(target.url) ? "merge request" : "pull request";
      deps.toast({ type: "error", title: remove ? `Could not unlink the ${term}` : `Could not link the ${term}`, description: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  }

  /** Links are offered only once an environment has delivered its config. */
  const supported = () => deps.supported();
  const count = () => linked()?.length ?? 0;
  /** The count button shows once threads are linked, or when reading them failed. */
  const visible = () => deps.supported() && (count() > 0 || failed());
  return { linked, failed, pending, load, changeLink, count, visible, supported, label: () => linkedThreadsLabel(count()) };
}

export type PullRequestThreadLinksModel = ReturnType<typeof createPullRequestThreadLinksModel>;
