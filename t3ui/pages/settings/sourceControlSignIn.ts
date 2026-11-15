// The logic of SourceControlAppSignInSettings.tsx: the device-code sign-in of a host's forge app (GitHub's
// "T3 Code for GitHub"), which lifts the per-user API rate limit to the app's. State, the card's subtitle and
// action, and the RPC payloads (`sourceControl.signInStart | signInWait | signInCancel`, `server.updateSettings`).
type Dict = Record<string, unknown>;

/** APP_SIGN_IN of packages/source-control-github/src/shared/definition.ts: the only built-in definition with an app. */
export interface AppSignInDefinition { appName: string; hosts: string[]; installUrl: string; revokeUrl: string }
export const APP_SIGN_INS: Record<string, AppSignInDefinition> = {
  github: {
    appName: "T3 Code for GitHub",
    hosts: ["github.com"],
    installUrl: "https://github.com/apps/t3-code-for-github/installations/new",
    revokeUrl: "https://github.com/settings/apps/authorizations",
  },
};

/** SourceControlSignInPrompt (contracts sourceControl.ts). */
export interface SignInPrompt { userCode: string; verificationUri: string; expiresAt: number }

export type SignInState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "waiting"; prompt: SignInPrompt }
  | { status: "failed"; message: string };

export function readSignInPrompt(value: unknown): SignInPrompt | null {
  const item = typeof value === "object" && value !== null ? (value as Dict) : null;
  if (!item || typeof item.userCode !== "string" || typeof item.verificationUri !== "string" || typeof item.expiresAt !== "number") return null;
  return { userCode: item.userCode, verificationUri: item.verificationUri, expiresAt: item.expiresAt };
}

/** The saved sign-ins and tokens of a provider's host: a sign-in is a non-empty (redacted) string, a token may also be a secret reference. */
export function readSignInSettings(settings: Dict | null, kind: string, host: string): { signIns: Record<string, string>; signedIn: boolean; tokenOverrides: boolean } {
  const mine = (settings?.sourceControlHosts as Dict | undefined)?.[kind] as Dict | undefined;
  const raw = (mine?.signIns && typeof mine.signIns === "object" ? mine.signIns : {}) as Record<string, unknown>;
  const signIns = Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  const tokens = (mine?.tokens && typeof mine.tokens === "object" ? mine.tokens : {}) as Record<string, unknown>;
  const token = tokens[host];
  // A token read from a secret provider overrides the sign-in like a saved one.
  const tokenOverrides = typeof token === "string" ? token.length > 0 : token !== undefined && token !== null;
  return { signIns, signedIn: (signIns[host] ?? "").length > 0, tokenOverrides };
}

/** Sign out sends the whole map, as other hosts' redaction markers preserve their sessions. */
export function signOutPatch(kind: string, signIns: Record<string, string>, host: string) {
  return { sourceControlHosts: { [kind]: { signIns: { ...signIns, [host]: "" } } } };
}

export const expiryTime = (expiresAt: number) => new Date(expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export interface SignInView { subtitle: string; action: "sign-out" | "cancel" | "sign-in"; actionLabel: string }

export function signInView(input: { signedIn: boolean; tokenOverrides: boolean; account: string | null; state: SignInState }): SignInView {
  if (input.signedIn) {
    return {
      subtitle: input.account !== null && !input.tokenOverrides ? `Signed in as ${input.account}` : input.tokenOverrides ? "Signed in, but the token saved below is used while it can be read." : "Signed in",
      action: "sign-out",
      actionLabel: "Sign out",
    };
  }
  if (input.state.status === "waiting") return { subtitle: "Approve the app on GitHub to finish signing in.", action: "cancel", actionLabel: "Cancel" };
  return {
    subtitle: "A far higher GitHub API rate limit than a personal token or gh login.",
    action: "sign-in",
    actionLabel: input.state.status === "failed" ? "Try again" : "Sign in with GitHub",
  };
}
