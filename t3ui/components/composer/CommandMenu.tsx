// The slash / @ suggestion drawer (ComposerCommandMenu.tsx): rows of icon, label and a muted
// description, an empty/loading line, and Escape-to-dismiss handled by the composer.
import { colorScheme, Image, Overlay, Text, token, View } from "nsh";
import { FadeScroll } from "../FadeScroll";
import modelIcon from "./editor/icons/model.svg";
import threadIcon from "../../icons/messages-square.svg";
import type { ViewRef } from "nsh";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { FileEntryIcon } from "../files/FileEntryIcon";
import { PRIcon } from "../pullRequest/PRIcon";
import { resolveState, toneColor } from "../pullRequest/pullRequestPresentation";
import { ComposerIcon } from "./ComposerIcon";
import { Glyph } from "../sidebar/SidebarGlyph";
import { composerGlassSurface, composerOutline } from "./tokenColor";
import { EMPTY_STATE, LOADING_STATE } from "./commandItems";
import type { CommandItem } from "./commandItems";
import type { ComposerTriggerKind } from "./composerTrigger";

const LISTBOX_LABEL: Record<ComposerTriggerKind, string> = {
  path: "Files and folders", "pull-request": "Pull requests", "slash-command": "Commands", skill: "Skills",
};

const SKILL_SOURCE_LABEL: Record<string, string> = { repo: "Repo", repository: "Repo", project: "Project", workspace: "Project", local: "Project", user: "Personal", personal: "Personal", system: "System" };

/** The skill row's badge: where the skill comes from (Repo, Project, Personal, System, App or Provider). */
export function skillSourceLabel(skill: { path: string; scope: string | null }): string {
  const path = skill.path.replaceAll("\\", "/");
  if (path.includes("/.codex/plugins/") || path.includes("/.agents/plugins/")) return "App";
  return SKILL_SOURCE_LABEL[skill.scope?.trim().toLowerCase() ?? ""] ?? "Provider";
}

/** --chat-composer-drawer-inset (1.375rem): the drawer is the composer's width minus this on each side. */
const DRAWER_INSET = 22;

const SKILL_BADGE_ICON: Record<string, string> = { App: "blocks", Repo: "folder", Project: "folder", Personal: "user-round", System: "settings", Provider: "package" };

function RowIcon(props: { item: CommandItem }) {
  const item = props.item;
  if (item.type === "model") return <Image src={modelIcon} style={{ width: 16, height: 16, tintColor: token("muted-foreground") }} />;
  if (item.type === "thread") return <Image src={threadIcon} style={{ width: 16, height: 16, tintColor: token("muted-foreground") }} />;
  if (item.type === "environment") return <Glyph name={item.machine === "laptop" ? "laptop" : "server"} size={16} tint={token("muted-foreground")} />;
  if (item.type === "path") return <FileEntryIcon path={item.path} kind={item.pathKind} size={16} />;
  if (item.type === "pull-request") {
    const presentation = resolveState({ state: item.pullRequest.state, isDraft: item.pullRequest.isDraft });
    return <PRIcon name={presentation.icon} size={16} tint={toneColor(presentation.tone, colorScheme())} />;
  }
  return null;
}

/**
 * The slash / @ suggestion drawer (ComposerCommandMenu inside a ComposerBanner.Surface): a glass panel attached to
 * the composer's top edge, inset 22 each side, rounded top corners, list `p-2`, rows `min-h-7 rounded-lg px-2`.
 */
export function CommandMenu(props: {
  anchor: () => ViewRef | null;
  kind: ComposerTriggerKind;
  items: () => CommandItem[];
  active: () => number;
  loading: () => boolean;
  /** Overrides the kind's empty line (the pull-request states of useComposerMenuItems). */
  emptyText?: () => string | null;
  width: () => number;
  onHighlight: (index: number) => void;
  onSelect: (item: CommandItem) => void;
  onClose: () => void;
}) {
  // A native WebView draws above every popup, so it steps aside while the drawer is open.
  useOverlayOpen(true, "popup");
  const dark = () => colorScheme() === "dark";
  return (
    <Overlay anchor={props.anchor()} placement="top" align="start" offset={0} margin={8} onPressOutside={props.onClose} onCancel={props.onClose}>
      <View style={{ width: props.width(), paddingLeft: DRAWER_INSET, paddingRight: DRAWER_INSET }}>
        <View
          class="overflow-hidden rounded-t-2xl border border-b-0"
          style={{
            backgroundColor: composerGlassSurface(),
            borderColor: composerOutline(),
            boxShadow: dark() ? "0 14px 32px -18px rgba(0,0,0,0.75)" : "0 1px 2px rgba(0,0,0,0.05)",
          }}
          accessibilityLabel={LISTBOX_LABEL[props.kind]}
          role="listbox"
        >
          {props.items().length > 0 ? (
            <FadeScroll class="max-h-72" contentClass="p-2" fadeColor={composerGlassSurface}>
              <Each of={props.items()} key={(item) => item.id}>
                {(item) => (
                  <View
                    class={`min-h-7 flex-row items-center gap-2 rounded-lg px-2 py-1.5 ${props.items()[props.active()]?.id === item().id ? "bg-accent" : ""}`}
                    onPress={() => props.onSelect(item())}
                    onMouseEnter={() => props.onHighlight(props.items().findIndex((candidate) => candidate.id === item().id))}
                    accessibilityLabel={item().label}
                    role="option"
                  >
                    <RowIcon item={item()} />
                    <View class="min-w-0 flex-1 flex-row items-center gap-2">
                      {props.kind === "slash-command" && item().type === "skill" ? (
                        <View class="max-w-[45%] shrink-0 flex-row">
                          <Text class="text-xs font-medium text-secondary-label">/skill:</Text>
                          <Text class="truncate text-xs font-medium text-foreground">{(item() as Extract<CommandItem, { type: "skill" }>).skill.displayName ?? (item() as Extract<CommandItem, { type: "skill" }>).skill.name}</Text>
                        </View>
                      ) : (
                        <Text class="max-w-[45%] shrink-0 truncate text-xs font-medium text-foreground">{item().label}</Text>
                      )}
                      <Text class="min-w-0 flex-1 truncate text-xs text-secondary-label">{item().description}</Text>
                      {item().type === "skill" ? (
                        <View class="ms-auto h-[18px] min-w-[18px] shrink-0 flex-row items-center justify-center gap-1 rounded-sm bg-secondary px-[3px]">
                          <ComposerIcon name={SKILL_BADGE_ICON[skillSourceLabel((item() as Extract<CommandItem, { type: "skill" }>).skill)] ?? "package"} size={12} tint={String(token("secondary-foreground"))} />
                          <Text class="text-xs font-medium text-secondary-foreground">{skillSourceLabel((item() as Extract<CommandItem, { type: "skill" }>).skill)}{props.kind === "skill" ? " Skill" : ""}</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                )}
              </Each>
            </FadeScroll>
          ) : (
            <View class="px-5 pt-3.5 pb-7">
              <Text class="text-xs text-secondary-label">{props.loading() ? LOADING_STATE[props.kind] : (props.emptyText?.() ?? EMPTY_STATE[props.kind])}</Text>
            </View>
          )}
        </View>
      </View>
    </Overlay>
  );
}
