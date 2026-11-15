// BrowserProfilesSetting: the Browser profiles row. "Add profile" makes a blank profile or imports from another
// browser (the desktop shell's bridge, which a native client has none of: it says so); each listed profile can be
// renamed, made the default, cleared of cookies and cache on the server, and removed with its data.
import { signal, Text, View } from "nsh";
import { Input, Menu, MenuItem } from "nsh/base";
import { SettingsButton } from "../../components/SettingsLayout";
import { confirm, showToast } from "../../components/toast";
import { trackOpenChange, useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { backendStatus, settingValue, updateSetting } from "../../store";
import { managedCapabilityDenial } from "./managedPolicyLocks";
import { MENU_ITEM_ROW_CLASS } from "../../components/menuStyles";
import { serverEnvironment, serverManagedPolicy } from "./settingsState";
import { BrowserImportWizard } from "./BrowserImportWizard";
import { browserImportSession, browserImportSources, loadBrowserImportSources } from "./browserImportSources";
import { importableSources, type ImportOutcome } from "./browserImportWizardLogic";
import { openMacPermissionSettings } from "../../desktop/snapShot";
import { SettingsIcon } from "./SettingsIcon";
import { requestServer } from "./settingsSync";
import {
  BROWSER_PROFILE_MAX_COUNT, BROWSER_PROFILE_NAME_MAX_LENGTH, createProfile, isBuiltInProfileId, listedProfiles, parseUserProfiles, removeProfile, renameProfile, resolvedDefaultId,
  type BrowserProfile,
} from "./browserProfilesLogic";

const userProfiles = () => parseUserProfiles(settingValue("browserProfiles"));
const savedDefault = () => String(settingValue("browserDefaultProfileId") ?? "default");
const saveProfiles = (next: readonly BrowserProfile[]) => updateSetting("browserProfiles", JSON.stringify(next));
const connected = () => backendStatus() === "connected";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export async function clearData(profile: BrowserProfile, request: (method: string, payload: unknown) => Promise<unknown> = requestServer): Promise<boolean> {
  try {
    await request("preview.clearProfile", { profileId: profile.id });
    return true;
  } catch {
    // IntegrationsSettings clearProfileData: the failure toast names the profile only, never the server's error.
    showToast({ type: "error", title: `Could not clear ${profile.name}'s data` });
    return false;
  }
}

/** removeProfile's inline error under the list (IntegrationsSettings.tsx:1229, 1484-1487). */
const removalError = signal<string | null>(null);

function ProfileRow(props: { profile: BrowserProfile; first: boolean }) {
  const profile = props.profile;
  const open = signal(false);
  const draft = signal(profile.name);
  useOverlayOpen(open, "browser profile menu");
  const builtIn = isBuiltInProfileId(profile.id);
  const isDefault = () => resolvedDefaultId(userProfiles(), savedDefault()) === profile.id;
  const itemClass = MENU_ITEM_ROW_CLASS;
  const commit = () => { const next = draft().trim(); if (next && next !== profile.name) saveProfiles(renameProfile(userProfiles(), profile.id, next)); else draft.set(profile.name); };
  return (
    <View class={props.first ? "" : "border-t border-border-60"} testID={`Browser profile ${profile.name}`}>
      <View class="flex-row items-center gap-3 px-3 py-2">
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          {builtIn ? (
            <Text class="truncate text-sm text-foreground">{profile.name}</Text>
          ) : (
            <Input value={draft()} accessibilityLabel={`Rename ${profile.name}`} maxLength={BROWSER_PROFILE_NAME_MAX_LENGTH} onChange={(e: { value: string }) => draft.set(e.value)} onSubmit={commit} onBlur={commit} class="h-6.5 w-56 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground" />
          )}
          {isDefault() ? <View class="h-4.5 min-w-4.5 items-center justify-center rounded-sm border border-border px-1"><Text class="text-xs font-medium text-foreground">Default</Text></View> : null}
        </View>
        <Menu
          popupClass="min-w-52 rounded-lg border border-border bg-popover-84 p-1"
          align="end"
          onOpenChange={trackOpenChange(open)}
          trigger={<View role="button" accessibilityLabel={`${profile.name} options`} class="size-6 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><SettingsIcon name="ellipsis" size={14} /></View>}
        >
          <MenuItem accessibilityLabel="Set as default" disabled={isDefault()} class={itemClass} onSelect={() => updateSetting("browserDefaultProfileId", profile.id)}><Text class="text-sm text-popover-foreground">Set as default</Text></MenuItem>
          <MenuItem
            accessibilityLabel="Clear cookies and cache"
            disabled={!connected()}
            class={itemClass}
            onSelect={() => void clearData(profile).then((ok) => { if (ok) showToast({ type: "success", title: `Cleared ${profile.name}'s cookies and cache` }); })}
          ><Text class="text-sm text-popover-foreground">Clear cookies and cache</Text></MenuItem>
          {builtIn ? null : (
            <MenuItem
              accessibilityLabel="Remove profile and data"
              disabled={!connected()}
              class={itemClass}
              onSelect={() => void (async () => {
                if (!(await confirm(`Remove ${profile.name} and its data?\nIts cookies, logins and cache are deleted on every environment. This cannot be undone.`, { variant: "destructive" }))) return;
                removalError.set(null);
                try { await requestServer("preview.clearProfile", { profileId: profile.id }); }
                catch { removalError.set("Profile data could not be deleted. Try again."); return; }
                const next = removeProfile(userProfiles(), savedDefault(), profile.id);
                saveProfiles(next.profiles);
                if (next.defaultId !== savedDefault()) updateSetting("browserDefaultProfileId", next.defaultId);
              })()}
            ><Text class="text-sm text-destructive-foreground">Remove profile and data</Text></MenuItem>
          )}
          {!connected() ? <><View class="my-1 h-px bg-border" /><MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">Connect to an environment to clear profile data</Text></MenuItem></> : null}
        </Menu>
      </View>
    </View>
  );
}

/** The Add profile button: Blank profile, then the "Import from" group. */
export function BrowserProfilesControl() {
  const open = signal(false);
  useOverlayOpen(open, "add browser profile menu");
  const atLimit = () => userProfiles().length >= BROWSER_PROFILE_MAX_COUNT;
  const itemClass = MENU_ITEM_ROW_CLASS;
  // Cookie import runs on this device, whose policy the connected environment reports.
  const cookieImportDenial = () => managedCapabilityDenial(serverManagedPolicy(), "browserCookieImport");
  const environmentName = () => { const label = serverEnvironment()?.label; return typeof label === "string" && label.length > 0 ? label : "this environment"; };
  return (
    <>
    <Menu
      popupClass="min-w-56 rounded-lg border border-border bg-popover-84 p-1"
      align="end"
      onOpenChange={trackOpenChange(open, (event) => { if (event.open) void loadBrowserImportSources(); })}
      trigger={
        <View role="button" accessibilityLabel="Add profile" class="h-7 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <SettingsIcon name="plus" size={16} />
          <Text class="text-sm font-medium text-foreground">Add profile</Text>
        </View>
      }
    >
      <MenuItem accessibilityLabel="Blank profile" disabled={atLimit()} class={itemClass} onSelect={() => { const made = createProfile(userProfiles(), "New profile", `profile-${crypto.randomUUID()}`); if (made) saveProfiles(made.profiles); }}><Text class="text-sm text-popover-foreground">Blank profile</Text></MenuItem>
      {atLimit() ? <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">You've reached the profile limit</Text></MenuItem> : null}
      <View class="my-1 h-px bg-border" />
      <View class="px-2 py-1.5"><Text class="text-xs font-medium text-muted-foreground">Import from</Text></View>
      {cookieImportDenial() !== undefined ? (
        <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">{cookieImportDenial()!}</Text></MenuItem>
      ) : browserImportSources() === null ? (
        <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">Looking for browsers…</Text></MenuItem>
      ) : importableSources(browserImportSources()!).length === 0 ? (
        <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">No supported browsers found</Text></MenuItem>
      ) : (
        <>
          {importableSources(browserImportSources()!).map((source) => (
            <MenuItem accessibilityLabel={source.name} disabled={!connected()} class={itemClass} onSelect={() => { if (connected()) browserImportSession.set({ source, environmentName: environmentName() }); }}>
              <Text class="text-sm text-popover-foreground">{source.name}</Text>
            </MenuItem>
          ))}
          {!connected() ? <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">Connect to an environment to import cookies</Text></MenuItem> : null}
        </>
      )}
    </Menu>
    {browserImportSession() ? <ImportWizardHost /> : null}
    </>
  );
}

/** The wizard for the open import session: it imports into a listed profile or a new one, and reports to the page. */
function ImportWizardHost() {
  const session = browserImportSession()!;
  const profiles = () => listedProfiles(userProfiles()).map((profile) => ({ id: profile.id, name: profile.name }));
  return (
    <BrowserImportWizard
      source={session.source}
      destinationEnvironmentName={session.environmentName}
      targetProfiles={profiles()}
      canCreateProfile={userProfiles().length < BROWSER_PROFILE_MAX_COUNT}
      // The cookies are read by the desktop shell; this client has no reader, so an import is always blocked here.
      onImport={async (): Promise<ImportOutcome> => ({ kind: "blocked", reason: "unsupportedPlatform" })}
      onRefreshSource={async () => session.source}
      onOpenFullDiskAccessSettings={async () => { await openMacPermissionSettings("full-disk-access"); }}
      onClose={() => browserImportSession.set(null)}
    />
  );
}

/** The profiles listed under the row's description. */
export function BrowserProfilesList() {
  return (
    <View class="mx-4 mt-2 mb-2 overflow-hidden rounded-lg border border-border-60" testID="Browser profiles list">
      <Each of={listedProfiles(userProfiles())} key={(profile) => profile.id}>{(profile, index) => <ProfileRow profile={profile()} first={index() === 0} />}</Each>
      {removalError() ? <View class="border-t border-border-60 px-3 py-2"><Text class="text-sm text-destructive-foreground" testID="Browser profile removal error">{removalError()}</Text></View> : null}
    </View>
  );
}
