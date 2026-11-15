// settings/DesktopAppSettings.ts updateChannel / updateChannelConfiguredByUser (and normalizeDesktopSettings, setUpdateChannel):
// the update track the desktop app follows. It defaults to the track of the running build (desktopUpdateChannelOf) until
// the user chooses one; a saved choice wins afterwards. A legacy document that predates the flag counts as chosen when it
// holds nightly. This build has no updater (workspace/fix-brief.md: no updater), so the choice is saved and shown in
// Settings > About > Update track but nothing consumes it: no feed is read and no machine is moved.
import { signal } from "nsh";
import { desktop } from "./runtime";
import { updateChannelOf, type UpdateChannel } from "../pages/settings/updateTrackSwitch";

export const UPDATE_CHANNEL_KEY = "desktop_update_channel";

export interface DesktopUpdateChannelSettings { updateChannel: UpdateChannel; updateChannelConfiguredByUser: boolean }

const asChannel = (value: unknown): UpdateChannel | null => (value === "latest" || value === "nightly" ? value : null);

/** normalizeDesktopSettings: the saved document (or null) resolved against the running build's own track. */
export function resolveUpdateChannel(raw: string | null, appVersion: string): DesktopUpdateChannelSettings {
  const fallback = updateChannelOf(appVersion);
  let parsed: Record<string, unknown> = {};
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // A damaged document is the same as none.
  }
  const saved = asChannel(parsed.updateChannel);
  const legacy = parsed.updateChannelConfiguredByUser === undefined;
  const configured = parsed.updateChannelConfiguredByUser === true || (legacy && saved === "nightly");
  return { updateChannel: configured ? saved ?? fallback : fallback, updateChannelConfiguredByUser: configured };
}

/** setUpdateChannel: choosing the track the app already follows changes nothing; any other choice is the user's. */
export function withUpdateChannel(settings: DesktopUpdateChannelSettings, requested: UpdateChannel): DesktopUpdateChannelSettings {
  return settings.updateChannel === requested ? settings : { updateChannel: requested, updateChannelConfiguredByUser: true };
}

/** toDesktopSettingsDocument: only what differs from the defaults is kept. */
export function updateChannelDocument(settings: DesktopUpdateChannelSettings, appVersion: string): string | null {
  const defaults = updateChannelOf(appVersion);
  const document: Record<string, unknown> = {};
  if (settings.updateChannel !== defaults) document.updateChannel = settings.updateChannel;
  if (settings.updateChannelConfiguredByUser) document.updateChannelConfiguredByUser = true;
  return Object.keys(document).length === 0 ? null : JSON.stringify(document);
}

const state = signal<DesktopUpdateChannelSettings | null>(null);
let version = "";
let loading: Promise<void> | null = null;

/** The track in force; null until the saved document has been read. */
export const desktopUpdateChannel = (): UpdateChannel | null => state()?.updateChannel ?? null;

export function loadUpdateChannel(appVersion: string): Promise<void> {
  version = appVersion;
  loading ??= desktop().getItem(UPDATE_CHANNEL_KEY).catch(() => null).then((raw) => { state.set(resolveUpdateChannel(raw, version)); });
  return loading;
}

export async function setDesktopUpdateChannel(requested: UpdateChannel, appVersion: string): Promise<void> {
  await loadUpdateChannel(appVersion);
  const next = withUpdateChannel(state() ?? resolveUpdateChannel(null, appVersion), requested);
  state.set(next);
  await desktop().setItem(UPDATE_CHANNEL_KEY, updateChannelDocument(next, appVersion) ?? "{}");
}

/** Tests only. */
export function resetUpdateChannelForTest() { state.set(null); loading = null; }
