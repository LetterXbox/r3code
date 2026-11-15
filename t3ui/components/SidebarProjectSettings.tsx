import { effect, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { backendUrl } from "../store";
import type { Project } from "../store";
import { confirm } from "./toast";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

/** The selected project's settings; mutations are supplied by the environment store. */
export function SidebarProjectSettings(props: {
  project: () => Project;
  onBack: () => void;
  onRename?: (id: string, title: string) => Promise<void>;
  onRemove?: (id: string) => Promise<void>;
}) {
  const name = signal(props.project().name);
  const dirty = signal(false);
  const pending = signal(false);
  const error = signal("");
  let edited = false;

  // Keep an untouched field current without overwriting someone actively editing it.
  effect(() => {
    const currentName = props.project().name;
    if (!edited) name.set(currentName);
  });

  const commitName = async (): Promise<boolean> => {
    if (!edited) return true;
    if (pending() || !props.onRename) return false;
    const title = name().trim();
    if (!title) {
      error.set("Project name cannot be empty.");
      return false;
    }
    if (title === props.project().name) {
      edited = false;
      dirty.set(false);
      name.set(title);
      error.set("");
      return true;
    }
    const projectId = props.project().id;
    pending.set(true);
    error.set("");
    try {
      await props.onRename(projectId, title);
      edited = false;
      dirty.set(false);
      name.set(title);
      return true;
    } catch {
      error.set("Could not rename project. Try again.");
      return false;
    } finally {
      pending.set(false);
    }
  };
  const goBack = async () => {
    if (pending()) return;
    const id = props.project().id;
    const endpoint = backendUrl();
    if (await commitName() && endpoint === backendUrl() && id === props.project().id) props.onBack();
  };
  // The web's project removal asks through the shared confirmation dialog.
  const beginRemove = async () => {
    if (pending() || !props.onRemove) return;
    const id = props.project().id;
    const endpoint = backendUrl();
    if (!await commitName()) return;
    if (endpoint !== backendUrl() || id !== props.project().id) {
      error.set("The environment changed. Open project settings again.");
      return;
    }
    const projectName = name();
    const confirmed = await confirm(
      [
        `Remove ${projectName}?`,
        "This deletes the project entry, all its active and archived threads, and its unsent drafts. Files on disk are not touched. This cannot be undone.",
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    if (endpoint !== backendUrl() || id !== props.project().id) {
      error.set("The environment changed. Open project settings again.");
      return;
    }
    pending.set(true);
    error.set("");
    try {
      await props.onRemove(id);
      if (endpoint === backendUrl() && id === props.project().id) props.onBack();
    } catch {
      error.set("Could not remove project. Try again.");
    } finally {
      pending.set(false);
    }
  };

  return (
    <View class="gap-6">
      <View
        role="button"
        accessibilityLabel="Back to projects"
        onPress={() => { void goBack(); }}
        disabled={pending()}
        class="h-8 flex-row items-center self-start rounded-md px-2 hover:bg-accent"
      >
        <Text class="text-sm text-muted-foreground">Back to projects</Text>
      </View>
      <SettingsSection title="Project">
        <SettingsRow title="Name" description="The name shown in the sidebar and thread lists.">
          <View class="flex-row items-center gap-2">
            <Input
              accessibilityLabel="Project name"
              value={name()}
              disabled={pending() || !props.onRename}
              onChange={(event) => { edited = true; dirty.set(true); name.set(event.value); error.set(""); }}
              onSubmit={() => { void commitName(); }}
              onBlur={() => { void commitName(); }}
              onKeyPress={(event) => {
                if (event.key === "Escape") { edited = false; dirty.set(false); name.set(props.project().name); error.set(""); }
              }}
              class="h-8 w-64 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            />
            {dirty() ? (
              <View role="button" accessibilityLabel="Save project name" disabled={pending()} onPress={() => { void commitName(); }} class="h-8 items-center justify-center rounded-md border border-border px-3 hover:bg-accent">
                <Text class="text-xs text-foreground">Save</Text>
              </View>
            ) : null}
          </View>
        </SettingsRow>
        <View class="h-px bg-border-60" />
        <SettingsRow title="Folder" description={props.project().path ?? "Folder unavailable"} />
      </SettingsSection>
      <SettingsSection title="Danger">
        <SettingsRow title="Remove project" description="Deletes the project entry, its threads and unsent drafts. Files on disk are not touched.">
          <View
            role="button"
            accessibilityLabel="Remove project"
            disabled={pending() || !props.onRemove}
            onPress={() => { void beginRemove(); }}
            class="h-8 items-center justify-center rounded-md border border-border px-3 hover:bg-accent"
          >
            <Text class="text-xs font-medium text-error-foreground">Remove project</Text>
          </View>
        </SettingsRow>
      </SettingsSection>
      {!props.onRename || !props.onRemove ? <Text class="text-xs text-muted-foreground">Project editing is not available in this environment.</Text> : null}
      {error() ? <Text class="text-xs text-error-foreground">{error()}</Text> : null}
    </View>
  );
}
