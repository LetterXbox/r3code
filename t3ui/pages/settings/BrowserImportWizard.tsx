// BrowserImportWizard.tsx: the cookie import dialog. Its steps (browserImportWizardLogic.ts) are Quit the browser, Full
// Disk Access, Configure (the From profile and the Into profile), Importing, Checking, Done and Blocked. The owner
// supplies the source, the target profiles and the callbacks that do the work: reading another browser's cookies needs
// the desktop shell's Keychain and SQLite access, which this client does not have, so nothing in the app opens it
// today (BrowserProfilesControl lists no importable browser).
import { signal, Text, View } from "nsh";
import { SettingsButton } from "../../components/SettingsLayout";
import { SettingsDialog } from "../../components/SettingsDialog";
import { SettingsIcon } from "./SettingsIcon";
import {
  BROWSER_IMPORT_FAILURE_COPY, canCloseWizard, cookieCountLabel, cookieResultCount, formatSkippedDomains, fullDiskAccessRecheckStep, initialTargetSelection, initialWizardStep,
  isRetryableReason, outcomeToStep, refreshedSourceProfileDirectory, refreshedSourceStep, resolveWizardTarget,
  type BrowserImportSource, type ImportOutcome, type WizardStep, type WizardTarget, type WizardTargetProfile, type WizardTargetSelection,
} from "./browserImportWizardLogic";

export interface BrowserImportWizardProps {
  source: BrowserImportSource;
  destinationEnvironmentName: string;
  targetProfiles: ReadonlyArray<WizardTargetProfile>;
  canCreateProfile: boolean;
  onImport: (input: { sourceProfileDirectory: string; target: WizardTarget }) => Promise<ImportOutcome>;
  onRefreshSource: () => Promise<BrowserImportSource | undefined>;
  onOpenFullDiskAccessSettings: () => void | Promise<void>;
  onCheckFullDiskAccess?: (() => Promise<boolean>) | undefined;
  onClose: () => void;
  /** A new profile's id, fresh per wizard (`profile-<uuid>` in the reference). */
  newProfileId?: string;
}

function Tile(props: { selected: boolean; title: string; subtitle?: string | undefined; onSelect: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={props.onSelect}
      class={`w-full flex-row items-center justify-between gap-3 rounded-lg border px-3 py-2 ${props.selected ? "border-primary bg-accent-50" : "border-border-60 hover:bg-muted-40"}`}
    >
      <View class="min-w-0 flex-1">
        <Text class="truncate text-sm font-medium text-foreground">{props.title}</Text>
        {props.subtitle ? <Text class="truncate text-xs text-muted-foreground">{props.subtitle}</Text> : null}
      </View>
      <View class={`size-4 items-center justify-center rounded-full border ${props.selected ? "border-primary bg-primary" : "border-input"}`}>
        {props.selected ? <SettingsIcon name="check" size={10} /> : null}
      </View>
    </View>
  );
}

const Label = (props: { children: any }) => <Text class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{props.children}</Text>;

export function BrowserImportWizard(props: BrowserImportWizardProps) {
  const source = signal(props.source);
  const step = signal<WizardStep>(initialWizardStep(props.source));
  const sourceProfileDirectory = signal(props.source.profiles[0]?.directory ?? "");
  const target = signal<WizardTargetSelection>(initialTargetSelection(props.canCreateProfile, props.targetProfiles));
  const targetError = signal<string | undefined>(undefined);
  const opening = signal(false);
  const openingError = signal<string | null>(null);
  const fullDiskAccess = signal(false);
  const newProfileId = props.newProfileId ?? `profile-${crypto.randomUUID()}`;
  // Guard synchronously so a second press cannot start a second import.
  let importInFlight = false;

  const runImport = () => {
    if (importInFlight) return;
    const chosen = resolveWizardTarget(target(), newProfileId, props.targetProfiles);
    if (chosen === undefined) {
      targetError.set("That profile is no longer available. Choose where to import these cookies.");
      step.set({ step: "configure" });
      return;
    }
    targetError.set(undefined);
    importInFlight = true;
    step.set({ step: "importing" });
    void props.onImport({ sourceProfileDirectory: sourceProfileDirectory(), target: chosen })
      .then((outcome) => step.set(outcomeToStep(outcome)))
      .catch(() => step.set({ step: "blocked", reason: "readFailed" }))
      .finally(() => { importInFlight = false; });
  };

  const recheckSource = (check: "browser" | "fullDiskAccess", next: (refreshed: BrowserImportSource | undefined) => WizardStep) => {
    step.set({ step: "checking", check });
    void props.onRefreshSource()
      .then((refreshed) => {
        if (refreshed) {
          source.set(refreshed);
          sourceProfileDirectory.update((current) => refreshedSourceProfileDirectory(current, refreshed));
        }
        step.set(next(refreshed));
      })
      .catch(() => step.set({ step: "blocked", reason: "readFailed" }));
  };

  const checkFullDiskAccess = async () => {
    const granted = props.onCheckFullDiskAccess ? await props.onCheckFullDiskAccess() : await props.onRefreshSource().then((refreshed) => refreshed !== undefined && refreshed.unavailable === undefined);
    fullDiskAccess.set(granted);
  };

  const allow = () => {
    if (opening()) return;
    opening.set(true);
    openingError.set(null);
    void Promise.resolve().then(props.onOpenFullDiskAccessSettings)
      .catch(() => openingError.set("Could not open System Settings. Try Allow again."))
      .finally(() => { opening.set(false); void checkFullDiskAccess().catch(() => undefined); });
  };

  const current = () => step();
  const name = () => source().name;
  const close = () => { if (canCloseWizard(current())) props.onClose(); };
  const title = (): string => {
    const s = current();
    switch (s.step) {
      case "quit": return `Quit ${name()} to import`;
      case "fullDiskAccess": return `Let R3 Code read ${name()}’s cookies`;
      case "importing": return "Importing cookies";
      case "checking": return `Checking ${name()}`;
      case "done": return s.imported > 0 ? `Imported ${cookieResultCount(s.imported)}` : s.skipped > 0 ? `Skipped ${cookieResultCount(s.skipped)}` : "No cookies found";
      case "blocked": return `Couldn’t import from ${name()}`;
      default: return `Import from ${name()}`;
    }
  };
  const description = (): string => {
    const s = current();
    switch (s.step) {
      case "quit": return `${name()} is open, so its cookies can’t be read yet. Quit it, then continue.`;
      case "fullDiskAccess": return `To import cookies from ${name()}, R3 Code needs Full Disk Access. Turn it on in System Settings, then come back to finish the import. You can revoke it again once the import is done.`;
      case "importing": return "This may take a moment.";
      case "checking": return s.check === "fullDiskAccess" ? "Checking Full Disk Access." : "Checking whether the browser has closed.";
      case "done": {
        const where = props.destinationEnvironmentName;
        return s.imported > 0
          ? `Added to ${s.targetName} for ${where}.${s.skipped > 0 ? ` ${cookieResultCount(s.skipped)} skipped.` : ""}`
          : s.skipped > 0 ? `No cookies were imported for ${where}.` : `There were no cookies to import for ${where}.`;
      }
      case "blocked": return s.message ?? BROWSER_IMPORT_FAILURE_COPY[s.reason];
      default: return `Choose which cookies to import for ${props.destinationEnvironmentName}.`;
    }
  };
  const targetMissing = () => target().kind === "existing" && !props.targetProfiles.some((profile) => profile.id === (target() as { profileId: string }).profileId);
  const targetUncreatable = () => target().kind === "new" && !props.canCreateProfile;
  const feedback = () => targetError() ?? (targetMissing() ? "That profile is no longer available. Choose where to import these cookies." : targetUncreatable() ? "You've reached the profile limit. Choose an existing profile to import into." : undefined);

  const body = () => {
    const s = current();
    switch (s.step) {
      case "fullDiskAccess":
        return (
          <View class="gap-3">
            <View class="flex-row items-center gap-3 rounded-lg border border-border px-3 py-2" testID={`Permission Full Disk Access (${fullDiskAccess() ? "granted" : "not granted"})`}>
              <SettingsIcon name="hard-drive" size={32} />
              <View class="min-w-0 flex-1">
                <Text class="text-sm font-medium text-foreground">Full Disk Access</Text>
                <Text class="text-xs text-muted-foreground">{`Read ${name()}'s cookies for this import.`}</Text>
              </View>
              {fullDiskAccess()
                ? <View class="flex-row items-center gap-1"><SettingsIcon name="check" size={16} /><Text class="text-xs text-success">Allowed</Text></View>
                : <SettingsButton label="Allow" disabled={opening()} onPress={allow} />}
            </View>
            {openingError() ? <Text class="text-xs text-muted-foreground">{openingError()}</Text> : null}
            {!fullDiskAccess() ? <Text class="text-xs text-muted-foreground">{s.checked === true ? "Access is still required. Quit and reopen R3 Code if you just allowed it, then retry the import." : "If access doesn't update after you allow it, quit and reopen R3 Code, then retry the import."}</Text> : null}
          </View>
        );
      case "importing":
        return <Text class="py-2 text-sm text-muted-foreground">Importing…</Text>;
      case "checking":
        return <Text class="py-2 text-sm text-muted-foreground">{s.check === "fullDiskAccess" ? "Checking access…" : "Checking…"}</Text>;
      case "done":
        return s.skippedDomains.length > 0 ? <View><Label>Skipped</Label><Text class="mt-1 text-sm text-foreground">{formatSkippedDomains(s.skippedDomains)}</Text></View> : null;
      case "quit":
      case "blocked":
        return null;
      default:
        return (
          <View class="gap-3">
            <View class="flex-row items-center gap-4">
              <View class="flex-1 gap-2">
                <Label>From</Label>
                {source().profiles.map((profile) => (
                  <Tile selected={sourceProfileDirectory() === profile.directory} title={profile.name ?? profile.directory} subtitle={cookieCountLabel(profile.cookieCount)} onSelect={() => sourceProfileDirectory.set(profile.directory)} />
                ))}
              </View>
              <SettingsIcon name="arrow-right" size={16} />
              <View class="flex-1 gap-2">
                <Label>Into</Label>
                {props.canCreateProfile ? <Tile selected={target().kind === "new"} title="New profile" subtitle="Created for these cookies" onSelect={() => { target.set({ kind: "new" }); targetError.set(undefined); }} /> : null}
                {props.targetProfiles.map((profile) => (
                  <Tile selected={target().kind === "existing" && (target() as { profileId: string }).profileId === profile.id} title={profile.name} subtitle="Existing profile" onSelect={() => { target.set({ kind: "existing", profileId: profile.id }); targetError.set(undefined); }} />
                ))}
              </View>
            </View>
            {feedback() ? <Text role="alert" class="text-sm text-destructive-foreground">{feedback()}</Text> : null}
          </View>
        );
    }
  };

  const footer = () => {
    const s = current();
    switch (s.step) {
      case "quit":
        return <><SettingsButton label="Cancel" onPress={props.onClose} /><SettingsButton label="I’ve quit it" tone="primary" onPress={() => recheckSource("browser", refreshedSourceStep)} /></>;
      case "fullDiskAccess":
        return <><SettingsButton label="Cancel" onPress={props.onClose} /><SettingsButton label="Continue" tone="primary" disabled={!fullDiskAccess() || opening()} onPress={s.resume === "import" ? runImport : () => recheckSource("fullDiskAccess", fullDiskAccessRecheckStep)} /></>;
      case "importing":
      case "checking":
        return null;
      case "done":
        return <SettingsButton label="Done" tone="primary" onPress={props.onClose} />;
      case "blocked":
        return <><SettingsButton label="Close" onPress={props.onClose} />{s.message === undefined && isRetryableReason(s.reason) ? <SettingsButton label="Try again" tone="primary" onPress={runImport} /> : null}</>;
      default:
        return <><SettingsButton label="Cancel" onPress={props.onClose} /><SettingsButton label="Import" tone="primary" disabled={sourceProfileDirectory() === "" || targetMissing() || targetUncreatable()} onPress={runImport} /></>;
    }
  };

  return (
    <SettingsDialog open onClose={close} title={title()} description={description()} width={512} testID="Browser import wizard" footer={footer()}>
      {body()}
    </SettingsDialog>
  );
}
