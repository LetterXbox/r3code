// components/desktopUpdate.logic.ts and desktopUpdate.toast.tsx: the toast that follows an update download, from the desktop updater's state.
// The state comes from the host's updater (the web reads it from `desktopBridge.getUpdateState` and its change events); NSH has no updater API,
// so `installDesktopUpdateToast` waits for the host function `desktop.updateState` (see the report) and does nothing until the host has it.
import { host, openUrl } from "nsh";
import { showToast } from "../toast/toastState";

/** DesktopUpdateState, as far as the toast reads it. */
export interface DesktopUpdateState {
  status: "disabled" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error";
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent?: number | null;
  errorContext?: string | null;
  hostArch?: string;
  appArch?: string;
}

const DEFAULT_REPOSITORY = "pingdotgg/t3code";
const SEGMENT = /^[A-Za-z0-9._-]+$/u;
const valid = (value: string | undefined): value is string => value !== undefined && value !== "." && value !== ".." && SEGMENT.test(value);

function releaseRepositoryUrl(repository: string | undefined): string {
  const configured = repository?.trim() ?? "";
  const [owner, name, ...extra] = configured.split("/");
  return `https://github.com/${valid(owner) && valid(name) && extra.length === 0 ? configured : DEFAULT_REPOSITORY}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export const getDesktopUpdateDownloadedVersion = (state: DesktopUpdateState) => state.downloadedVersion ?? state.availableVersion;

export function getDesktopUpdateReleaseUrl(version: string | null, repository?: string): string | null {
  const normalized = version?.trim();
  return normalized ? `${releaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalized)}` : null;
}

export type DesktopUpdateButtonAction = "download" | "install" | "none";

export function resolveDesktopUpdateButtonAction(state: DesktopUpdateState): DesktopUpdateButtonAction {
  if (state.downloadedVersion && (state.status === "downloaded" || (state.status === "error" && (state.errorContext === null || state.errorContext === undefined || state.errorContext === "install")))) return "install";
  if (state.status === "available") return "download";
  if (state.status === "error" && state.errorContext === "download" && state.availableVersion) return "download";
  return "none";
}

/** "Update downloaded", with a Read more action to the release notes when the version is known. */
export function showDesktopUpdateDownloadedToast(state: DesktopUpdateState, open: (url: string) => Promise<unknown> = openUrl) {
  const releaseUrl = getDesktopUpdateReleaseUrl(getDesktopUpdateDownloadedVersion(state));
  return showToast({
    type: "success",
    title: "Update downloaded",
    description: "Restart the app from the update button to install it.",
    // desktopUpdate.toast.tsx: toastManager.add (its Read more is a link in the description), the inline layout.
    actionLayout: "inline",
    actions: releaseUrl ? [{ label: "Read more", variant: "ghost", run: () => { void open(releaseUrl).then((opened) => { if (opened === false || (typeof opened === "object" && opened && (opened as { opened?: boolean }).opened === false)) showToast({ type: "error", title: "Unable to open release notes" }); }).catch(() => showToast({ type: "error", title: "Unable to open release notes" })); } }] : [],
  });
}

/** Raises the toast when a download finishes (status moves to "downloaded"); `observe` is fed each updater state. */
export function createDesktopUpdateObserver(show: (state: DesktopUpdateState) => unknown = showDesktopUpdateDownloadedToast) {
  let last: DesktopUpdateState["status"] | null = null;
  return (state: DesktopUpdateState | null) => {
    if (state && state.status === "downloaded" && last !== "downloaded") show(state);
    if (state) last = state.status;
  };
}

/** Follows the host's updater: its `desktop.updateState` event, and the function of the same name for the state at launch. Does nothing without them. */
export function installDesktopUpdateToast() {
  if (!host.available()) return;
  const observe = createDesktopUpdateObserver();
  host.on("desktop.updateState", (payload) => observe(payload as DesktopUpdateState | null));
  void host.call("desktop.updateState", {}).then((state) => observe(state as DesktopUpdateState | null)).catch(() => undefined);
}
