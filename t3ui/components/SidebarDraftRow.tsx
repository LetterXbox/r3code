import { colorScheme, signal, Text, token, View } from "nsh";
import { allProjects, discardDraft, draftSummary } from "../store";
import type { Thread } from "../store";
import { Icon } from "./Icons";
import { sidebarProjectIdentity } from "./SidebarUtils";
import { Presence, presenceStyle } from "./motion/Motion";
import { DURATION_DEFAULT_MS, revealIn, revealOut } from "./motion/motionTokens";

export function SidebarDraftRow(props: { thread: () => Thread; active: boolean; onSelect: () => void }) {
  const hovered = signal(false);
  const focused = signal(false);
  const discarding = signal(false);
  const discardFailed = signal(false);
  const discardHovered = signal(false);
  let blurTimer: number | undefined;
  const focusIn = () => { clearTimeout(blurTimer); focused.set(true); };
  const focusOut = () => { clearTimeout(blurTimer); blurTimer = setTimeout(() => focused.set(false), 200); };
  const project = () => allProjects().find((item) => item.id === props.thread().projectId);
  const identity = () => sidebarProjectIdentity(project()?.name ?? "", colorScheme(), token("sidebar"));
  const preview = () => {
    const summary = draftSummary(props.thread().id);
    const text = summary.text.trim().split("\n", 1)[0];
    if (text) return text;
    if (summary.attachmentCount) return `${summary.attachmentCount} attachment${summary.attachmentCount === 1 ? "" : "s"}`;
    return props.thread().title;
  };
  const discard = async () => {
    if (discarding()) return;
    discarding.set(true);
    discardFailed.set(false);
    try {
      await discardDraft(props.thread().id);
    } catch {
      discardFailed.set(true);
    } finally {
      discarding.set(false);
    }
  };

  return (
    <View class="py-0.5">
      <View
        role="button"
        accessibilityLabel={`Unsent draft: ${preview()}`}
        onPress={props.onSelect}
        onMouseEnter={() => hovered.set(true)}
        onMouseLeave={() => hovered.set(false)}
        onFocus={focusIn}
        onBlur={focusOut}
        class={`h-[78px] rounded-md px-2.5 py-2 ${
          props.active ? "bg-sidebar-row-active" : "bg-warning-4 hover:bg-warning-8"
        }`}
      >
        <View class="h-5 flex-row items-center gap-1.5">
          <Icon name="square-pen" size={12} tint={token("warning-foreground")} />
          {project() ? (
            <View class="size-4 items-center justify-center rounded-[4px]" style={{ backgroundColor: identity().colors[1] }}>
              <Text class="text-[8px] font-bold" style={{ color: identity().colors[0] }}>{identity().label}</Text>
            </View>
          ) : null}
          <Text class="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">{project()?.name ?? ""}</Text>
          <Presence when={() => hovered() || focused()} ms={DURATION_DEFAULT_MS}>{(closing) => (
            <View
              role="button"
              accessibilityLabel="Discard draft"
              disabled={discarding() || closing()}
              style={presenceStyle(revealIn, revealOut, () => !closing())}
              onPress={() => { void discard(); }}
              onFocus={focusIn}
              onBlur={focusOut}
              // SidebarDraftBlock: `rounded-md bg-transparent px-1 text-muted-foreground hover:text-foreground`, no surface.
              onMouseEnter={() => discardHovered.set(true)}
              onMouseLeave={() => discardHovered.set(false)}
              class="h-5 items-center justify-center rounded-md px-1"
            >
              <Icon name="x" size={12} tint={discardHovered() ? token("foreground") : token("muted-foreground")} />
            </View>
          )}</Presence>
        </View>
        <Text class="mt-0.5 truncate text-sm font-medium text-sidebar-foreground">{preview()}</Text>
      </View>
      {discardFailed() ? (
        <Text class="px-2.5 pt-1 text-xs text-error-foreground">Could not discard draft. Try again.</Text>
      ) : null}
    </View>
  );
}
