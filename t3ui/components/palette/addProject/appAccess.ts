// sourceControlAppAccessToast.ts: after a clone, suggests installing the forge app on the repository's owner when the
// server is signed in with it but the app does not reach the repository. Only GitHub has an app sign-in today
// (packages/source-control-github APP_SIGN_IN); sourceControl.appAccess is the contract's check.
import { openUrl } from "nsh";
import { closeToast, showToast } from "../../toast/toastState";

export interface AppSignIn { kind: string; appName: string; hosts: readonly string[]; installUrl: string }

export const APP_SIGN_INS: readonly AppSignIn[] = [
  { kind: "github", appName: "T3 Code for GitHub", hosts: ["github.com"], installUrl: "https://github.com/apps/t3-code-for-github/installations/new" },
];

/** parseGitRemoteRepository: the host and lower-cased path of an https/ssh/scp-style remote. */
export function parseRemote(value: string): { host: string; path: string } | null {
  const normalized = value.trim().toLowerCase().replace(/\.git\/?$/, "").replace(/\/+$/, "");
  if (/^(?:ssh|https?|git):\/\//.test(normalized)) {
    try {
      const url = new URL(normalized);
      const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
      return url.hostname && segments.length > 1 ? { host: url.hostname, path: segments.join("/") } : null;
    } catch { return null; }
  }
  const scp = /^[a-z]:/i.test(normalized) ? null : /^(?:[a-z0-9._-]+@)?([^@:/\\\s]+):\/?([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  return scp?.[1] && scp[2] ? { host: scp[1], path: scp[2] } : null;
}

/** appSignInTargetForRemote: the repository a remote names, when its host has an app sign-in that could reach it. */
export function appSignInTargetForRemote(remoteUrl: string): { appSignIn: AppSignIn; input: { provider: string; host: string; repository: string } } | null {
  const parsed = parseRemote(remoteUrl);
  if (parsed === null) return null;
  const appSignIn = APP_SIGN_INS.find((candidate) => candidate.hosts.includes(parsed.host));
  if (!appSignIn) return null;
  // The parser lowercases; keep the remote's own casing for display when it names the same path.
  const asWritten = remoteUrl.trim().replace(/\.git\/?$/i, "").replace(/\/+$/, "").split(/[/:]/).slice(-2).join("/");
  const repository = asWritten.toLowerCase() === parsed.path ? asWritten : parsed.path;
  return { appSignIn, input: { provider: appSignIn.kind, host: parsed.host, repository } };
}

export async function suggestAppAccessForRemote(
  request: (method: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>,
  remoteUrl: string,
): Promise<void> {
  const target = appSignInTargetForRemote(remoteUrl);
  if (target === null) return;
  let status: unknown;
  try {
    status = (await request("sourceControl.appAccess", target.input) as { status?: unknown } | null)?.status;
  } catch {
    // A failed check is not worth a toast (reportFailure: false in the web).
    return;
  }
  if (status !== "not-covered") return;
  const owner = target.input.repository.split("/")[0] ?? target.input.repository;
  const id = showToast({
    type: "info",
    title: `Give ${target.appSignIn.appName} access to ${owner}`,
    description: `It isn't installed there, so GitHub requests for ${target.input.repository} use your own login and its lower rate limit.`,
    // sourceControlAppAccessToast.ts: toastManager.add with actionProps, the inline layout.
    actionLayout: "inline",
    actions: [{ label: "Install", run: () => { closeToast(id); void openUrl(target.appSignIn.installUrl).catch(() => undefined); } }],
  });
}
