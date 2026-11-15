// SettingsScopeNotice: a setting a search result opened that the selected scope cannot show gets this
// message and a list of scopes that can (routes/_chat.settings.tsx SettingsScopeBoundary). Choosing one
// selects it and reveals the setting.
import { Text, token, View } from "nsh";
import { Icon } from "../../components/Icons";
import { ProjectTile } from "../../components/sidebar/ProjectTile";
import { SettingsIcon } from "./SettingsIcon";
import { scopeEnvironments, scopeProjects, selectScope } from "./scopeState";
import { revealSettingsTarget, resolveSettingsTarget } from "./settingsSearchNav";
import { isSettingsSearchScopeAvailable, settingsSearchTargetScope } from "./settingsSearch";
import type { ScopeSearch } from "./scopeCore";

type NoticeTarget = "environment" | "all" | "project" | "checkout";

/** The notice text for a landing target the scope kind cannot show, or null when it can. */
export function searchScopeNotice(
  targetId: string,
  scopeKind: string,
  autoSettlement?: { scopeEnvironmentIds: readonly string[]; environments: readonly { environmentId: string; connected: boolean }[] },
): { target: NoticeTarget; message: string; eligibleEnvironmentIds?: string[] } | null {
  const found = settingsSearchTargetScope(targetId);
  if (!found || scopeKind === "unavailable") return null;
  // getThreadAutoSettlementSearchAvailability: the selected scope needs a connected environment.
  if (found.requiresThreadAutoSettlement && autoSettlement) {
    const eligibleEnvironmentIds = autoSettlement.environments.filter((environment) => environment.connected).map((environment) => environment.environmentId);
    const available = autoSettlement.scopeEnvironmentIds.some((id) => eligibleEnvironmentIds.includes(id));
    if (!available) {
      return {
        target: "environment",
        eligibleEnvironmentIds,
        message: eligibleEnvironmentIds.length > 0
          ? `${found.title} requires a supporting environment. Choose one to continue.`
          : `${found.title} requires a supporting environment. Connect or update an environment to continue.`,
      };
    }
  }
  if (isSettingsSearchScopeAvailable(found.scope, scopeKind)) return null;
  // The port has no checkout scope: a checkout-only target is chosen through its project.
  const target: NoticeTarget = found.scope === "environment" || found.scope === "project" ? found.scope : found.scope === "checkout" ? "project" : "all";
  return { target, message: `${found.title} is not available for the selected target. Choose its owning scope to continue.` };
}

interface Choice { label: string; secondary?: string; icon: any; search: ScopeSearch }

function choicesFor(target: NoticeTarget, eligibleEnvironmentIds?: readonly string[]): Choice[] {
  if (target === "project") {
    return scopeProjects().map((project) => ({
      label: project.name,
      ...(project.path ? { secondary: project.path } : {}),
      icon: <ProjectTile name={project.name} size={16} projectId={project.id} />,
      search: { project: project.id },
    }));
  }
  if (target === "environment") {
    return scopeEnvironments().filter((environment) => !eligibleEnvironmentIds || eligibleEnvironmentIds.includes(environment.environmentId)).map((environment) => ({
      label: environment.label,
      icon: <Icon name="server" size={16} tint={token("muted-foreground")} />,
      search: { machine: environment.environmentId },
    }));
  }
  return [{ label: "Open all environments", icon: <SettingsIcon name="layers" size={16} tint={token("muted-foreground")} />, search: {} }];
}

export function SearchScopeNotice(props: { path: string; targetId: string; target: NoticeTarget; message: string; eligibleEnvironmentIds?: readonly string[] }) {
  const choose = (search: ScopeSearch) => {
    selectScope(search);
    void revealSettingsTarget(props.path, resolveSettingsTarget(props.path, props.targetId));
  };
  return (
    <View class="gap-3" testID="Settings scope notice">
      <Text class="px-4 text-sm text-muted-foreground" accessibilityLabel="Settings scope notice message">{props.message}</Text>
      <View class="rounded-xl border border-border-60 bg-card-40">
        <Each of={choicesFor(props.target, props.eligibleEnvironmentIds).map((choice, index) => ({ ...choice, index }))} key={(choice) => `${choice.label}${choice.index}`}>{(entry) => { const choice = entry(); const index = choice.index; return (
          <View>
            {index > 0 ? <View class="h-px bg-border-50" /> : null}
            <View
              role="button"
              accessibilityLabel={choice.label}
              class="min-h-12 flex-row items-center gap-3 px-4 py-3 hover:bg-accent-50"
              onPress={() => choose(choice.search)}
            >
              {choice.icon}
              <View class="min-w-0 flex-1">
                <Text class="text-sm font-medium text-foreground">{choice.label}</Text>
                {choice.secondary ? <Text class="text-xs text-muted-foreground">{choice.secondary}</Text> : null}
              </View>
              <Icon name="chevron-right" size={16} tint={token("muted-foreground")} />
            </View>
          </View>
        ); }}</Each>
      </View>
    </View>
  );
}
