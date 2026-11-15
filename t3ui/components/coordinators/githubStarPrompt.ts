// components/GitHubStarPrompt.tsx: after more than five sent prompts, asks once per session for a star on GitHub until it is dismissed,
// unless the server's GitHub account already starred the repository, and only once the user has been idle. Calls are
// `sourceControl.starred` and `sourceControl.star`. NSH has no global input events, so "idle" is 30 s with the window active and no
// new prompt sent; the web's is 30 s without a pointer, key, wheel or focus event.
import { effect, lifecycle, openUrl, signal, Storage, untracked } from "nsh";
import { closeToast, showToast, updateToast } from "../toast/toastState";

export const SENT_KEY = "githubStarPrompt:sent";
export const DISMISSED_KEY = "githubStarPrompt:dismissed";
export const STAR_REPOSITORY = "pingdotgg/t3code";
export const PROMPTS_BEFORE_ASKING = 5;
export const IDLE_MS = 30_000;
export const STAR_PROMPT_ID = "github-star-prompt";

type Request = (method: string, payload: unknown) => Promise<unknown>;
let request: Request | null = null;
let shownThisSession = false;
let idleMs = IDLE_MS;
const lastActivity = signal(Date.now());

/** The store hands over its request function once (the store imports this module, so this one cannot import the store). */
export function configureStarPrompt(next: Request) { request = next; }
export function resetStarPromptForTest(options: { idleMs?: number } = {}) { shownThisSession = false; idleMs = options.idleMs ?? IDLE_MS; request = null; }

const starInput = { provider: "github", host: "github.com", repository: STAR_REPOSITORY };

async function readFlag(key: string): Promise<string | null> { return Storage.getItem(key).catch(() => null); }

const waitForIdle = () => new Promise<void>((resolve) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = effect(() => {
    const active = lifecycle() === "active";
    const at = lastActivity();
    clearTimeout(timer);
    if (!active) return;
    timer = setTimeout(() => { resolve(); }, Math.max(0, idleMs - (Date.now() - at)));
    return () => clearTimeout(timer);
  });
  void stop;
});

async function dismiss() { await Storage.setItem(DISMISSED_KEY, "true").catch(() => undefined); }

function showStarPrompt() {
  const close = () => closeToast(STAR_PROMPT_ID);
  const openInBrowser = () => { close(); void openUrl(`https://github.com/${STAR_REPOSITORY}`).catch(() => undefined); };
  const starInPlace = async () => {
    // Only the primary action changes (toastManager.update with actionProps): Dismiss stays.
    updateToast(STAR_PROMPT_ID, { ...prompt, actions: [prompt.actions[0]!, { label: "Starring…", disabled: true, run: () => undefined }] });
    let starred = false;
    try { starred = (await request?.("sourceControl.star", starInput)) === true; } catch { starred = false; }
    if (starred) {
      await dismiss();
      updateToast(STAR_PROMPT_ID, { type: "success", title: "Thanks for the star!", description: "It really helps R3 Code grow.", timeoutMs: 5_000, leadingIcon: undefined as never });
      return;
    }
    openInBrowser();
  };
  const prompt = {
    id: STAR_PROMPT_ID,
    title: "Enjoying R3 Code?",
    description: "Give us a star on GitHub to let us know!",
    timeoutMs: 0,
    hideCopyButton: true,
    leadingIcon: { name: "star" as const, tone: "warning" as const },
    // Every close path, including both buttons, saves the dismissal.
    onClose: () => { void dismiss(); },
    actions: [
      { label: "Dismiss", variant: "ghost" as const, run: () => { void dismiss(); close(); } },
      { label: "Star on GitHub", run: () => { void starInPlace(); } },
    ],
  };
  showToast(prompt);
}

/** Counts a sent prompt; after more than five asks once per session, unless dismissed or already starred. */
export async function recordPromptSent(): Promise<void> {
  lastActivity.set(Date.now());
  if (shownThisSession) return;
  if ((await readFlag(DISMISSED_KEY)) === "true") return;
  const sent = (Number(await readFlag(SENT_KEY)) || 0) + 1;
  try { await Storage.setItem(SENT_KEY, String(sent)); } catch { return; }
  if (sent <= PROMPTS_BEFORE_ASKING) return;
  shownThisSession = true;
  let starred: unknown;
  try { starred = await request?.("sourceControl.starred", starInput); } catch { return; }
  if (typeof starred !== "boolean") return;
  if (starred) return dismiss();
  await waitForIdle();
  if ((await readFlag(DISMISSED_KEY)) === "true") return;
  untracked(showStarPrompt);
}
