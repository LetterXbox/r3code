// AboutSettingsPanel (SettingsPanels.tsx): App (Organization when the environment is managed,
// Version with its copyable number, Mobile app, Welcome page) and Legal. The desktop shell's own
// rows: the update button belongs to the Electron app's bridge, which this app does not
// have, so it is not drawn; Update track is drawn and saved but nothing follows it (no updater) (the `t3` command is desktop/CliCommandRow.tsx); the web's non-desktop page omits them too.
import { showAnchoredCopyErrorToast, showAnchoredCopySuccessToast, type ToastAnchor } from "../../components/toast/anchoredToast";
import { Clipboard, openUrl, signal, Text, View } from "nsh";
import { Popover } from "nsh/base";
import { QrCodeView } from "../../components/QrCodeView";
import { SettingsButton, SettingsRow, SettingsSection } from "../../components/SettingsLayout";
import { backendStatus, closeSettings, openSettings } from "../../store";
import { SettingsIcon } from "./SettingsIcon";
import { errorToast } from "../../components/toast";
import { openWelcomePage } from "../../components/onboarding/firstRunState";
import { serverEnvironment, serverManagedPolicy } from "./settingsState";
import { TargetRow } from "./TargetRow";
import { CliCommandSettingsRow } from "../../desktop/CliCommandRow";
import { SettingsSelect } from "../../components/SettingsLayout";
import { desktopUpdateChannel, loadUpdateChannel, setDesktopUpdateChannel } from "../../desktop/updateChannel";
import { updateChannelOf, type UpdateChannel } from "./updateTrackSwitch";
import { buildIdentity } from "../../buildIdentity";
import { SettingsDialog } from "../../components/SettingsDialog";

const PATH = "/settings/about";
const PRIVACY_POLICY_URL = "https://t3.codes/privacy-policy";
const STORES = [
  { label: "iPhone and iPad", store: "App Store", url: "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824", icon: "apple" },
  { label: "Android", store: "Google Play", url: "https://play.google.com/store/apps/details?id=com.t3tools.t3code", icon: "android" },
];

export function buildVersionLabel(): string {
  const dirty = (value: boolean) => value ? "+dirty" : "";
  return `R3 ${buildIdentity.r3Version} (${buildIdentity.r3Sha}${dirty(buildIdentity.r3Dirty)}) - T3 ${buildIdentity.t3Version} (${buildIdentity.t3Sha}${dirty(buildIdentity.t3Dirty)})`;
}

/** The running server's version, which is what this client talks to. */
export function aboutVersion(): string {
  const version = serverEnvironment()?.serverVersion;
  return typeof version === "string" && version.length > 0 ? version : "Unknown";
}

/** SettingsPanels.tsx AboutVersionSection's Update track row (desktop variant). The choice is saved (desktop/updateChannel.ts) but
 * this build has no updater and no machine server updates, so nothing follows it: no feed is read and no machine is moved. */
function UpdateTrackControl() {
  const version = aboutVersion();
  void loadUpdateChannel(version);
  const selected = () => desktopUpdateChannel() ?? updateChannelOf(version);
  return (
    <SettingsSelect
      label="Update track"
      value={selected()}
      compactWidth={160}
      options={[{ value: "latest", label: "Stable" }, { value: "nightly", label: "Nightly" }]}
      onChange={(next) => { if (next !== selected()) void setDesktopUpdateChannel(next as UpdateChannel, version); }}
    />
  );
}

const copied = signal(false);
const r3PrivacyOpen = signal(false);
let versionAnchor: ToastAnchor | null = null;

/** AboutVersionTitle: "Version" and the number, which copies itself. */
function VersionTitle() {
  return (
    <View class="flex-row items-baseline gap-2">
      <Text class="text-sm font-medium text-foreground">Version</Text>
      <View
        role="button"
        accessibilityLabel={`Copy version ${buildVersionLabel()}`}
        tooltip={copied() ? "Copied" : "Copy version"}
        ref={(node: ToastAnchor | null) => { versionAnchor = node; }}
        // AboutVersionTitle: the copy confirms with the anchored "Copied!" toast at the number.
        onPress={() => { const anchor = versionAnchor; void Clipboard.writeText(buildVersionLabel()).then(() => { copied.set(true); setTimeout(() => copied.set(false), 1500); if (anchor) void showAnchoredCopySuccessToast(anchor); }).catch((error: unknown) => { if (anchor) void showAnchoredCopyErrorToast(anchor, error instanceof Error ? error : new Error(String(error))); else errorToast("Could not copy version", error instanceof Error ? error.message : String(error)); }); }}
      >
        <Text class="text-2xs font-medium text-muted-foreground hover:text-foreground">{buildVersionLabel()}</Text>
      </View>
    </View>
  );
}

const open = signal<string | null>(null);

/** MobileAppSettingsRow: one outline button per store, each opening a popover with the store's QR code. */
function MobileAppControl() {
  return (
    <View class="flex-row items-center gap-2">
      {STORES.map((entry) => (
        <Popover
          open={open() === entry.store}
          onOpenChange={(event) => open.set(event.open ? entry.store : open() === entry.store ? null : open())}
          placement="bottom"
          align="end"
          offset={6}
          popupClass="items-center gap-3 rounded-lg border border-border bg-popover-84 p-4"
          trigger={
            <View role="button" accessibilityLabel={entry.label} class="h-7 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
              <SettingsIcon name={entry.icon} size={14} />
              <Text class="text-xs font-medium text-foreground">{entry.label}</Text>
            </View>
          }
        >
          <View class="items-center gap-3">
            <Text class="text-base font-semibold text-popover-foreground">{entry.store}</Text>
            <Text class="text-xs text-muted-foreground">Scan with your phone camera.</Text>
            <QrCodeView value={entry.url} size={128} marginSize={1} title={`${entry.store} link`} />
            <SettingsButton label={`Open ${entry.store}`} onPress={() => void openUrl(entry.url).catch(() => undefined)} />
          </View>
        </Popover>
      ))}
    </View>
  );
}

export function AboutSettings() {
  const policy = () => serverManagedPolicy();
  const organization = () => (typeof policy()?.organization === "string" ? String(policy()!.organization) : null);
  const supportUrl = () => (typeof policy()?.supportUrl === "string" ? String(policy()!.supportUrl) : null);
  const connected = () => backendStatus() === "connected";
  return (
    <>
      <SettingsSection title="App">
        {organization() ? (
          <TargetRow path={PATH} id={null} title="Organization" first>
            <SettingsRow
              title="Organization"
              description={`This environment is managed by ${organization()}. Some settings and features follow its policy.`}
              control={supportUrl() ? <SettingsButton label="Get help" onPress={() => void openUrl(supportUrl()!).catch(() => undefined)} /> : undefined}
            />
          </TargetRow>
        ) : null}
        <TargetRow path={PATH} id="app-version" title="Version" first={!organization()}>
          <SettingsRow title="Version" titleNode={<VersionTitle />} description={`Selected official T3 release: ${buildIdentity.officialT3Version} (${buildIdentity.officialT3Sha}).`} />
        </TargetRow>
        <TargetRow path={PATH} id="update-track" title="Update track">
          <SettingsRow
            title="Update track"
            description="Switches this app and every connected machine whose database the target release supports."
            control={<UpdateTrackControl />}
          />
        </TargetRow>
        <CliCommandSettingsRow path={PATH} />
        <TargetRow path={PATH} id="mobile-app" title="Mobile app">
          <SettingsRow title="Mobile app" description="Connect to your server from your phone or tablet." control={<MobileAppControl />} />
        </TargetRow>
        {connected() ? (
          <TargetRow path={PATH} id="welcome-page" title="Welcome page">
            <SettingsRow
              title="Welcome page"
              description="See your agents, import projects, and set up your phone."
              control={<SettingsButton label="Open" onPress={() => { closeSettings(); openWelcomePage(); }} />}
            />
          </TargetRow>
        ) : null}
      </SettingsSection>
      <SettingsSection title="Credits">
        <SettingsRow title="T3 Code" description="Original application by the T3 Code authors and contributors." control={<SettingsButton label="View project" onPress={() => void openUrl("https://github.com/pingdotgg/t3code").catch(() => undefined)} />} />
        <SettingsRow title="Rust Client by Jason Kneen" description="R3 Code client and Rust implementation." control={
          <View class="flex-row items-center gap-2">
            <SettingsButton label="GitHub" onPress={() => void openUrl("https://github.com/jasonkneen").catch(() => undefined)} />
            <SettingsButton label="X" onPress={() => void openUrl("https://x.com/Jasonkneen").catch(() => undefined)} />
          </View>
        } />
      </SettingsSection>
      <SettingsSection title="Legal">
        <TargetRow path={PATH} id="privacy-policy" title="Privacy policy" first>
          <SettingsRow
            title="R3 Code privacy policy"
            description="Draft information about how R3 Code handles data."
            control={<SettingsButton label="View draft" onPress={() => r3PrivacyOpen.set(true)} />}
          />
        </TargetRow>
        <SettingsRow title="T3 Code privacy policy" description="The original T3 Code project's policy." control={<SettingsButton label="View policy" onPress={() => void openUrl(PRIVACY_POLICY_URL).catch(() => undefined)} />} />
        <TargetRow path={PATH} id="open-source-licenses" title="Open source licenses">
          <SettingsRow
            title="Open source licenses"
            description="Notices for dependencies, assets, and optional tools used by R3 Code."
            control={<SettingsButton label="View licenses" onPress={() => openSettings("/settings/open-source-licenses")} />}
          />
        </TargetRow>
      </SettingsSection>
      <SettingsDialog open={r3PrivacyOpen()} title="R3 Code privacy policy (draft)" onClose={() => r3PrivacyOpen.set(false)}>
        <Text class="text-sm text-foreground">This draft needs review before publication. R3 Code handles information you enter or open, including conversations, files, settings and account information; the app and connected environments may store it locally.</Text>
        <Text class="text-sm text-foreground">When you use a provider, remote environment, T3 Connect or another service, the information needed for your requested action is sent to that service. Its privacy and retention practices apply. macOS controls access to resources such as files, the microphone, camera and screen capture.</Text>
        <Text class="text-sm text-foreground">Logs and exported diagnostics can contain sensitive data. Review them before sharing. Removing the app may not remove data from connected services or all local application data. Contact details, retention, deletion and applicable rights still need to be confirmed before this policy is published.</Text>
      </SettingsDialog>
    </>
  );
}
