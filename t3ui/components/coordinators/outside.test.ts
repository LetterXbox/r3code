import { expect, test } from "nsh/test";
import { clearToasts, toastById, toasts } from "../toast/toastState";
import { AFPLAY, COMPLETION_SOUND, INPUT_SOUND, OSASCRIPT, appleScriptString, notificationScript, playNotificationSound, showSystemNotification } from "./systemNotify";
import {
  DISMISSED_KEY, PROMPTS_BEFORE_ASKING, SENT_KEY, STAR_PROMPT_ID, configureStarPrompt, recordPromptSent, resetStarPromptForTest,
} from "./githubStarPrompt";
import {
  createDesktopUpdateObserver, getDesktopUpdateDownloadedVersion, getDesktopUpdateReleaseUrl, resolveDesktopUpdateButtonAction, showDesktopUpdateDownloadedToast,
  type DesktopUpdateState,
} from "./desktopUpdate";
import { Storage } from "nsh";

const until = async (ready: () => boolean) => { for (let attempt = 0; attempt < 400 && !ready(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10)); };

test("a notification script escapes quotes and backslashes and keeps to one line", () => {
  expect(appleScriptString('say "hi" \\ there\nnow')).toBe('"say \\"hi\\" \\\\ there now"');
  expect(notificationScript("Thread completed", "Fix the \"build\"")).toBe('display notification "Fix the \\"build\\"" with title "Thread completed"');
});

test("the notification and the sound run the two granted executables, and a refusal reports false", async () => {
  const calls: Array<[string, string[]]> = [];
  const ok = async (command: string, args: string[]) => { calls.push([command, args]); };
  expect(await showSystemNotification("Approval needed", "Fix", ok)).toBe(true);
  expect(await playNotificationSound("completion", ok)).toBe(true);
  expect(await playNotificationSound("input", ok)).toBe(true);
  expect(calls).toEqual([
    [OSASCRIPT, ["-e", 'display notification "Fix" with title "Approval needed"']],
    [AFPLAY, [COMPLETION_SOUND]],
    [AFPLAY, [INPUT_SOUND]],
  ]);
  const denied = async () => { throw Object.assign(new Error("denied"), { code: "ERR_ACCESS_DENIED" }); };
  expect(await showSystemNotification("a", "b", denied)).toBe(false);
  expect(await playNotificationSound("input", denied)).toBe(false);
});

test("the star prompt asks after more than five prompts, once, and only for an account that has not starred", async () => {
  await Storage.removeItem(SENT_KEY); await Storage.removeItem(DISMISSED_KEY);
  clearToasts();
  const calls: Array<[string, unknown]> = [];
  resetStarPromptForTest({ idleMs: 20 });
  configureStarPrompt(async (method, payload) => { calls.push([method, payload]); return false; });
  for (let sent = 0; sent < PROMPTS_BEFORE_ASKING; sent++) await recordPromptSent();
  expect(calls.length).toBe(0);
  await recordPromptSent();
  await until(() => toastById(STAR_PROMPT_ID) !== undefined);
  expect(calls[0]).toEqual(["sourceControl.starred", { provider: "github", host: "github.com", repository: "pingdotgg/t3code" }]);
  expect(toastById(STAR_PROMPT_ID)).toMatchObject({ title: "Enjoying R3 Code?", description: "Give us a star on GitHub to let us know!", leadingIcon: { name: "star", tone: "warning" } });
  expect(toastById(STAR_PROMPT_ID)!.actions.map((action) => action.label)).toEqual(["Dismiss", "Star on GitHub"]);
  await recordPromptSent();
  expect(calls.length).toBe(1);
  toastById(STAR_PROMPT_ID)!.actions[1]!.run();
  await until(() => calls.some(([method]) => method === "sourceControl.star"));
  clearToasts();
  await Storage.removeItem(SENT_KEY); await Storage.removeItem(DISMISSED_KEY);
});

test("while starring, the prompt keeps Dismiss and only the primary action reads Starring", async () => {
  await Storage.removeItem(SENT_KEY); await Storage.setItem(SENT_KEY, "9"); await Storage.removeItem(DISMISSED_KEY);
  clearToasts();
  resetStarPromptForTest({ idleMs: 10 });
  let finish: (value: unknown) => void = () => undefined;
  configureStarPrompt(async (method) => (method === "sourceControl.starred" ? false : new Promise((resolve) => { finish = resolve; })));
  await recordPromptSent();
  await until(() => toastById(STAR_PROMPT_ID) !== undefined);
  toastById(STAR_PROMPT_ID)!.actions[1]!.run();
  expect(toastById(STAR_PROMPT_ID)!.actions.map((action) => action.label)).toEqual(["Dismiss", "Starring…"]);
  finish(true);
  await until(() => toastById(STAR_PROMPT_ID)?.title === "Thanks for the star!");
  clearToasts();
  await Storage.removeItem(SENT_KEY); await Storage.removeItem(DISMISSED_KEY);
});

test("an account that already starred, or a dismissal, never asks", async () => {
  await Storage.removeItem(SENT_KEY); await Storage.setItem(SENT_KEY, "9"); await Storage.removeItem(DISMISSED_KEY);
  clearToasts();
  resetStarPromptForTest({ idleMs: 10 });
  configureStarPrompt(async () => true);
  await recordPromptSent();
  expect(await Storage.getItem(DISMISSED_KEY)).toBe("true");
  expect(toasts().length).toBe(0);
  resetStarPromptForTest({ idleMs: 10 });
  let asked = false;
  configureStarPrompt(async () => { asked = true; return false; });
  await recordPromptSent();
  expect(asked).toBe(false);
  await Storage.removeItem(SENT_KEY); await Storage.removeItem(DISMISSED_KEY);
});

const state = (overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({ status: "downloaded", availableVersion: "0.2.0", downloadedVersion: "0.2.0", ...overrides });

test("the update toast says Update downloaded and links the release notes of the downloaded version", async () => {
  expect(getDesktopUpdateReleaseUrl("0.2.0")).toBe("https://github.com/pingdotgg/t3code/releases/tag/v0.2.0");
  expect(getDesktopUpdateReleaseUrl("0.2.0", "me/fork")).toBe("https://github.com/me/fork/releases/tag/v0.2.0");
  expect(getDesktopUpdateReleaseUrl("0.2.0", "bad repo")).toBe("https://github.com/pingdotgg/t3code/releases/tag/v0.2.0");
  expect(getDesktopUpdateReleaseUrl("  ")).toBe(null);
  expect(getDesktopUpdateDownloadedVersion(state({ downloadedVersion: null }))).toBe("0.2.0");
  clearToasts();
  const opened: string[] = [];
  const id = showDesktopUpdateDownloadedToast(state(), async (url) => { opened.push(url); return { opened: true }; });
  expect(toastById(id)).toMatchObject({ type: "success", title: "Update downloaded", description: "Restart the app from the update button to install it." });
  toastById(id)!.actions[0]!.run();
  await until(() => opened.length === 1);
  expect(opened).toEqual(["https://github.com/pingdotgg/t3code/releases/tag/v0.2.0"]);
  clearToasts();
  const failing = showDesktopUpdateDownloadedToast(state(), async () => ({ opened: false }));
  toastById(failing)!.actions[0]!.run();
  await until(() => toasts().some((toast) => toast.title === "Unable to open release notes"));
  clearToasts();
});

test("the toast shows once per download, and the button action follows the updater's state", () => {
  const shown: string[] = [];
  const observe = createDesktopUpdateObserver((next) => shown.push(next.status));
  observe(state({ status: "downloading", downloadedVersion: null }));
  observe(state());
  observe(state());
  observe(null);
  observe(state({ status: "available", downloadedVersion: null }));
  observe(state());
  expect(shown).toEqual(["downloaded", "downloaded"]);
  expect(resolveDesktopUpdateButtonAction(state())).toBe("install");
  expect(resolveDesktopUpdateButtonAction(state({ status: "available", downloadedVersion: null }))).toBe("download");
  expect(resolveDesktopUpdateButtonAction(state({ status: "error", errorContext: "download", downloadedVersion: null }))).toBe("download");
  expect(resolveDesktopUpdateButtonAction(state({ status: "idle", downloadedVersion: null }))).toBe("none");
});
