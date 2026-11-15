// ProjectIconPickerDialog.tsx and ProjectFaviconPickerDialog.tsx: "Choose icon" (an icon, an emoji or a monogram, with a
// colour) and "Choose file" (an image of the project folder, or any image through the system file dialog).
import { FadeScroll } from "../../components/FadeScroll";
import { Image, signal, Text, token, View } from "nsh";
import { DialogInput as Input } from "../../components/DialogInput";
import { SettingsDialog } from "../../components/SettingsDialog";
import { SettingsButton } from "../../components/SettingsLayout";
import { PROJECT_LUCIDE_ICON_SRC } from "../../components/sidebar/projectLucideIcons";
import { projectIconColor, type ProjectIcon, type ProjectIconColor } from "../../components/sidebar/projectIcon";
import { colorScheme } from "nsh";
import { showToast } from "../../components/toast";
import { canPickFolder } from "../../desktop/dialogs";
import { pickImageFile } from "../../desktop/dialogs";
import { requestServer } from "./settingsSync";
import {
  DEFAULT_ICON, PROJECT_EMOJIS, PROJECT_ICON_COLORS, faviconEmptyMessage, filterIconNames, firstEmoji, iconToSave, isValidMonogram, normalizeMonogram, parseImageEntries, relativeToWorkspace,
  type IconMode, type ImageEntry,
} from "./projectIconLogic";

const field = "h-7.5 rounded-lg border border-input bg-background px-3 text-sm text-foreground";

export function ProjectIconPicker(props: { current: ProjectIcon | null; projectName: string; onSelect: (icon: ProjectIcon) => void; onClose: () => void }) {
  const current = props.current;
  const mode = signal<IconMode>(current?.kind ?? "lucide");
  const iconName = signal(current?.kind === "lucide" ? current.name : DEFAULT_ICON);
  const color = signal<ProjectIconColor>(current && current.kind !== "emoji" ? current.color : "blue");
  const letters = signal(current?.kind === "monogram" ? current.text : props.projectName.slice(0, 2).toUpperCase());
  const emoji = signal(current?.kind === "emoji" ? current.emoji : "💻");
  const query = signal("");
  const customEmoji = signal("");
  const toSave = () => iconToSave({ mode: mode(), iconName: iconName(), color: color(), letters: letters(), emoji: emoji() });
  const tab = (value: IconMode, label: string) => (
    <View role="button" accessibilityLabel={label} onPress={() => mode.set(value)} class={`h-6 items-center justify-center rounded-md px-2.5 ${mode() === value ? "bg-accent" : ""}`}><Text class="text-xs font-medium text-foreground">{label}</Text></View>
  );
  const cell = "size-8 items-center justify-center rounded-md border border-transparent hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out";
  return (
    <SettingsDialog
      open
      onClose={props.onClose}
      title="Choose project icon"
      description="Choose an icon, emoji, or monogram."
      width={512}
      testID="Project icon picker"
      footer={<><SettingsButton label="Cancel" onPress={props.onClose} /><SettingsButton label="Save icon" tone="primary" disabled={toSave() === null} onPress={() => { const icon = toSave(); if (icon) { props.onSelect(icon); props.onClose(); } }} /></>}
    >
      <View class="flex-row gap-0.5 rounded-lg bg-input-32 p-0.5 self-start" accessibilityLabel="Icon type">{tab("lucide", "Icons")}{tab("emoji", "Emoji")}{tab("monogram", "Monogram")}</View>
      {mode() !== "emoji" ? (
        <View class="gap-2">
          <Text class="text-xs font-medium text-muted-foreground">Color</Text>
          <View class="flex-row flex-wrap gap-1.5" accessibilityLabel="Icon color">
            <Each of={PROJECT_ICON_COLORS} key={(option) => option.value}>
              {(option) => (
                <View role="button" accessibilityLabel={option().label} onPress={() => color.set(option().value)} class={`size-6 items-center justify-center rounded-full border ${color() === option().value ? "border-foreground" : "border-transparent"}`}>
                  <View class="size-4 rounded-full" style={{ backgroundColor: projectIconColor(option().value, colorScheme()) }} />
                </View>
              )}
            </Each>
          </View>
        </View>
      ) : null}
      {mode() === "lucide" ? (
        <>
          <Input value={query()} placeholder="Search all Lucide icons" accessibilityLabel="Search Lucide icons" onChange={(e: { value: string }) => query.set(e.value)} class={field} />
          <View class="flex-row flex-wrap gap-1">
            <Each of={filterIconNames(query())} key={(name) => name}>
              {(name) => (
                <View role="button" accessibilityLabel={name().split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")} onPress={() => iconName.set(name())} class={`${cell} ${iconName() === name() ? "border-border bg-accent" : ""}`}>
                  <Image src={PROJECT_LUCIDE_ICON_SRC[name()]!} style={{ width: 20, height: 20, tintColor: projectIconColor(color(), colorScheme()) }} />
                </View>
              )}
            </Each>
          </View>
          {filterIconNames(query()).length === 0 ? <Text class="py-6 text-center text-sm text-muted-foreground">No icons found.</Text> : null}
        </>
      ) : mode() === "monogram" ? (
        <View class="flex-row items-center gap-4 py-2">
          <View class="size-12 items-center justify-center rounded-xl" style={{ backgroundColor: projectIconColor(color(), colorScheme()) }}>
            <Text class="text-lg font-bold text-white">{isValidMonogram(normalizeMonogram(letters())) ? normalizeMonogram(letters()) : "?"}</Text>
          </View>
          <View class="min-w-0 flex-1 gap-2">
            <Text class="text-sm font-medium text-foreground">Letters</Text>
            <Input value={letters()} accessibilityLabel="Letters" onChange={(e: { value: string }) => letters.set(e.value)} class={field} />
            <Text class="text-xs text-muted-foreground">One or two letters or numbers.</Text>
          </View>
        </View>
      ) : (
        <>
          <View class="flex-row flex-wrap gap-1">
            <Each of={PROJECT_EMOJIS} key={(option) => option.emoji}>
              {(option) => (
                <View role="button" accessibilityLabel={option().label} onPress={() => emoji.set(option().emoji)} class={`${cell} ${emoji() === option().emoji ? "border-border bg-accent" : ""}`}><Text class="text-xl">{option().emoji}</Text></View>
              )}
            </Each>
          </View>
          <View class="gap-2">
            <Text class="text-xs font-medium text-muted-foreground">Or paste any emoji</Text>
            <Input value={customEmoji()} placeholder="Paste an emoji" accessibilityLabel="Custom emoji" onChange={(e: { value: string }) => { customEmoji.set(e.value); const next = firstEmoji(e.value); if (next) emoji.set(next); }} class={field} />
          </View>
        </>
      )}
    </SettingsDialog>
  );
}

export function ProjectFaviconPicker(props: { cwd: string; projectName: string; onSelect: (path: string) => void; onClose: () => void }) {
  const query = signal("");
  const entries = signal<ImageEntry[]>([]);
  const pending = signal(true);
  const error = signal<string | null>(null);
  let serial = 0;
  const search = async (text: string) => {
    const mine = ++serial;
    pending.set(true);
    try {
      const result = await requestServer("projects.searchEntries", { cwd: props.cwd, query: text, limit: 200, kind: "file", imageOnly: true });
      if (mine === serial) { entries.set(parseImageEntries(result)); error.set(null); }
    } catch (cause) {
      if (mine === serial) error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mine === serial) pending.set(false);
    }
  };
  void search("");
  const external = async () => {
    try {
      const chosen = await pickImageFile({ initialPath: props.cwd });
      if (!chosen) return;
      const relative = relativeToWorkspace(props.cwd, chosen);
      if (!relative) { showToast({ type: "warning", title: "Choose an image inside the project folder", description: "The project icon is a file of the project." }); return; }
      props.onClose();
      props.onSelect(relative);
    } catch (cause) {
      showToast({ type: "error", title: "Could not open image picker", description: cause instanceof Error ? cause.message : "An error occurred." });
    }
  };
  return (
    <SettingsDialog
      open
      onClose={props.onClose}
      title="Choose project icon"
      width={560}
      testID="Project favicon picker"
      footer={<>{canPickFolder() ? <SettingsButton label="Open in Finder" onPress={() => void external()} /> : null}<SettingsButton label="Close" onPress={props.onClose} /></>}
    >
      <Input value={query()} placeholder="Search image files…" accessibilityLabel="Search image files" onChange={(e: { value: string }) => { query.set(e.value); void search(e.value); }} class={field} />
      {/* ProjectIconPickerDialog.tsx: the results scroll in a fading ScrollArea. */}
      <FadeScroll class="max-h-72" contentClass="gap-0.5">
        <Text class="px-1 text-xs font-medium text-muted-foreground">{props.projectName}</Text>
        <Each of={entries()} key={(entry) => entry.path}>
          {(entry) => (
            <View role="button" accessibilityLabel={entry().path} onPress={() => { props.onClose(); props.onSelect(entry().path); }} class="min-h-9 flex-row items-center gap-3 rounded-md px-2 py-1 hover:bg-accent">
              <View class="min-w-0 flex-1"><Text class="truncate text-sm text-foreground">{entry().name}</Text><Text class="truncate text-xs text-muted-foreground">{entry().path}</Text></View>
            </View>
          )}
        </Each>
        {entries().length === 0 ? <Text class="px-2 py-6 text-center text-sm text-muted-foreground">{faviconEmptyMessage(query(), error(), pending())}</Text> : null}
      </FadeScroll>
    </SettingsDialog>
  );
}
