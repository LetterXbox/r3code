import { mount, signal, Text, View } from "nsh";
import { BrowserImportWizard } from "./BrowserImportWizard";
import type { BrowserImportSource, ImportOutcome } from "./browserImportWizardLogic";

const chrome: BrowserImportSource = { id: "chrome", name: "Chrome", profiles: [{ directory: "Default", name: "Person 1", cookieCount: 1234 }, { directory: "Profile 2", name: "Work", cookieCount: 1 }] };
const active = signal<"ok" | "running" | "keychain" | "unsupported" | "fda" | "noop" | null>(null);
const log = signal<string[]>([]);
const say = (line: string) => log.update((all) => [...all, line]);
const targets = [{ id: "default", name: "Default" }, { id: "work", name: "Work" }];
let attempts = 0;

const wizard = (source: BrowserImportSource, over: Partial<Parameters<typeof BrowserImportWizard>[0]> = {}) => (
  <BrowserImportWizard
    source={source}
    destinationEnvironmentName="Studio"
    targetProfiles={targets}
    canCreateProfile={true}
    newProfileId="profile-test"
    onImport={async (input): Promise<ImportOutcome> => {
      say(`import ${input.sourceProfileDirectory} -> ${input.target.kind}:${input.target.profileId}`);
      attempts += 1;
      if (active() === "keychain" && attempts < 2) return { kind: "blocked", reason: "needsKeychainApproval" };
      return { kind: "imported", imported: 1234, skipped: 3, skippedDomains: ["a.com", "b.com", "c.com", "d.com"], targetName: "Chrome" };
    }}
    onRefreshSource={async () => { say("refresh"); return { ...source, unavailable: undefined }; }}
    onOpenFullDiskAccessSettings={() => say("open settings")}
    onCheckFullDiskAccess={async () => true}
    onClose={() => { say("close"); active.set(null); }}
    {...over}
  />
);

mount(() => (
  <View class="flex-1 gap-2">
    {(["ok", "running", "keychain", "unsupported", "fda"] as const).map((id) => <View accessibilityLabel={`open ${id}`} onPress={() => { attempts = 0; active.set(id); }}><Text>{`open ${id}`}</Text></View>)}
    <Text>{`log ${log().join(" | ")}`}</Text>
    {active() === "ok" ? wizard(chrome) : null}
    {active() === "running" ? wizard({ ...chrome, unavailable: "browserRunning" }) : null}
    {active() === "keychain" ? wizard({ ...chrome, unavailable: undefined }) : null}
    {active() === "unsupported" ? wizard({ ...chrome, unavailable: "unsupportedPlatform" }) : null}
    {active() === "fda" ? wizard({ ...chrome, unavailable: "needsFullDiskAccess" }) : null}
  </View>
));
