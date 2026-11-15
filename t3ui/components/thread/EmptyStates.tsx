// NoProjectsHero.tsx and NoActiveThreadState.tsx: the Empty block (centered, max-w-lg, gap-6) with a title,
// a description and, for the hero, the Add project and Start without a project buttons.
import { signal, Text, View } from "nsh";
import { Icon } from "../Icons";
import { openAddProjectPalette } from "../../store";
import { TimelineIcon } from "./markdown/TimelineIcon";
import { scratchProjectAvailable, startWithoutProject } from "./scratchProject";

const startError = signal<string | null>(null);

export function NoProjectsHero() {
  return (
    <View class="min-w-0 flex-1 items-center justify-center gap-6 p-12">
      <View class="w-full max-w-lg px-8 py-12">
        <View class="items-center">
          <Text class="text-center text-3xl font-semibold text-foreground">What should we work on?</Text>
          <Text class="mt-1 text-center text-sm text-muted-foreground">
            {scratchProjectAvailable() ? "Add a project, or start without one." : "Add a project to start your first thread."}
          </Text>
          <View class="mt-6 flex-row justify-center gap-2">
            <View
              class="h-7 flex-row items-center justify-center gap-1.5 rounded-lg bg-primary px-[9px] active:scale-[0.97] transition-transform duration-150 ease-in-out"
              onPress={openAddProjectPalette}
              accessibilityLabel="Add project"
              role="button"
            >
              <TimelineIcon name="plus" size={16} tint="#ffffff" />
              <Text class="text-sm font-medium text-primary-foreground">Add project</Text>
            </View>
            {scratchProjectAvailable() ? (
              <View
                class="h-7 flex-row items-center justify-center gap-1.5 rounded-lg border border-input bg-background px-[9px] hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
                onPress={() => {
                  startError.set(null);
                  void startWithoutProject().catch((error) => startError.set(error instanceof Error ? error.message : "Could not start without a project"));
                }}
                accessibilityLabel="Start without a project"
                role="button"
              >
                <Icon name="message-square-dashed" size={16} />
                <Text class="text-sm font-medium text-foreground">Start without a project</Text>
              </View>
            ) : null}
          </View>
          {startError() ? <Text class="mt-3 text-center text-xs text-error-foreground">{startError()}</Text> : null}
        </View>
      </View>
    </View>
  );
}

/** No thread selected: the reference shows only the title and description, with no action button. */
export function NoActiveThreadState() {
  return (
    <View class="min-w-0 flex-1 items-center justify-center gap-6 p-12">
      <View class="w-full max-w-lg px-8 py-12">
        <View class="items-center">
          <Text class="text-center text-xl font-semibold text-foreground">Pick a thread to continue</Text>
          <Text class="mt-1 text-center text-sm text-muted-foreground">Select an existing thread or create a new one to get started.</Text>
        </View>
      </View>
    </View>
  );
}
