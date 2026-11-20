// Settings, ported from routes/_chat.settings.tsx and
// components/settings/SettingsSidebarNav.tsx: a 240pt (w-60) nav of the web
// app's own sections, and the selected panel beside it.
//
// The section list is generated from the web app's source by
// tools/gen_settings_nav.py, so the labels are the shipped ones.
import { effect, keymap, Scroll, signal, Text, token, View, windowSize } from "nsh";
import { tokenAlpha } from "../components/composer/tokenColor";
import { dialogBackdropStyle } from "../components/dialogSurface";
import { SETTINGS_NAV } from "../settingsNav";
import { Icon } from "../components/Icons";
import { SettingsIcon } from "./settings/SettingsIcon";
import { SETTINGS_PANELS } from "../settingsPanels";
import { resetValue, resolveControl } from "./settings/controlSpecs";
import { confirm } from "../components/toast";
import { appearanceMode, chooseAppearanceMode } from "./settings/themeSelection";
import { themeEditorOpen } from "./settings/ThemeEditor";
import { isServerConnected, readSetting, writeSetting } from "./settings/settingsSync";
import { SettingsPanel, panelFor } from "./settings/Panel";
import { T3ConnectSidebarAvatar, T3ConnectSidebarSignIn } from "../cloud/ConnectSignIn";
import {
  clampActive, clearSearch, clearSettingsTarget, focusSettingsSearch, openSettingsHit, registerSettingsScroll,
  registerSettingsSearchInput, setActiveResultIndex, stepActive,
} from "./settings/settingsSearchNav";
import { Input } from "nsh/base";
import { createPresence, presenceStyle } from "../components/motion/Motion";
import { backdropEnter, backdropExit, DIALOG_MS, routeModalEnter, routeModalExit } from "../components/motion/motionTokens";
import { useOverlayOpen } from "../components/rightPanel/nativeOcclusion";
import { EscapeCancel, editorHoldsKeyboard } from "../components/EscapeCancel";
import {
  closeSettings,
  isSecretsFeatureEnabled,
  openSettings,
  setSettingsSearchQuery,
  settingsOpen,
  settingsSearchHits,
  settingsSearchQuery,
  settingsSection,
  settingsSectionLabel,
} from "../store";

/** Lucide name per SETTINGS_SECTION_ICONS path. */
const NAV_ICON: Record<string, string> = {
  "/settings/general": "settings-2",
  "/settings/appearance": "palette",
  "/settings/chat": "message-square-text",
  "/settings/diffs": "file-diff",
  "/settings/keybindings": "keyboard",
  "/settings/voice": "mic",
  "/settings/snap-shot": "snap-shot",
  "/settings/providers": "bot",
  "/settings/threads": "messages-square",
  "/settings/browser": "globe",
  "/settings/devices": "smartphone",
  "/settings/scheduled-tasks": "calendar-clock",
  "/settings/projects": "panels-top-left",
  "/settings/source-control": "git-branch",
  "/settings/worktrees": "folder-tree",
  "/settings/connections": "server",
  "/settings/access": "shield-check",
  "/settings/secrets": "key-round",
  "/settings/maintenance": "wrench",
  "/settings/labs": "flask-conical",
  "/settings/about": "info",
  "/settings/archived": "archive",
};

/**
 * A nav mark, `[&>svg]:text-[var(--sidebar-icon-color)]`: the muted sidebar colour mixed 85% into
 * the sidebar, which is the muted colour at 0.85 over it; the selected row uses the plain sidebar foreground.
 */
function NavIcon(props: { name: string; active?: boolean }) {
  return <Icon name={props.name} size={16} tint={props.active ? token("sidebar-foreground") : tokenAlpha("sidebar-muted-foreground", 0.85)} />;
}

function visibleNav() {
  return SETTINGS_NAV.map((group) => ({
    ...group,
    sections: group.sections.filter(
      (section) => section.path !== "/settings/secrets" || isSecretsFeatureEnabled(),
    ),
  })).filter((group) => group.sections.length > 0);
}

/**
 * The settings "Restore device defaults" resets: the keys of useSettingsRestore's update call
 * (SettingsPanels.tsx), client and server alike, plus the theme.
 */
const RESTORE_FIELDS = new Set([
  "appearanceContrast", "diffColorScheme", "chatWidth", "effortDisplay", "mathRenderingEnabled", "timestampFormat",
  "notificationMode", "inAppNotificationsEnabled", "wordWrap", "persistComposerContextStrip", "diffFilesCollapsed",
  "diffIgnoreWhitespace", "diffLayout", "proactivePanelsEnabled", "showSkillsInSlashMenu", "composerRichTextEnabled",
  "sendShortcut", "followUpBehavior", "toolCallVisibility", "environmentIdentificationMode", "glassOpacity",
  "panelAnimationDurationMs", "sidebarProjectGroupingMode", "sidebarProjectSortOrder", "sidebarWorkingShelfEnabled",
  "sidebarAutoSettleAfterDays", "sidebarAutoSettleKeepPullRequests", "sidebarAutoSettleOnMerge", "autoResumeLimitedThreads",
  "snoozeLimitedThreads", "responseStreamingMode", "enableProviderUpdateChecks", "continueThreadsAfterServerUpdate",
  "keepAwakeWhileAgentsWork",
  "backgroundActivityProfile", "defaultThreadEnvMode", "newWorktreesStartFromOrigin", "addProjectBaseDirectory",
  "ghqCloneLayout", "confirmThreadArchive", "confirmThreadDelete", "confirmThreadUnpin", "confirmQuit",
  "threadTitleInstructions", "browserDefaultZoomFactor", "browserDefaultAppearance", "browserRecordingFrameRate",
  "browserRecordingShowKeyPresses", "browserRecordingShowMousePresses", "browserLinkTarget", "browserSearchEngine",
  "browserCustomSearchUrl", "browserAutoShowFloatingPreview", "pullRequestLinksOpenInApp", "enableAgentBrowserAccess",
]);

/** Rows whose value differs from the web's shipped default and that Restore device defaults resets. */
function changedDeviceRows() {
  return SETTINGS_PANELS.flatMap((panel) => panel.sections.flatMap((section) => section.rows)).flatMap((row) => {
    const spec = resolveControl(row);
    if (!spec || spec.fallback === null || !RESTORE_FIELDS.has(spec.field)) return [];
    // A server setting can only be read, or reset, while its server is connected.
    if (spec.scope === "server" && !isServerConnected()) return [];
    const differs = String(spec.read(readSetting(spec.field, spec.scope))) !== String(spec.read(spec.fallback));
    return differs ? [{ spec, title: row.title }] : [];
  });
}

/**
 * The web's responsive nav (SettingsSidebarNav.tsx): `w-60`, and below `md` (768) a `w-14` icon rail with a
 * search button; opening the search widens the rail over the page (`max-md:absolute max-md:w-full`).
 * AppRouteModal insets the popup `sm:p-6 lg:p-10` and fills the window below `sm` (640).
 */
const MD = 768;
const SM = 640;
const LG = 1024;
const compactSearchOpen = signal(false);
const isCompact = () => windowSize().width < MD;
const searchExpanded = () => !isCompact() || compactSearchOpen() || settingsSearchQuery().trim().length > 0;
const backdropPadding = () => (windowSize().width < SM ? "" : windowSize().width < LG ? "p-6" : "p-10");
function openCompactSearch() {
  compactSearchOpen.set(true);
  setTimeout(focusSettingsSearch, 0);
}

const restoreLabels = () => [...(appearanceMode() !== "system" ? ["Theme"] : []), ...changedDeviceRows().map((row) => row.title)];

/** useSettingsRestore: ask through the shared confirmation, then reset the theme and every changed device row. */
async function restoreDefaults() {
  const labels = restoreLabels();
  if (labels.length === 0) return;
  if (!(await confirm(["Restore default settings?", `This will reset: ${labels.join(", ")}.`].join("\n"), { variant: "destructive" }))) return;
  if (appearanceMode() !== "system") chooseAppearanceMode("system");
  for (const { spec } of changedDeviceRows()) void writeSetting(spec.field, spec.scope, resetValue(spec, readSetting(spec.field, spec.scope)));
}

/** RestoreDeviceDefaultsButton: the General header's "Restore device defaults". */
function RestoreDeviceDefaults() {
  return (
    <>
      <View
        class={
          restoreLabels().length === 0
            // Button size="xs" variant="ghost" at sm+: h-6, gap-1, 7pt padding plus a 1pt border,
            // a 14pt icon. RotateCcwIcon's own `className="mx-1 size-3.5"` (routes/_chat.settings.tsx:39)
            // overrides the button's base `[&_svg]:-mx-0.5` rule, so the icon sits at mx-1, not -mx-0.5.
            ? "h-6 flex-row items-center gap-1 rounded-lg border border-transparent px-[7px] opacity-64"
            : "h-6 flex-row items-center gap-1 rounded-lg border border-transparent px-[7px] hover:bg-accent"
        }
        accessibilityLabel="Restore device defaults"
        disabled={restoreLabels().length === 0}
        onPress={() => void restoreDefaults()}
      >
        <View class="mx-1">
          <SettingsIcon name="rotate-ccw" size={14} />
        </View>
        <Text class="text-xs font-medium text-foreground">Restore device defaults</Text>
      </View>
    </>
  );
}

export function Settings() {
  // The web's search keys: "/" and mod+f focus the field; with a query, the arrows move
  // the highlight, Enter opens the highlighted setting and Escape clears the query.
  effect(() => {
    if (!settingsOpen()) return;
    return keymap.bind({ "/": focusSettingsSearch, "mod+f": focusSettingsSearch });
  });
  // AppRouteModal: Escape closes the page. A search in progress takes it first
  // (the query clears, below), and an overlay inside the page (a select's list,
  // a dialog) closes itself before the key reaches this binding.
  effect(() => {
    if (!settingsOpen() || themeEditorOpen() || settingsSearchQuery().trim().length > 0) return;
    // "always": the composer's editor under the page can still hold the keyboard, and a text input that "uses" Escape would
    // otherwise keep the default-mode binding from firing (the palette binds the same way).
    return keymap.bind({ escape: () => (compactSearchOpen() ? compactSearchOpen.set(false) : closeSettings()) }, { when: "always" });
  });
  effect(() => {
    if (!settingsOpen() || themeEditorOpen() || settingsSearchQuery().trim().length === 0) return;
    return keymap.bind({
      down: () => stepActive(1, settingsSearchHits().length),
      up: () => stepActive(-1, settingsSearchHits().length),
      enter: () => { const hit = settingsSearchHits()[clampActive(settingsSearchHits().length)]; if (hit) openSettingsHit(hit); },
      escape: clearSearch,
    }, { when: "always" });
  });
  // AppRouteModal.tsx:72 (popup opacity + scale .985, 150ms ease-out) over DialogBackdrop (dialog-styles.ts:2, opacity 200ms).
  // On close the frame stays drawn (inert) for the exit: data-ending-style, the popup's 150ms and the backdrop's 200ms.
  const shown = createPresence(settingsOpen, () => DIALOG_MS);
  // appOverlayOpen() follows settingsOpen(); while the frame plays its exit it registers itself, so no WebView comes back over it.
  useOverlayOpen(shown.closing, "settings closing");
  const popupMotion = presenceStyle(routeModalEnter, routeModalExit, settingsOpen);
  const backdropMotion = presenceStyle(backdropEnter, backdropExit, settingsOpen);
  return (
    <View
      class={
        shown.present()
          // The web's `dialog-backdrop`: --background at 64% plus a 4pt blur (dialogSurface.ts).
          // AppRouteModal centres the popup: `lg:p-10`, max-w-[80rem], max-h-[60rem].
          ? `absolute inset-0 items-center justify-center ${backdropPadding()}`
          : "hidden"
      }
      style={[shown.present() ? dialogBackdropStyle() : undefined, shown.closing() ? { pointerEvents: "none" } : null, backdropMotion]}
    >
      {/* A prompt editor under the page holding the keyboard outranks every keymap Escape above: take it as an overlay. */}
      {settingsOpen() && editorHoldsKeyboard() ? (
        <EscapeCancel onCancel={() => { if (settingsSearchQuery().trim().length > 0) clearSearch(); else if (compactSearchOpen()) compactSearchOpen.set(false); else closeSettings(); }} />
      ) : null}
      <View
        style={popupMotion}
        class={
          windowSize().width < SM
            ? "size-full flex-row overflow-hidden bg-background"
            : "size-full max-h-[960px] max-w-[1280px] flex-row overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        }
      >
        <View
          class={
            !isCompact() ? "w-60 border-r border-border bg-sidebar"
              : compactSearchOpen() || settingsSearchQuery().trim().length > 0 ? "absolute inset-y-0 left-0 z-10 w-full border-r border-border bg-sidebar"
              : "w-14 border-r border-border bg-sidebar"
          }
          role="navigation"
          accessibilityLabel="Settings navigation"
        >
          <Scroll class="flex-1" contentClass="gap-2 p-2">
            {!searchExpanded() ? (
              <View class="h-8 flex-row items-center justify-center rounded-lg hover:bg-sidebar-row-hover" accessibilityLabel="Search settings" onPress={openCompactSearch}>
                <Icon name="search" size={16} tint={tokenAlpha("sidebar-muted-foreground", 0.85)} />
              </View>
            ) : (
            <View class="h-8 flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-row-hover">
              {/* `text-sidebar-muted-foreground/80` */}
              <Icon name="search" size={16} tint={tokenAlpha("sidebar-muted-foreground", 0.8)} />
              <Input
                value={settingsSearchQuery()}
                placeholder="Search"
                accessibilityLabel="Search settings"
                ref={registerSettingsSearchInput}
                onChange={(event) => { setSettingsSearchQuery(event.value); setActiveResultIndex(0); }}
                class="min-w-0 flex-1 bg-transparent text-sm font-medium text-sidebar-foreground"
              />
              {settingsSearchQuery().trim().length > 0 ? (
                <View class="size-5 items-center justify-center rounded-sm hover:bg-accent" accessibilityLabel="Clear settings search" onPress={clearSearch}>
                  <SettingsIcon name="x" size={12} />
                </View>
              ) : (
                // ui/kbd.tsx: `h-5 min-w-5 rounded px-1 text-xs font-medium text-muted-foreground bg-foreground/[0.07]`.
                <View class="h-5 min-w-5 items-center justify-center rounded px-1" style={{ backgroundColor: tokenAlpha("foreground", 0.07) }}>
                  <Text class="text-xs font-medium text-muted-foreground">/</Text>
                </View>
              )}
            </View>
            )}
            {settingsSearchQuery().trim().length > 0 ? (
              <View class="gap-1" role={settingsSearchHits().length > 0 ? "listbox" : undefined} accessibilityLabel={settingsSearchHits().length > 0 ? "Settings search results" : undefined}>
                {settingsSearchHits().length === 0 ? (
                  <Text class="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
                    No settings found
                  </Text>
                ) : null}
                <Each of={settingsSearchHits()} key={(hit) => hit.id + hit.path}>
                  {(hit, index) => (
                    <View
                      role="option"
                      accessibilityState={{ selected: clampActive(settingsSearchHits().length) === index() }}
                      testID={`Settings result ${hit().id} (${clampActive(settingsSearchHits().length) === index() ? "active" : "idle"})`}
                      class={
                        clampActive(settingsSearchHits().length) === index()
                          ? "min-h-10 flex-row items-start gap-2 rounded-lg bg-sidebar-row-selected px-2.5 py-2"
                          : "min-h-10 flex-row items-start gap-2 rounded-lg px-2.5 py-2 hover:bg-sidebar-row-hover"
                      }
                      onMouseEnter={() => setActiveResultIndex(index())}
                      onPress={() => openSettingsHit(hit())}
                    >
                      <NavIcon name={NAV_ICON[hit().path] ?? "settings"} active={clampActive(settingsSearchHits().length) === index()} />
                      <View class="min-w-0 flex-1">
                        <Text class="text-sm font-medium text-sidebar-foreground">{hit().title}</Text>
                        <Text class="text-2xs" style={{ color: tokenAlpha("sidebar-muted-foreground", 0.75) }}>{hit().section}</Text>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            ) : null}
            {settingsSearchQuery().trim().length === 0 ? (
            <View role="tree" accessibilityLabel="Settings sections" class="gap-4">
            <Each of={visibleNav()} key={(g) => g.heading ?? "root"}>
              {(group, groupIndex) => (
                <View
                  role="group"
                  accessibilityLabel={group().heading ?? undefined}
                  class={!searchExpanded() && groupIndex() > 0 ? "gap-1 border-t border-sidebar-border pt-4" : "gap-1"}
                >
                  {group().heading && searchExpanded() ? (
                    <Text class="px-2 text-xs font-medium" style={{ color: tokenAlpha("sidebar-muted-foreground", 0.8) }}>
                      {group().heading}
                    </Text>
                  ) : null}
                  <Each
                    of={group().sections}
                    key={(sec) => sec.path}
                  >
                    {(section) => (
                      <View
                        role="treeitem"
                        accessibilityState={{
                          selected: settingsSection() === section().path,
                          current: settingsSection() === section().path ? "page" : false,
                        }}
                        class={
                          settingsSection() === section().path
                            ? `h-8 flex-row items-center gap-2 rounded-lg bg-sidebar-row-selected px-2.5 py-1.5 ${searchExpanded() ? "" : "justify-center"}`
                            : `h-8 flex-row items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-sidebar-row-hover active:bg-sidebar-row-active ${searchExpanded() ? "" : "justify-center"}`
                        }
                        accessibilityLabel={searchExpanded() ? undefined : section().label}
                        onPress={() => { clearSettingsTarget(); openSettings(section().path); compactSearchOpen.set(false); }}
                      >
                        <NavIcon name={NAV_ICON[section().path] ?? "settings"} active={settingsSection() === section().path} />
                        {searchExpanded() ? (
                          <Text
                            class={settingsSection() === section().path ? "text-sm font-medium text-sidebar-foreground" : "text-sm font-medium"}
                            style={settingsSection() === section().path ? undefined : { color: tokenAlpha("sidebar-muted-foreground", 0.8) }}
                          >
                            {section().label}
                          </Text>
                        ) : null}
                      </View>
                    )}
                  </Each>
                </View>
              )}
            </Each>
            </View>
            ) : null}
          </Scroll>
          {/* SidebarFooter (SettingsSidebarNav.tsx:437): T3ConnectSidebarSignIn, then T3ConnectSidebarAvatar. */}
          <View class="gap-2 p-2">
            <T3ConnectSidebarSignIn />
            <T3ConnectSidebarAvatar />
          </View>
        </View>

        <View class="min-w-0 flex-1">
          <View class="h-12 shrink-0 flex-row items-center gap-3 border-b border-border pl-5 pr-2" role="navigation" accessibilityLabel="Settings breadcrumb">
            {settingsSectionLabel() !== "Settings" ? (
              <>
                <Text class="text-sm font-medium text-muted-foreground">Settings</Text>
                <Text class="text-sm text-icon-muted">/</Text>
              </>
            ) : null}
            <Text class="min-w-0 flex-1 text-sm font-medium text-foreground">{settingsSectionLabel()}</Text>
            {/* ms-auto flex shrink-0 items-center gap-1 */}
            <View class="shrink-0 flex-row items-center gap-1">
              {settingsSection() === "/settings/general" ? <RestoreDeviceDefaults /> : null}
              <View class="size-7 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" accessibilityLabel="Close settings" tooltip="Close (Esc)" onPress={closeSettings}>
                <SettingsIcon name="x" size={16} />
              </View>
            </View>
          </View>
          <Scroll class="flex-1" ref={registerSettingsScroll}>
            {/* Generated panels render from the web app's own data; the
                sections with no rows yet still read as a stub. */}
            {panelFor(settingsSection()) ? (
              <SettingsPanel path={settingsSection()} />
            ) : (
              <Text class="text-sm text-muted-foreground">
                {settingsSectionLabel() + " settings."}
              </Text>
            )}
          </Scroll>
        </View>
      </View>
    </View>
  );
}
