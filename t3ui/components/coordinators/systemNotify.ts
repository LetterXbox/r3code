// What reaches outside the window: a macOS notification (`osascript -e 'display notification ...'`) and the notification sound
// (`afplay`), both through `process.run`, which nsh.json grants for exactly these two executables (capabilities.process.execute).
// NSH has no notification, badge or audio API of its own. A host without them, or a platform other than macOS, makes both do nothing.
import { run } from "process";

export const OSASCRIPT = "/usr/bin/osascript";
export const AFPLAY = "/usr/bin/afplay";
export const COMPLETION_SOUND = "/System/Library/Sounds/Glass.aiff";
export const INPUT_SOUND = "/System/Library/Sounds/Ping.aiff";

/** An AppleScript string literal: backslashes and quotes escaped, newlines flattened. */
export const appleScriptString = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;

export function notificationScript(title: string, body: string): string {
  return `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`;
}

type Runner = (command: string, args: string[]) => Promise<unknown>;
const defaultRunner: Runner = (command, args) => run(command, args, { timeoutMs: 10_000 });

export function showSystemNotification(title: string, body: string, runner: Runner = defaultRunner): Promise<boolean> {
  return runner(OSASCRIPT, ["-e", notificationScript(title, body)]).then(() => true, () => false);
}

// threadNotifications.ts playNotificationSound: a burst of the same sound plays once (a sound that is still playing is not
// started again); completion and input keep separate slots. afplay resolves when the sound has finished.
const playing = new Set<"input" | "completion">();
export function playNotificationSound(kind: "input" | "completion", runner: Runner = defaultRunner): Promise<boolean> {
  if (playing.has(kind)) return Promise.resolve(false);
  playing.add(kind);
  return runner(AFPLAY, [kind === "completion" ? COMPLETION_SOUND : INPUT_SOUND]).then(() => true, () => false).finally(() => playing.delete(kind));
}
