// components/onboarding/WelcomePage.tsx: the first-run page for the one computer: its agents, then Start. The title, the
// "Setting up <label>." line, the Agents band (found agents with their state, "Set up an agent" / "Add more agents" with the
// rest), the footer ("Start without an agent" / "Set up one agent to start." / Start) and the telemetry notice carry the
// web's copy. The Projects import band needs the history scan the web runs and the Phone band needs T3 Connect; neither
// exists here, and the web draws neither without them.
import { openUrl, Scroll, signal, Text, token, View } from "nsh";
import { allProjects, createThread, openSettings, providersLoaded, rawProviderRecords, refreshProviderStatuses, setProviderEnabled, startProviderInstall } from "../../store";
import { serverEnvironment, serverManagedPolicy, serverSettings } from "../../pages/settings/settingsState";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { Icon } from "../Icons";
import { errorToast } from "../toast/toastState";
import { AgentInstallTerminal, agentTerminalSession, closeAgentTerminal, openAgentTerminal } from "./AgentInstallTerminal";
import { PhoneSection } from "./PhoneSection";
import { hasCloudPublicConfig, welcomeOffersPhone } from "./phoneOffer";
import { primaryEnvironmentScope, RELAY_READ_SCOPE, RELAY_WRITE_SCOPE } from "../../cloud/t3ConnectState";
import { OnboardingIcon } from "./OnboardingIcon";
import { OnboardingCodexSetup } from "./OnboardingCodexSetup";
import { effect, untracked } from "nsh";
import { showToast } from "../toast/toastState";
import {
  IMPORT_SOURCES_LABEL,
  SCAN_LIMIT_MESSAGE,
  groupOnboardingProjects,
  splitOnboardingProjectPath,
  startLabel,
  type ImportCandidate,
} from "./projectImport.logic";
import {
  candidateKey,
  defaultCandidates,
  isNewCandidate,
  projectImportError,
  projectImporting,
  projectScan,
  projectScanError,
  projectScanPending,
  refreshProjectScan,
  runProjectImport,
  scanCandidates,
  selectedCandidates,
  setSelectedKeys,
} from "./projectImportState";
import { completeOnboarding } from "./firstRunState";
import { sessionScopeState, startSessionScopes, TERMINAL_OPERATE_SCOPE } from "../../backend/sessionScopes";
import {
  groupWelcomeAgents,
  isBrokenVersion,
  readWelcomeProvider,
  welcomeAgentAction,
  codexNeedsSetup,
  welcomeAgentDetail,
  welcomeAgentNotes,
  welcomeAgentState,
  type WelcomeAction,
  type WelcomeProvider,
  type WelcomeSettings,
} from "./welcomePage.logic";

const PRIVACY_POLICY_URL = "https://t3.codes/privacy-policy";

const providers = (): WelcomeProvider[] | null => (providersLoaded() ? rawProviderRecords().map(readWelcomeProvider).filter((item): item is WelcomeProvider => item !== null) : null);
const settings = (): WelcomeSettings => serverSettings() as WelcomeSettings;
const grouped = () => groupWelcomeAgents(providers(), settings());
const computerLabel = () => (typeof serverEnvironment()?.label === "string" && serverEnvironment()!.label ? String(serverEnvironment()!.label) : "this computer");

function Section(props: { title: string; children?: any }) {
  return (
    <View class="flex-row gap-x-10 border-b border-border-60 py-4">
      <Text class="w-24 shrink-0 text-sm leading-10 text-muted-foreground">{props.title}</Text>
      <View class="min-w-0 flex-1">{props.children}</View>
    </View>
  );
}

function SmallButton(props: { label: string; ariaLabel?: string; onPress: () => void; disabled?: boolean; icon?: boolean }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.ariaLabel ?? props.label}
      disabled={props.disabled === true}
      onPress={props.onPress}
      class={`h-6 shrink-0 flex-row items-center justify-center gap-1.5 rounded-lg border border-input bg-popover px-2 hover:bg-accent-50 ${props.disabled ? "opacity-64" : ""}`}
    >
      {props.icon ? <OnboardingIcon name="terminal" size={14} tint={token("foreground")} /> : null}
      <Text class="text-xs font-medium text-foreground">{props.label}</Text>
    </View>
  );
}

const busy = signal<string | null>(null);

async function turnOn(provider: WelcomeProvider) {
  busy.set(provider.instanceId);
  try {
    await setProviderEnabled(provider.instanceId, true);
    await refreshProviderStatuses({ instanceId: provider.instanceId, fresh: true });
    // The scan only reads agents that are on, so turning one on can find more history.
    void refreshProjectScan();
  } catch (error) {
    errorToast(`Could not turn on ${provider.displayName}`, error instanceof Error ? error.message : undefined);
  } finally {
    busy.set(null);
  }
}

async function install(provider: WelcomeProvider) {
  busy.set(provider.instanceId);
  try {
    await startProviderInstall(provider.instanceId);
  } catch (error) {
    errorToast(`Could not install ${provider.displayName}`, error instanceof Error ? error.message : undefined);
  } finally {
    busy.set(null);
  }
}

/** One action per agent, the same in the list and in the grid. Sign in and Set up lead to Settings, where the agent's own setup lives. */
/** The Codex instance whose setup card is open (codexSetupId); "Set up" on Codex toggles it. */
const codexSetupId = signal<string | null>(null);
/** codexCardProvider: the card stays while Codex still needs setup or is being checked. */
const codexSetupProvider = () => {
  const id = codexSetupId();
  const provider = id === null ? undefined : providers()?.find((item) => item.instanceId === id);
  return provider && (codexNeedsSetup(provider, settings()) || welcomeAgentState(provider, settings()) === "checking") ? provider : null;
};

function runAction(provider: WelcomeProvider, action: WelcomeAction) {
  if (provider.driver === "codex" && action.label === "Set up" && codexNeedsSetup(provider, settings())) { codexSetupId.set(codexSetupId() === provider.instanceId ? null : provider.instanceId); return; }
  if (action.kind === "turnOn") void turnOn(provider);
  else if ((action.label === "Install" || action.label === "Sign in") && openAgentTerminal(provider) !== null) return;
  else if (action.kind === "setUp" && action.label === "Install") void install(provider);
  else openSettings("/settings/providers");
}

function ActionButton(props: { provider: WelcomeProvider }) {
  const action = () => welcomeAgentAction(props.provider, settings());
  return action() ? (
    <SmallButton
      label={action()!.label}
      ariaLabel={`${action()!.label}: ${props.provider.displayName}`}
      disabled={busy() === props.provider.instanceId || agentTerminalSession()?.instanceId === props.provider.instanceId}
      icon={action()!.label === "Install" || action()!.label === "Sign in"}
      onPress={() => runAction(props.provider, action()!)}
    />
  ) : null;
}

function AgentRow(props: { provider: WelcomeProvider; compact?: boolean }) {
  const state = () => welcomeAgentState(props.provider, settings());
  const detail = () => welcomeAgentDetail(props.provider, state(), props.compact === true, isBrokenVersion(props.provider) ? props.provider.message : null);
  return (
    <View class={`flex-row items-center gap-3 ${props.compact ? "min-h-9" : "min-h-10 py-1"}`} accessibilityLabel={`Agent ${props.provider.displayName}`}>
      <View class="size-5 shrink-0 items-center justify-center">
        <ProviderIconView driver={props.provider.driver} instanceId={props.provider.instanceId} name={props.provider.displayName} size={props.compact ? 16 : 18} />
      </View>
      <View class="min-w-0 flex-1">
        <Text class={`text-sm text-foreground ${props.compact ? "" : "font-medium"}`}>{props.provider.displayName}</Text>
        {detail() ? <Text class="text-xs text-muted-foreground">{detail()}</Text> : null}
      </View>
      <View class="shrink-0">
        {state() === "ready" ? (
          <View class="flex-row items-center gap-1.5">
            <OnboardingIcon name="check" size={14} tint={token("success-foreground")} />
            <Text class="text-xs font-medium text-success-foreground">Ready</Text>
          </View>
        ) : state() === "checking" ? (
          <Text class="text-xs text-muted-foreground">Checking…</Text>
        ) : (
          <ActionButton provider={props.provider} />
        )}
      </View>
    </View>
  );
}

const moreOpenChoice = signal<boolean | null>(null);

function AgentsSection() {
  startSessionScopes();
  const group = () => grouped();
  // Opened once the finished checks find nothing, since adding an agent is then the task; a later check never closes it.
  const showMore = () => moreOpenChoice() ?? (!group().checking && group().found.length === 0);
  return (
    <Section title="Agents">
      {group().found.map((provider) => <AgentRow provider={provider} />)}
      {group().checking && group().found.length === 0 ? <Text class="text-sm leading-10 text-muted-foreground">Checking {computerLabel()}…</Text> : null}
      {welcomeAgentNotes({
        providers: [...group().found, ...group().available], settings: settings(),
        // useEnvironmentScope: unknown reads false in the reference; the note waits for the session here instead of flashing.
        canOperateTerminal: sessionScopeState(TERMINAL_OPERATE_SCOPE) !== "denied",
        canManageProviders: sessionScopeState("providers:manage") !== "denied",
      }).map((note) => <Text class="pl-8 text-xs text-muted-foreground">{note}</Text>)}
      <View
        role="button"
        accessibilityLabel={group().found.length > 0 ? "Add more agents" : "Set up an agent"}
        onPress={() => moreOpenChoice.set(!showMore())}
        class="min-h-10 flex-row items-center gap-3 rounded-md"
      >
        <View class="size-5 shrink-0 items-center justify-center"><OnboardingIcon name="plus" size={16} /></View>
        <Text class={`text-sm ${group().found.length > 0 ? "text-muted-foreground" : "text-foreground"}`}>{group().found.length > 0 ? "Add more agents" : "Set up an agent"}</Text>
        {/* AgentLogoStack: up to six available agents' marks, size-3.5, gap-2, opacity-60 (no grayscale filter here). */}
        {showMore() || group().available.length === 0 ? null : (
          <View class="flex-row items-center gap-1 opacity-60">
            {group().available.slice(0, 6).map((provider) => <ProviderIconView driver={provider.driver} instanceId={provider.instanceId} name={provider.displayName} size={18} />)}
          </View>
        )}
        <View class="ml-auto"><Icon name="chevron-down" size={16} tint={token("muted-foreground")} /></View>
      </View>
      {showMore() ? (
        <View class="flex-row flex-wrap gap-x-8">
          {group().available.map((provider) => <View class="min-w-64 flex-1"><AgentRow provider={provider} compact /></View>)}
        </View>
      ) : null}
      {codexSetupProvider() ? <OnboardingCodexSetup instanceId={codexSetupProvider()!.instanceId}
        readOnly={sessionScopeState("providers:manage") === "denied"} existingCliDisabled={sessionScopeState(TERMINAL_OPERATE_SCOPE) === "denied"}
        onUseCliChange={(useCli) => { const provider = codexSetupProvider(); if (useCli && provider) openAgentTerminal(provider); }} /> : null}
      {agentTerminalSession() ? <AgentInstallTerminal onClose={() => { closeAgentTerminal(); void refreshProviderStatuses().catch(() => undefined); }} /> : null}
    </Section>
  );
}

function TelemetryNotice() {
  const off = () => {
    const policy = serverManagedPolicy();
    const limits = policy?.limits as { telemetry?: unknown } | undefined;
    return limits?.telemetry === false && typeof policy?.organization === "string" ? `${policy.organization} turned off anonymous usage data.` : undefined;
  };
  return (
    <View class="mt-auto pt-12">
      <Text class="text-2xs text-muted-foreground-80">
        {off() ?? "R3 Code collects anonymous usage data to improve the app."} {off() === undefined ? "To opt out, see the" : "See the"}{" "}
        <Text class="text-2xs text-muted-foreground-80 underline" onPress={() => void openUrl(PRIVACY_POLICY_URL).catch(() => undefined)} accessibilityLabel="privacy policy" role="link">privacy policy</Text>.
      </Text>
    </View>
  );
}

const reviewing = signal(false);

function CandidateRow(props: { candidate: ImportCandidate; nested?: boolean }) {
  const checked = () => selectedCandidates().some((item) => candidateKey(item) === candidateKey(props.candidate));
  const toggle = () => {
    const keys = selectedCandidates().map(candidateKey);
    const key = candidateKey(props.candidate);
    setSelectedKeys(checked() ? keys.filter((item) => item !== key) : [...keys, key]);
  };
  const path = splitOnboardingProjectPath(props.candidate.path);
  return (
    <View role="checkbox" accessibilityLabel={`Import ${props.candidate.path}`} onPress={toggle} class={`min-h-8 flex-row items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent ${props.nested ? "pl-8" : ""}`}>
      <Checkmark checked={checked} />
      <Text class="min-w-0 flex-1 text-sm text-foreground">{`${props.candidate.git?.repository ?? props.candidate.title}  `}<Text class="text-2xs text-muted-foreground">{`${path.parent}${path.name}`}</Text></Text>
      <Text class="shrink-0 text-xs text-muted-foreground">{props.candidate.threadCount}</Text>
    </View>
  );
}

const otherFoldersOpen = signal(false);

/** ImportProjectList's "Other folders": the non-repository candidates in a collapsible group with a tri-state checkbox. */
function OtherFolders(props: { other: ImportCandidate[] }) {
  const keys = () => props.other.map(candidateKey);
  const selectedCount = () => { const chosen = new Set(selectedCandidates().map(candidateKey)); return keys().filter((key) => chosen.has(key)).length; };
  const all = () => selectedCount() === props.other.length;
  const toggleAll = () => {
    const current = selectedCandidates().map(candidateKey);
    const group = new Set(keys());
    setSelectedKeys(all() ? current.filter((key) => !group.has(key)) : [...new Set([...current, ...keys()])]);
  };
  return (
    <View>
      <View class="min-h-8 flex-row items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted-40">
        <View role="checkbox" accessibilityLabel="Select other folders" accessibilityState={{ checked: all() }} onPress={toggleAll}>
          <Checkmark checked={all} partial={() => selectedCount() > 0 && !all()} />
        </View>
        <View role="button" accessibilityLabel="Other folders" onPress={() => otherFoldersOpen.set(!otherFoldersOpen())} class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Icon name={otherFoldersOpen() ? "chevron-down" : "chevron-right"} size={14} tint={token("muted-foreground")} />
          <Text class="truncate text-sm text-muted-foreground">Other folders</Text>
          <Text class="ml-auto shrink-0 text-xs text-muted-foreground">{`${props.other.length} ${props.other.length === 1 ? "folder" : "folders"}`}</Text>
        </View>
      </View>
      {otherFoldersOpen() ? props.other.map((candidate) => <CandidateRow candidate={candidate} nested />) : null}
    </View>
  );
}

function Checkmark(props: { checked: () => boolean; partial?: () => boolean }) {
  return (
    <View class={`size-4 shrink-0 items-center justify-center rounded-sm border ${props.checked() || props.partial?.() ? "border-primary bg-primary" : "border-input bg-background"}`}>
      {props.checked() ? <OnboardingIcon name="check" size={12} tint={token("primary-foreground")} /> : null}
    </View>
  );
}

/** The band changes with the scan (pending, failed, empty, listed), so the page reads the branch afresh each time. */
function ProjectsSection() {
  return <>{projectsBand()}</>;
}

function projectsBand() {
  const candidates = () => scanCandidates();
  const selected = () => selectedCandidates();
  const defaults = () => defaultCandidates();
  const partial = () => selected().length > 0 && selected().length < candidates().length && !(selected().length === defaults().length && defaults().every((item) => selected().some((chosen) => candidateKey(chosen) === candidateKey(item))));
  const retry = <SmallButton label="Retry" onPress={() => void refreshProjectScan()} />;
  if (projectScanPending() && candidates().length === 0) {
    return <Section title="Projects"><Text class="text-sm leading-10 text-muted-foreground">{`Looking for projects in your ${IMPORT_SOURCES_LABEL} history…`}</Text></Section>;
  }
  if (projectScanError() !== null && candidates().length === 0) {
    return (
      <Section title="Projects">
        <View role="alert" class="min-h-10 flex-row items-center justify-between gap-3">
          <Text class="min-w-0 flex-1 text-sm text-muted-foreground">{`Could not check projects. ${projectScanError()}`}</Text>
          {retry}
        </View>
      </Section>
    );
  }
  if (projectScan() === null) return null;
  if (candidates().length === 0) {
    return projectScan()?.truncated ? <Section title="Projects"><Text class="text-xs leading-10 text-muted-foreground">{SCAN_LIMIT_MESSAGE}</Text></Section> : null;
  }
  const groups = () => groupOnboardingProjects(candidates());
  return (
    <Section title="Projects">
      <View class="min-h-10 flex-row items-center gap-3 py-1">
        <View
          role="checkbox"
          accessibilityLabel="Import projects and their threads"
          disabled={projectImporting()}
          onPress={() => (selected().length > 0 ? setSelectedKeys([], true) : setSelectedKeys(defaults().map(candidateKey)))}
          class="min-w-0 flex-1 flex-row items-center gap-3"
        >
          <View class="size-5 shrink-0 items-center justify-center"><Checkmark checked={() => selected().length > 0} partial={partial} /></View>
          <View class="min-w-0 flex-1">
            <Text class="text-sm font-medium text-foreground">{selected().length > 0 ? `Import ${selected().length} ${selected().length === 1 ? "project" : "projects"} and their threads` : "Import projects and their threads"}</Text>
            <Text class="text-xs text-muted-foreground">{`From your ${IMPORT_SOURCES_LABEL} history`}</Text>
          </View>
        </View>
        <View role="button" accessibilityLabel={reviewing() ? "Hide" : `Review all ${candidates().length}`} onPress={() => reviewing.set(!reviewing())} class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent">
          <Text class="text-xs font-medium text-muted-foreground">{reviewing() ? "Hide" : `Review all ${candidates().length}`}</Text>
          <Icon name="chevron-down" size={14} tint={token("muted-foreground")} />
        </View>
      </View>
      {reviewing() ? (
        <View class="mt-1">
          <View class="flex-row items-center justify-between gap-3 px-2">
            <Text class="text-xs text-muted-foreground">{`${selected().length} of ${candidates().length} selected`}</Text>
            <View class="flex-row items-center gap-1">
              <SmallButton label="Select all" disabled={selected().length === candidates().length} onPress={() => setSelectedKeys(candidates().map(candidateKey))} />
              <SmallButton label="Select none" disabled={selected().length === 0} onPress={() => setSelectedKeys([], true)} />
            </View>
          </View>
          <Scroll class="mt-1 max-h-80">
            {groups().repositories.flatMap((group) => group.candidates).map((candidate) => <CandidateRow candidate={candidate} />)}
            {groups().other.length > 0 ? <OtherFolders other={groups().other} /> : null}
          </Scroll>
        </View>
      ) : null}
      {projectScan()?.truncated ? <Text class="pl-8 text-xs text-muted-foreground">{SCAN_LIMIT_MESSAGE}</Text> : null}
      {projectScanError() !== null ? (
        <View role="alert" class="flex-row items-center justify-between gap-3 pl-8">
          <Text class="min-w-0 flex-1 text-sm text-muted-foreground">{`Could not check projects again. ${projectScanError()}`}</Text>
          {retry}
        </View>
      ) : null}
      {projectImportError() ? <Text class="pl-8 pt-1 text-sm text-destructive">{projectImportError()}</Text> : null}
    </Section>
  );
}

const starting = signal(false);

/** waitForProject (state/entities.ts): resolves once the project reaches the client, false after 10 s. */
export async function waitForProject(projectId: string, read: () => ReadonlyArray<{ id: string }> = allProjects, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!read().some((project) => project.id === projectId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/** Start: imports the picked projects, stamps onboarding complete, then hands over to the app. A failed write keeps the page and says so.
 * routes/welcome.tsx onDone: with an imported project the app lands on a new thread in it (one whose history came over first). */
export async function finishWelcome(onDone: () => void, openNewThread: (projectId: string) => void = (projectId) => createThread(projectId), read?: () => ReadonlyArray<{ id: string }>) {
  if (starting() || projectImporting()) return;
  starting.set(true);
  try {
    const selection = selectedCandidates();
    const outcome = selection.length > 0 ? await runProjectImport(selection) : { importedThreads: 0, warning: "", landingProjectId: null };
    const landing = outcome.landingProjectId && (await waitForProject(outcome.landingProjectId, read)) ? outcome.landingProjectId : null;
    await completeOnboarding();
    onDone();
    if (landing) openNewThread(landing);
    if (outcome.warning) showToast({ type: "warning", title: "Some history was not imported", description: outcome.warning, timeoutMs: 0 });
    else if (outcome.importedThreads > 0) showToast({ type: "success", title: `Imported ${outcome.importedThreads} ${outcome.importedThreads === 1 ? "thread" : "threads"}` });
  } catch {
    errorToast("Could not finish setup", "Your settings could not be saved. Try again.");
  } finally {
    starting.set(false);
  }
}

export function WelcomePage(props: { onDone: () => void }) {
  const agentReady = () => grouped().readyCount > 0;
  const busy = () => starting() || projectImporting();
  const newCount = () => selectedCandidates().filter(isNewCandidate).length;
  effect(() => { untracked(() => { void refreshProjectScan(); }); });
  return (
    <View class="absolute inset-0 z-30 flex-1 bg-background" accessibilityLabel="Welcome" testID="Welcome page">
      <View class="h-[52px] shrink-0" desktop={{ windowDrag: true }} />
      <Scroll class="min-h-0 flex-1">
        <View class="mx-auto min-h-full w-full max-w-3xl px-6 pb-8 pt-20">
          <Text class="text-2xl font-semibold text-foreground">Welcome to R3 Code</Text>
          <Text class="mt-1.5 text-sm text-muted-foreground">Setting up <Text class="text-sm text-foreground">{computerLabel()}</Text>.</Text>
          <View class="mt-10 border-t border-border-60">
            <AgentsSection />
            <ProjectsSection />
            {welcomeOffersPhone({ isPrimary: true, cloud: hasCloudPublicConfig(), canShare: primaryEnvironmentScope(RELAY_READ_SCOPE) && primaryEnvironmentScope(RELAY_WRITE_SCOPE), policy: serverManagedPolicy() as any }) ? <PhoneSection /> : null}
          </View>
          <View class="mt-6 flex-row flex-wrap items-center justify-between gap-3">
            {agentReady() ? <View /> : (
              <View role="button" accessibilityLabel="Start without an agent" disabled={busy()} onPress={() => void finishWelcome(props.onDone)} class="h-8 items-center justify-center rounded-lg px-3 hover:bg-accent">
                <Text class="text-sm font-medium text-muted-foreground">Start without an agent</Text>
              </View>
            )}
            <View class="flex-row items-center gap-3">
              {agentReady() ? null : <Text class="text-xs text-muted-foreground">Set up one agent to start.</Text>}
              <View
                role="button"
                accessibilityLabel="Start"
                disabled={!agentReady() || busy()}
                onPress={() => void finishWelcome(props.onDone)}
                class={`h-8 items-center justify-center rounded-lg bg-primary px-3 ${!agentReady() || busy() ? "opacity-64" : ""}`}
              >
                <Text class="text-sm font-medium text-primary-foreground">{startLabel({ importing: busy(), selected: selectedCandidates().length, newCount: newCount() })}</Text>
              </View>
            </View>
          </View>
          <TelemetryNotice />
        </View>
      </Scroll>
    </View>
  );
}
