// One renderer for every generated settings panel. The sections, rows, copy,
// controls and defaults come from settingsPanels.ts, which
// tools/gen_settings_panels.py extracts from the web app's own source, so a
// panel is data rather than 300 lines of retyped JSX.
import { SettingsIcon } from "./SettingsIcon";
import { isValidSearchUrlTemplate } from "../../components/browser/addressBar";
import { computed, reduceMotion, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { ViewRef } from "nsh";
import {
  SettingResetButton,
  SettingsButton,
  SettingsError,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSlider,
  SettingsSwitch,
  SettingsText,
} from "../../components/SettingsLayout";
import { WRITING_STYLE_MODES, resetValue, resolveControl, writingStyleOf } from "./controlSpecs";
import { RetentionControl } from "./RetentionControl";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { AdvancedFold } from "./AdvancedFold";
import { staticControlFor, staticDescriptionFor, staticResetFor } from "./StaticControls";
import { clearSettingsWriteError, isServerConnected, readSetting, settingsWriteError, writeSetting } from "./settingsSync";
import { SETTINGS_PANELS, type SettingsPanelRow, type SettingsPanelSection } from "../../settingsPanels";
import { openSettings, settingsLanding } from "../../store";
import { serverEnvironment } from "./settingsState";
import { ConnectionSettings } from "./Connection";
import { AccessSettings } from "./environments/AccessPanel";
import { AboutSettings } from "./AboutPanel";
import { AppearanceSettings } from "./Appearance";
import { TypographySection } from "./Typography";
import { ArchivedSettings } from "./Archived";
import { ProjectSettings } from "./WorkspacePanels";
import { ProjectsPage } from "./ProjectsPage";
import { configureDevices, DeviceSources, deviceToolLabel, DeviceToolVersionsTail } from "./DeviceSources";
import { BrowserProfilesList } from "./BrowserProfiles";
import { VoiceSettings } from "./voice/VoiceSettings";
import { SnapShotsSettings } from "./fidelity/SnapShotsPanel";
import { SnoozeOptions } from "./fidelity/SnoozeOptions";
import { KeybindingsSettings } from "./Keybindings";
import { ProviderSettings } from "./ProviderSettings";
import { DiagnosticsSettings } from "./Diagnostics";
import { managedSettingLock } from "./managedPolicyLocks";
import { serverManagedPolicy } from "./settingsState";
import { showToast } from "../../components/toast";
import { InheritanceMark } from "./InheritanceMark";
import { ScopeNotice, ScopeSentence, scopeBlockMessage } from "./ScopeSentence";
import { cleanupMode, clearOverrides, currentScope, isProjectScope, scopeEnvironments, readScoped, sourceOf, writeScoped, writeScopedPatch } from "./scopeState";
import { SETTINGS_DEVICE_ONLY_PATHS, isProjectScopedKey } from "./scopeCore";
import { registerSettingsRow, rowTargetId, settingsTarget } from "./settingsSearchNav";
import { SearchAnchor } from "./SearchAnchor";
import { OpenSourceLicenses } from "./OpenSourceLicenses";
import { SearchScopeNotice, searchScopeNotice } from "./SearchScopeNotice";
import { SourceControlDiscovery } from "./SourceControlDiscovery";
import { DatabaseStorageNotice } from "./Storage";
import { ScheduledTasks } from "../../components/scheduled/ScheduledTasks";
import { SearchTargetPulse } from "../../components/motion/Motion";

export function panelFor(path: string) {
  return SETTINGS_PANELS.find((p) => p.path === path) ?? null;
}

/** Selects the web draws as `<SelectTrigger size="sm" className="w-full sm:w-N">` (SettingsPanels.tsx, NotificationSettings.tsx). */
const COMPACT_SELECT_WIDTH: Record<string, number> = {
  notificationMode: 224,
  responseStreamingMode: 224,
  idleCompaction: 224,
  sidebarProjectSortOrder: 176,
  // `sm:w-40`
  timestampFormat: 160,
  toolCallVisibility: 160,
  diffLayout: 160,
  diffFilesCollapsed: 160,
  diffColorScheme: 160,
  confirmQuit: 160,
  browserDefaultZoomFactor: 160,
};

function Control(props: { row: SettingsPanelRow }) {
  const row = props.row;
  // A link row is a door to a subpage (`Diagnostics`, `Open source
  // licenses`) rather than a setting. Those subpages are not in the nav, so
  // the row is the only way in.
  if (row.control === "link") {
    if (!row.target) return null;
    return <SettingsButton label="View" onPress={() => openSettings(row.target!)} />;
  }
  const staticControl = staticControlFor(row.id);
  if (staticControl) return <>{staticControl()}</>;
  // The project's cleanup mode is one of inherit / off / custom (StorageSettings.tsx), not a plain field.
  if (row.field === "worktreeCleanup") {
    return (
      <SettingsSelect
        label="Automatic worktree cleanup"
        value={cleanupMode()}
        options={[{ value: "inherit", label: "Inherit" }, { value: "off", label: "Off" }, { value: "custom", label: "Custom" }]}
        onChange={(next) => {
          if (next === "inherit") void clearOverrides(["worktreeCleanup"]);
          else void writeScopedPatch({ worktreeCleanup: next === "off" ? { mode: "off" } : { mode: "custom", rules: {} } });
        }}
      />
    );
  }
  const spec = resolveControl(row);
  // A row with no control of its own shows its title and description only; the reference draws no placeholder.
  if (!spec) return null;
  // A component body runs once (nsh is fine-grained, not re-rendering), so
  // the signal is read *inside* the JSX attributes: a read hoisted into a
  // local would freeze at its first value.
  const raw = () => readScoped(spec.field, spec.scope);
  const save = (next: string | boolean | number) => void writeScoped(spec.field, spec.scope, spec.write(next, raw()));
  // The control's accessible name where the web gives it one apart from the row title.
  const controlLabel = CONTROL_LABELS[spec.field] ?? row.title;
  // DeviceIntegrationControls: the hub and (outside a project) agent access go through device.configure, not a settings write.
  if (row.id === "device-hub" || (row.id === "agent-device-access" && !isProjectScope())) {
    return <SettingsSwitch label={controlLabel} checked={spec.read(raw()) === true} onChange={(on) => void configureDevices(row.id === "device-hub" ? { enabled: on, ...(on ? {} : { agentAccessEnabled: false }) } : { agentAccessEnabled: on })} />;
  }
  if (spec.kind === "switch") {
    return <SettingsSwitch label={controlLabel} checked={spec.read(raw()) === true} onChange={save} />;
  }
  if (spec.kind === "select") {
    // The two small addition/deletion dots before the closed trigger's text (SettingsPanels.tsx
    // DiffColorsSettingsRow): reversed when "blue-orange" is chosen, as the reference reverses its row.
    const diffDots = spec.field === "diffColorScheme" ? () => {
      const blueOrange = String(spec.read(raw())) === "blue-orange";
      return (
        <View class={blueOrange ? "flex-row-reverse gap-1" : "flex-row gap-1"}>
          <View class="size-2 rounded-full" style={{ backgroundColor: blueOrange ? "#f97316" : "#ef4444" }} />
          <View class="size-2 rounded-full" style={{ backgroundColor: blueOrange ? "#3b82f6" : "#10b981" }} />
        </View>
      );
    } : undefined;
    return <SettingsSelect label={controlLabel} value={String(spec.read(raw()))} options={spec.options} onChange={save} compactWidth={COMPACT_SELECT_WIDTH[spec.field]} leading={diffDots} />;
  }
  if (spec.kind === "retention") {
    return <RetentionControl label={row.title} value={spec.read(raw()) as string | number} minimum={spec.min ?? 1} onChange={save} />;
  }
  if (spec.kind === "number") {
    // The reference draws a preview of the panels' motion beside the "Panel animations" slider (AppearanceSettingsPanel.tsx:365).
    if (spec.field === "panelAnimationDurationMs") {
      return (
        <View class="flex-row items-center gap-4">
          <PanelAnimationsPreview durationMs={() => Number(spec.read(raw()))} />
          <SettingsSlider label={controlLabel} value={Number(spec.read(raw()))} min={spec.min ?? 0} max={spec.max ?? 100} step={spec.step ?? 1} unit={spec.unit} onChange={save} />
        </View>
      );
    }
    return (
      <SettingsSlider
        label={row.title}
        value={Number(spec.read(raw()))}
        min={spec.min ?? 0}
        max={spec.max ?? 100}
        step={spec.step ?? 1}
        unit={spec.unit}
        onChange={save}
      />
    );
  }
  return <SettingsText label={row.title} value={String(spec.read(raw()))} placeholder={row.placeholder ?? null} widthClass={row.field === "addProjectBaseDirectory" ? "w-72" : undefined} onChange={save} />;
}

/** The organization that pins this row's setting through its policy (`managed` of SettingsRow), if any. */
function lockedBy(row: SettingsPanelRow): string | undefined {
  const own = staticResetFor(row.id);
  const spec = resolveControl(row);
  if (!own?.keys && (!spec || spec.scope !== "server")) return undefined;
  const paths = own?.keys ? own.keys : spec!.field === "storageCleanup" && row.field ? [`storageCleanup.${row.field}`, "worktreeCleanup"] : [spec!.field];
  const policy = serverManagedPolicy();
  for (const path of paths) { const organization = managedSettingLock(policy, path); if (organization) return organization; }
  return undefined;
}

/** A control the policy has locked: dimmed, and a press says who manages it. */
function LockableControl(props: { row: SettingsPanelRow }) {
  return (
    <View class="relative" testID={`Control ${props.row.title} (${lockedBy(props.row) ? "managed" : "free"})`}>
      <View class={lockedBy(props.row) ? "opacity-50" : ""}><Control row={props.row} /></View>
      {lockedBy(props.row) ? <View class="absolute inset-0" role="button" accessibilityLabel={`${props.row.title} is managed`} onPress={() => showToast({ type: "info", title: `Managed by ${lockedBy(props.row)}.` })} /> : null}
    </View>
  );
}

/** Rows whose undo mark names the setting or its tip differently from the row title (ProjectDefaultsSettings.tsx:431,454-455,485). */
const RESET_COPY: Record<string, { label?: string; tooltip?: string }> = {
  defaultAutoPull: { label: "default automatic pull", tooltip: "Reset automatic pull to off" },
  removeAgentCreditsOnMerge: { label: "agent credit removal", tooltip: "Keep agent credits" },
  pullRequestMergeMethod: { label: "default merge method", tooltip: "Reset to last selected" },
  worktreeSubmodules: { label: "worktree submodules" },
  enableAgentBrowserAccess: { label: "default browser access" },
  mathRenderingEnabled: { label: "math rendering" },
  wordWrap: { label: "word wrapping" },
};

/** WorktreesSettings.tsx:47 and ProjectDefaultsSettings.tsx:562. */
const CONTROL_LABELS: Record<string, string> = {
  enableDeviceSupport: "Device hub",
  persistComposerContextStrip: "Keep composer context visible in active threads",
  panelAnimationDurationMs: "Panel animation duration",
  enableAgentDeviceAccess: "Agent device access",
  newWorktreesStartFromOrigin: "Start new worktrees from remote by default",
  worktreeSubmodules: "Worktree submodules",
};

const NULL_RESETS = new Set(["pullRequestMergeMethod", "worktreeSubmodules"]);

/** The undo mark, shown only while a value differs from its shipped default. */
function Reset(props: { row: SettingsPanelRow }) {
  if (lockedBy(props.row)) return <View />;
  const own = staticResetFor(props.row.id);
  if (own) {
    // In a project scope the mark clears the project's override instead.
    const projectKeys = () => (own.keys && isProjectScope() && own.keys.every(isProjectScopedKey) ? own.keys : null);
    return (
      <View>
        {projectKeys() ? (
          sourceOf(projectKeys()!) === "project" ? <SettingResetButton label={props.row.title} onPress={() => void clearOverrides(projectKeys()!)} /> : null
        ) : own.differs() ? <SettingResetButton label={props.row.title} onPress={own.reset} /> : null}
      </View>
    );
  }
  const spec = resolveControl(props.row);
  // A null default ("last selected" merge method, submodules from t3.json) resets by clearing the stored value.
  const clearsToNull = spec !== null && spec.fallback === null && NULL_RESETS.has(spec.field);
  if (!spec || (spec.fallback === null && !clearsToNull)) return null;
  const differs = () => (clearsToNull ? (readScoped(spec.field, spec.scope) ?? null) !== null : String(spec.read(readScoped(spec.field, spec.scope))) !== String(spec.read(spec.fallback)));
  // In a project scope the mark clears the project's override ("Reset to inherited value"); an
  // environment-wide setting has no override to clear.
  const projectKey = () => isProjectScope() && spec.scope === "server" && isProjectScopedKey(spec.field);
  return (
    <View>
      {projectKey() ? (
        sourceOf([spec.field]) === "project" ? <SettingResetButton label={props.row.title} onPress={() => void clearOverrides([spec.field])} /> : null
      ) : differs() && !isProjectScope() ? (
        <SettingResetButton label={RESET_COPY[spec.field]?.label ?? props.row.title} tooltip={RESET_COPY[spec.field]?.tooltip} onPress={() => void writeScoped(spec.field, spec.scope, clearsToNull ? null : resetValue(spec, readScoped(spec.field, spec.scope)))} />
      ) : null}
    </View>
  );
}


/** The Cleanup rules, which a project edits only while its cleanup mode is Custom (StorageSettings.tsx). */
const CLEANUP_RULE_FIELDS = new Set(["worktreeOnDelete", "worktreeOnMerge", "worktreeAfterDays", "worktreeSettledAfterDays", "worktreeUnchanged", "worktreeKeepWhen"]);

/**
 * Rows folded behind "Advanced" at the end of their card: StorageSettings.tsx's Cleanup card and the Threads
 * page's Text generation card (SettingsPanels.tsx: `<AdvancedSettings>` around thread title instructions and
 * response streaming).
 */
const ADVANCED_TITLES_BY_PATH: Record<string, ReadonlySet<string>> = {
  "/settings/worktrees": new Set(["Submodules", "Delete settled worktrees", "Delete unchanged worktrees", "Keep worktrees with local changes"]),
  "/settings/threads": new Set(["Thread title instructions", "Response streaming"]),
  // SettingsPanels.tsx ChatSettingsPanel wraps this row in <AdvancedSettings> under Composer.
  "/settings/chat": new Set(["Show skills in slash menu"]),
};

const RESPONSE_STREAMING_DESCRIPTIONS: Record<string, string> = {
  turn: "Text appears once the agent finishes its turn.",
  paragraph: "Each paragraph or code block appears as soon as it is complete.",
};

const KEEP_WHEN_DESCRIPTIONS: Record<string, string> = {
  "any-local-files": "Includes ignored files, except node_modules.",
  "tracked-changes": "Deletes untracked and ignored files, including .env.",
  "uncommitted-changes": "Keeps edits and untracked files. Deletes ignored files, including .env.",
};

function visibleRows(section: SettingsPanelSection) {
  // A search target the page draws as a whole card has no row of its own.
  return section.rows.filter((row) => row.indexOnly !== true);
}
function sectionRows(path: string, section: SettingsPanelSection) {
  const rows = visibleRows(section);
  const folded = ADVANCED_TITLES_BY_PATH[path];
  return folded ? rows.filter((row) => !folded.has(row.title)) : rows;
}
function advancedRows(path: string, section: SettingsPanelSection) {
  const folded = ADVANCED_TITLES_BY_PATH[path];
  return folded ? visibleRows(section).filter((row) => folded.has(row.title)) : [];
}

function isTarget(path: string, row: SettingsPanelRow) {
  return settingsTarget()?.path === path && settingsTarget()?.id === rowTargetId(path, row.id, row.title);
}

/** The row's description: generated, except where the web computes it from the value. */
function descriptionFor(row: SettingsPanelRow): string | undefined {
  const computed = staticDescriptionFor(row.id);
  if (computed) return computed;
  // DeviceIntegrationControls (IntegrationsSettings.tsx): the hub and agent-device versions follow the copy.
  if (row.id === "device-hub") return `Open simulators and emulators in the Device panel. Hub: `;
  if (row.id === "agent-device-access") return `New agent sessions can open and drive these devices. agent-device: `;
  if (row.id === "source-control-writing-style") return WRITING_STYLE_MODES[writingStyleOf(readSetting("sourceControlWritingStyle", "server")).mode]?.description;
  if (row.field === "worktreeCleanup") {
    const mode = cleanupMode();
    return mode === "off" ? "Keep this project's worktrees until you delete them manually." : mode === "custom" ? "Use these rules for this project." : "Use each machine's worktree cleanup settings.";
  }
  // ProjectDefaultsSettings.tsx:541-546 WorktreeSubmodulesSetting.
  // IntegrationsSettings.tsx:1045-1051 AgentBrowserAccessSetting.
  if (row.field === "enableAgentBrowserAccess") return isProjectScope() ? "Allow agents in this project to use the shared browser. Applies when the agent session next starts." : "Allow agents to use the shared browser. Projects can override it.";
  if (row.field === "worktreeSubmodules") return isProjectScope() ? "How new worktrees in this project populate git submodules." : "How new worktrees populate git submodules. Projects and their t3.json can override it.";
  if (row.field === "responseStreamingMode") return RESPONSE_STREAMING_DESCRIPTIONS[String(readScoped("responseStreamingMode", "server"))] ?? RESPONSE_STREAMING_DESCRIPTIONS.turn;
  if (row.field === "worktreeKeepWhen") {
    const stored = readSetting("storageCleanup", "server") as Record<string, unknown> | null | undefined;
    return KEEP_WHEN_DESCRIPTIONS[String(stored?.worktreeKeepWhen ?? "uncommitted-changes")] ?? KEEP_WHEN_DESCRIPTIONS["uncommitted-changes"];
  }
  return row.description ?? undefined;
}

/** The textarea under the writing select while its mode is Custom instructions; it commits when the user pauses. */
function WritingInstructions() {
  const style = () => writingStyleOf(readSetting("sourceControlWritingStyle", "server"));
  const draft = signal("");
  let shown: string | null = null;
  let timer: number | null = null;
  const value = () => { const saved = style().customInstructions; if (saved !== shown) { shown = saved; draft.set(saved); } return draft(); };
  const commit = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const next = draft().trim();
    if (next === style().customInstructions) return;
    void writeSetting("sourceControlWritingStyle", "server", { ...style(), customInstructions: next } as never);
  };
  return (
    <View>
      {style().mode === "custom" ? (
        <View class="max-w-2xl px-4 pb-3.5">
          <Input
            multiline
            value={value()}
            placeholder="Keep commit subjects under 60 characters. Keep pull request descriptions short and plain."
            accessibilityLabel="Custom commit and pull request instructions"
            onChange={(e: { value: string }) => { draft.set(e.value); if (timer) clearTimeout(timer); timer = setTimeout(commit, 600); }}
            class="min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
        </View>
      ) : null}
    </View>
  );
}

/** The layers mark: server settings only, and only where a scope is in play (the page is not device-only). */
function ScopedMark(props: { row: SettingsPanelRow; rowHovered?: () => boolean }) {
  const own = staticResetFor(props.row.id);
  if (own?.keys) return <View class={isServerConnected() ? "" : "-mr-1.5"}>{isServerConnected() ? <InheritanceMark title={props.row.title} keys={own.keys} rowHovered={props.rowHovered} /> : null}</View>;
  const spec = resolveControl(props.row);
  if (!spec || spec.scope !== "server") return <View class="-mr-1.5" />;
  // An absent mark leaves no gap beside the reset mark.
  return <View class={isServerConnected() ? "" : "-mr-1.5"}>{isServerConnected() ? <InheritanceMark title={props.row.title} keys={[spec.field]} rowHovered={props.rowHovered} /> : null}</View>;
}

/** Rows the web draws only above a project scope (ProjectDefaultsSettings: `fallbackRow` is null for a project). */
const ENVIRONMENT_WIDE_ROW_IDS = new Set(["fallback-model"]);
/** Rows the web draws only while auto-settle after inactivity is on (`settings.sidebarAutoSettleAfterDays !== null`). */
const AUTO_SETTLE_DEPENDENT_TITLES = new Set(["Days of inactivity before auto-settle", "Keep threads with a PR"]);

/** Rows of Labs that depend on something else (LabsSettingsPanel.tsx). */
const LABS_DEPENDENT_TITLES = new Set(["Two-line folder rows", "Fast worktree checkout"]);

function rowHidden(row: SettingsPanelRow): boolean {
  // Two-line folder rows nest under the boring sidebar switch; fast checkout shows only when the server honours it.
  if (row.title === "Two-line folder rows") return readSetting("boringSidebarEnabled", "client") !== true;
  if (row.title === "Fast worktree checkout") {
    const capabilities = (serverEnvironment()?.capabilities ?? {}) as Record<string, unknown>;
    return isProjectScope() || !isServerConnected() || capabilities.fastWorktreeCheckout !== true;
  }
  // Automatic worktree cleanup, and the rules it unlocks, belong to a project scope only where it says Custom.
  if (row.field === "worktreeCleanup") return !isProjectScope();
  if (row.field && CLEANUP_RULE_FIELDS.has(row.field) && isProjectScope()) return cleanupMode() !== "custom";
  if (row.id === "storage-worktrees-location") return isProjectScope();
  if (row.id && ENVIRONMENT_WIDE_ROW_IDS.has(row.id)) return isProjectScope();
  if (AUTO_SETTLE_DEPENDENT_TITLES.has(row.title)) return readScoped("sidebarAutoSettleAfterDays", "server") == null;
  return false;
}

function renderRow(path: string, row: SettingsPanelRow, i: number) {
  const gated = (row.id && ENVIRONMENT_WIDE_ROW_IDS.has(row.id)) || AUTO_SETTLE_DEPENDENT_TITLES.has(row.title) || LABS_DEPENDENT_TITLES.has(row.title) || row.field === "worktreeCleanup" || row.id === "storage-worktrees-location" || (row.field !== null && CLEANUP_RULE_FIELDS.has(row.field));
  return gated ? <View>{rowHidden(row) ? null : renderRowBody(path, row, i)}</View> : renderRowBody(path, row, i);
}

function renderRowBody(path: string, row: SettingsPanelRow, i: number) {
  return (
    <View
      ref={(node: ViewRef) => registerSettingsRow(path, rowTargetId(path, row.id, row.title), node)}
      testID={`Settings row ${rowTargetId(path, row.id, row.title)} (${isTarget(path, row) ? "target" : "idle"})`}
      class={isTarget(path, row) ? "bg-accent-50" : undefined}
    >
      {isTarget(path, row) && !reduceMotion() ? <SearchTargetPulse /> : null}
      {i > 0 ? <View class="h-px bg-border-50" /> : null}
      <SettingsRow
        title={row.title}
        titleNode={row.id === "background-activity" ? <BackgroundPolicyTitle title={row.title} /> : undefined}
        description={descriptionFor(row)}
        descriptionTail={row.id === "device-hub" ? deviceToolLabel("hub") : row.id === "agent-device-access" ? deviceToolLabel("agent") : undefined}
        descriptionAction={row.id === "device-hub" ? <DeviceToolVersionsTail kind="hub" /> : row.id === "agent-device-access" ? <DeviceToolVersionsTail kind="agent" /> : undefined}
        resetAction={<Reset row={row} />}
        status={row.field === "browserCustomSearchUrl" ? <CustomSearchUrlStatus /> : undefined}
        inheritance={(rowHovered: () => boolean) => <ScopedMark row={row} rowHovered={rowHovered} />}
        control={<LockableControl row={row} />}
      />
      {row.id === "source-control-writing-style" ? <WritingInstructions /> : null}
      {row.id === "snooze-options" ? <SnoozeOptions /> : null}
      {row.id === "browser-profiles" ? <BrowserProfilesList /> : null}
    </View>
  );
}

/** IntegrationsSettings.tsx:756-760: a template without http(s) and %s falls back to DuckDuckGo, and says so. */
function CustomSearchUrlStatus() {
  const value = () => String(readSetting("browserCustomSearchUrl", "client") ?? "");
  return <>{isValidSearchUrlTemplate(value()) ? null : <Text class="text-xs text-muted-foreground">Enter an http or https URL containing %s. Searches use DuckDuckGo until then.</Text>}</>;
}

/** PolicyTooltip (settingsLayout.tsx:191-205) beside the Background activity title. */
function BackgroundPolicyTitle(props: { title: string }) {
  return (
    <View class="flex-row items-center gap-1.5">
      <Text class="text-sm font-medium text-foreground">{props.title}</Text>
      <View role="button" accessibilityLabel="Background policy details" class="size-4 items-center justify-center rounded-sm hover:bg-accent" tooltip="This shared policy gates background work such as Git refreshes and provider health probes after their individual intervals elapse.">
        <SettingsIcon name="info" size={14} />
      </View>
    </View>
  );
}

/** The generated sections of a page, in order. The discovery of the Source control page sits between them, outside this expression. */
function sectionsView(path: string, sections: SettingsPanelSection[]) {
  return sections.filter((section) => !(path === "/settings/maintenance" && section.title === "Database") && visibleRows(section).length > 0).map((section) => (
    <>
    {path === "/settings/appearance" && section.title === "Typography" ? <TypographySection /> : (
    <SettingsSection title={section.title}>
      {sectionRows(path, section).map((row, i) => renderRow(path, row, i))}
      {advancedRows(path, section).length > 0 ? (
        <AdvancedFold forceOpen={() => advancedRows(path, section).some((row) => isTarget(path, row))}>
          {advancedRows(path, section).map((row, i) => renderRow(path, row, i + 1))}
        </AdvancedFold>
      ) : null}
    </SettingsSection>)}
    </>
  ));
}

/** The page itself, for a scope that has the setting. */
function PanelBody(props: { path: string; panel: NonNullable<ReturnType<typeof panelFor>> }) {
  const panel = props.panel;
  // Config snapshots replace environment objects even when connectivity did
  // not change. Keep the provider panel mounted across equivalent snapshots.
  const providerMessage = computed(providersEnvironmentMessage);
  return (
    <View class="gap-8">
      {props.path === "/settings/connections" ? <ConnectionSettings /> : null}
        {props.path === "/settings/access" ? <AccessSettings /> : null}
        {props.path === "/settings/about" ? <AboutSettings /> : null}
        {props.path === "/settings/appearance" ? <SearchAnchor path="/settings/appearance" id="appearance" class="gap-8"><AppearanceSettings /></SearchAnchor> : null}
        {props.path === "/settings/archived" ? <ArchivedSettings /> : null}
        {props.path === "/settings/projects" ? <ProjectsPage /> : null}
        {props.path === "/settings/providers" ? (providerMessage() ? <Text class="p-8 text-sm text-muted-foreground">{providerMessage()}</Text> : <SearchAnchor path="/settings/providers" id="providers"><ProviderSettings /></SearchAnchor>) : null}
        {props.path === "/settings/keybindings" ? <SearchAnchor path="/settings/keybindings" id="keybindings" class="gap-8"><KeybindingsSettings /></SearchAnchor> : null}
        {props.path === "/settings/scheduled-tasks" ? <ScheduledTasks /> : null}
        {props.path === "/settings/diagnostics" ? <DiagnosticsSettings /> : null}
        {props.path === "/settings/voice" ? <VoiceSettings /> : null}
        {props.path === "/settings/snap-shot" ? <SnapShotsSettings /> : null}
        {props.path === "/settings/open-source-licenses" ? <OpenSourceLicenses /> : null}
        {! ["/settings/open-source-licenses", "/settings/voice", "/settings/snap-shot", "/settings/archived", "/settings/connections", "/settings/access", "/settings/about", "/settings/projects", "/settings/providers", "/settings/keybindings", "/settings/scheduled-tasks", "/settings/diagnostics"].includes(props.path) ? sectionsView(props.path, props.path === "/settings/source-control" ? panel.sections.slice(0, 1) : panel.sections) : null}
        {props.path === "/settings/source-control" ? <SourceControlDiscovery /> : null}
        {props.path === "/settings/source-control" ? sectionsView(props.path, panel.sections.slice(1)) : null}
        {props.path === "/settings/maintenance" ? <DatabaseStorageNotice /> : null}
        {props.path === "/settings/devices" ? <DeviceSources /> : null}
    </View>
  );
}

/** _chat.settings.providers.tsx: with no environment in scope the page says how to get one. */
export function providersEnvironmentMessage(): string | null {
  const scope = currentScope();
  const environments = scopeEnvironments();
  const environment = scope.kind === "environment"
    ? environments.find((candidate) => candidate.environmentId === scope.environmentId && candidate.connected)
    : environments.find((candidate) => candidate.connected);
  if (environment) return null;
  return scope.kind === "environment" ? `Reconnect ${scope.label} to set up its providers.` : "Connect an environment to set up its providers.";
}

export function SettingsPanel(props: { path: string }) {
  const panel = panelFor(props.path);
  if (!panel) return null;
  // A failed write belongs to the panel it happened on.
  clearSettingsWriteError();
  const scoped = !SETTINGS_DEVICE_ONLY_PATHS.has(props.path);
  // SettingsScopeBoundary: a scope that is gone or offline shows its sentence instead of the page (Projects always shows).
  const blocked = computed(() => (scoped && props.path !== "/settings/projects" ? scopeBlockMessage() : null));
  // A setting a search result opened that this scope cannot show: say so and offer the scopes that can.
  const landingNotice = computed(() => {
    const landing = settingsLanding();
    return landing && landing.path === props.path ? searchScopeNotice(landing.targetId, currentScope().kind, { scopeEnvironmentIds: currentScope().environmentIds, environments: scopeEnvironments() }) : null;
  });
  return (
    <SettingsPageContainer>
      {scoped ? <ScopeSentence single={props.path === "/settings/providers" || props.path === "/settings/secrets"} /> : null}
      {landingNotice() ? <SearchScopeNotice path={props.path} targetId={settingsLanding()?.targetId ?? ""} target={landingNotice()!.target} message={landingNotice()!.message} eligibleEnvironmentIds={landingNotice()!.eligibleEnvironmentIds} />
        : blocked() ? <Text class="text-sm text-muted-foreground">{blocked()}</Text> : <PanelBody path={props.path} panel={panel} />}
      <SettingsError message={settingsWriteError} />
    </SettingsPageContainer>
  );
}
