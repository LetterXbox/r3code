// The strip of referenced items above the field: files and folders (`@`), skills (`$`) and attached
// pull requests (`#`). An NSH Input holds plain text, so the web's inline chips (FileTagChip, the skill
// chip, the pull request chip) are drawn here instead, one per reference, each with a remove control.
import { Text, View } from "nsh";
import { ComposerIcon } from "./ComposerIcon";
import type { ComposerChip } from "./contextChips";

const ICON: Record<ComposerChip["kind"], string> = { file: "file", folder: "folder", skill: "sparkles", "pull-request": "git-pull-request" };

export function ComposerChips(props: { chips: () => ComposerChip[]; onRemove: (chip: ComposerChip) => void }) {
  return (
    <View class="flex-row flex-wrap items-center gap-1.5 pb-2" accessibilityLabel="Referenced items">
      <Each of={props.chips()} key={(chip) => chip.id}>
        {(chip) => (
          <View
            class="h-6 max-w-72 flex-row items-center gap-1 rounded-md border border-border bg-muted-10 ps-1.5 pe-0.5"
            tooltip={chip().detail}
            accessibilityLabel={`${chip().kind === "pull-request" ? "Pull request" : chip().kind === "skill" ? "Skill" : chip().kind === "folder" ? "Folder" : "File"} ${chip().label}`}
          >
            <ComposerIcon name={ICON[chip().kind]} size={12} />
            <Text class="min-w-0 truncate text-xs font-medium text-foreground">{chip().label}</Text>
            <View
              class="size-5 items-center justify-center rounded-sm hover:bg-accent transition-colors duration-150 ease-in-out"
              onPress={() => props.onRemove(chip())}
              accessibilityLabel={`Remove ${chip().label}`}
              role="button"
            >
              <ComposerIcon name="x" size={12} />
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}
