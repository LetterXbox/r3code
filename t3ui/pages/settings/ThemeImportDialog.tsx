// The "Add a theme" dialog, ported from ThemeImportDialog.tsx and ThemeSearchSection.tsx: search community themes on Open VSX
// and install one, or import a theme file (T3 Code or VS Code .json, one or several) or pasted JSON. Each opening is a
// fresh session: closing it aborts every read, search and install it started.
//
// Not ported: the JSON box's syntax highlighting (a transparent textarea over a coloured <pre>, which needs layered text
// editing this renderer has no equivalent of); the box is a plain multi-line field.
import { cleanup, Image, openUrl, signal, Text, View } from "nsh";
import { readFile, stat } from "fs/promises";
import { DialogInput } from "../../components/DialogInput";
import { SettingsDialog } from "../../components/SettingsDialog";
import { SettingsButton, SettingsSelect } from "../../components/SettingsLayout";
import { Spinner } from "../../components/sidebar/Spinner";
import { showToast } from "../../components/toast/toastState";
import { useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { tokenAlpha } from "../../components/composer/tokenColor";
import { pickFiles } from "../../desktop/dialogs";
import {
  asDefinition, customThemeCollection, customThemes, installCustomTheme, replaceCustomThemeCollection, updateCustomTheme, type CustomTheme,
} from "./customThemes";
import { importOpenVsxThemeExtension, type OpenVsxThemeExtension, type OpenVsxThemeSort } from "./openVsxThemes";
import { SettingsIcon } from "./SettingsIcon";
import { applyHalves } from "./themeSelection";
import { createThemeSearch } from "./themeSearch";
import { parseThemeFile, THEME_FILE_VERSION } from "./themeFile";
import { getThemeModes, type ThemeDefinition } from "./themePalette";
import { humanizeThemeName, pairVsCodeThemes, parseThemeImport, resolveThemeLabelCollisions } from "./vscodeThemeImport";

/** The guard runs on the size before the text is used: a large file would be pulled into memory and a field. */
const MAX_THEME_FILE_BYTES = 256 * 1024;

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export function describeOversizedThemeFile(bytes: number): string | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null;
  return `That file is ${formatByteSize(bytes)}. Theme files are only a few KB, so this one was not read (limit ${formatByteSize(MAX_THEME_FILE_BYTES)}).`;
}

const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];
const SORT_OPTIONS: { value: OpenVsxThemeSort; label: string }[] = [
  { value: "downloadCount", label: "Most downloaded" },
  { value: "rating", label: "Best rated" },
  { value: "timestamp", label: "Newest" },
  { value: "relevance", label: "Most relevant" },
];

/** Intl.NumberFormat compact notation, one fraction digit: 123456 is "123K", 1500000 "1.5M". */
export function formatDownloads(count: number): string {
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, suffix] of units) {
    if (count >= size) {
      const value = Math.round((count / size) * 10) / 10;
      return `${value}${suffix}`;
    }
  }
  return String(count);
}

/** What a theme added on its own does to the theme in use (ThemeSettings' onImported / onImportedMany). */
export function announceImported(theme: CustomTheme) {
  const modes = getThemeModes(asDefinition(theme));
  applyHalves(theme.id, modes);
  showToast({ type: "success", title: `${theme.label} added`, description: modes.length === 1 ? `It’s now your ${modes[0]!} theme.` : "It’s now active." });
}

export function announceImportedMany(themes: CustomTheme[], context: { updated: boolean }) {
  const verb = context.updated ? "updated" : "added";
  showToast({
    type: "success",
    title: themes.length === 1 ? `${themes[0]!.label} ${verb}` : `${themes.length} themes ${verb}`,
    description: themes.map((theme) => theme.label).join(", "),
  });
}

function ErrorBox(props: { message: () => string | null }) {
  return <>{props.message() ? <View class="rounded-lg border border-error bg-error-surface px-3 py-2" role="alert" accessibilityLabel="Theme import error"><Text class="text-sm text-error-foreground">{props.message()}</Text></View> : null}</>;
}

function ExtensionIcon(props: { extension: OpenVsxThemeExtension }) {
  const failed = signal(false);
  return (
    <View class="size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
      {props.extension.iconUrl && !failed() ? (
        <Image src={props.extension.iconUrl} style={{ width: 40, height: 40, objectFit: "cover" }} onError={() => failed.set(true)} />
      ) : (
        <SettingsIcon name="palette" size={16} />
      )}
    </View>
  );
}

function ThemeSearchSection(props: { signal: AbortSignal; onInstalled: (themes: CustomTheme[], context: { updated: boolean }) => void; debounceMs?: number }) {
  const query = signal("");
  const sortBy = signal<OpenVsxThemeSort>("downloadCount");
  const results = signal<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const error = signal<string | null>(null);
  const isSearching = signal(false);
  const installingId = signal<string | null>(null);
  const pendingUpdate = signal<OpenVsxThemeExtension | null>(null);
  const themeSearch = createThemeSearch({ setResults: (next) => results.set(next), setError: (next) => error.set(next), setIsSearching: (next) => isSearching.set(next) }, props.signal, undefined, props.debounceMs);

  const changeQuery = (next: string) => {
    query.set(next);
    themeSearch.setQuery(next);
  };
  const handleInstall = async (extension: OpenVsxThemeExtension, allowUpdate: boolean) => {
    error.set(null);
    const installedCollection = customThemeCollection(extension.collectionId);
    const updated = installedCollection.length > 0;
    if (updated && !allowUpdate) {
      pendingUpdate.set(extension);
      return;
    }
    const installSignal = themeSearch.beginInstall();
    installingId.set(extension.id);
    try {
      const themes = await importOpenVsxThemeExtension(extension, installSignal);
      if (!installSignal.aborted) {
        const imported = replaceCustomThemeCollection(extension.collectionId, themes, { expectedCollection: installedCollection });
        props.onInstalled(imported, { updated });
      }
    } catch (cause) {
      if (!installSignal.aborted) error.set(cause instanceof Error ? cause.message : "That theme could not be added.");
    }
    if (themeSearch.endInstall(installSignal)) installingId.set(null);
  };
  const installedNow = (extension: OpenVsxThemeExtension) => customThemes().some((theme) => theme.collection?.id === extension.collectionId);

  return (
    <View class="gap-3" role="group" accessibilityLabel="Search community themes">
      <View class="gap-0.5">
        <Text class="text-sm font-medium text-foreground">Search community themes</Text>
        <Text class="text-xs text-muted-foreground">Find open-source themes from Open VSX.</Text>
      </View>
      <View class="h-10 flex-row items-center gap-2 rounded-lg border border-input bg-background px-3">
        {isSearching() ? <Spinner size={14} /> : <SettingsIcon name="search" size={14} />}
        <DialogInput
          value={query()}
          accessibilityLabel="Search Open VSX themes"
          placeholder="Search themes..."
          autoCapitalize="none"
          autoCorrect={false}
          onChange={(event) => changeQuery(event.value)}
          onSubmit={() => { if (!isSearching() && installingId() === null) themeSearch.searchNow(); }}
          class="h-9 flex-1 text-sm text-foreground"
        />
      </View>

      {!isSearching() || results() !== null ? (
        <View class="flex-row flex-wrap items-center justify-between gap-2">
          <View class="min-w-0 flex-row flex-wrap items-center gap-1.5">
            <Text class="text-xs text-muted-foreground">Popular</Text>
            <Each of={SUGGESTED_SEARCHES} key={(suggestion) => suggestion}>
              {(suggestion) => (
                <View
                  accessibilityLabel={suggestion()}
                  disabled={installingId() !== null}
                  onPress={() => { if (query().trim() === suggestion()) themeSearch.searchNow(); else changeQuery(suggestion()); }}
                  class="h-6 items-center justify-center rounded-md px-2 hover:bg-accent"
                >
                  <Text class="text-xs font-medium text-foreground">{suggestion()}</Text>
                </View>
              )}
            </Each>
          </View>
          {results() && results()!.length > 0 ? (
            <View class="flex-row items-center gap-2">
              <Text class="text-xs text-muted-foreground">Sort</Text>
              <SettingsSelect inline
                label="Sort themes"
                value={sortBy()}
                options={SORT_OPTIONS}
                compactWidth={160}
                onChange={(next) => {
                  const option = SORT_OPTIONS.find((item) => item.value === next);
                  if (!option || installingId() !== null) return;
                  sortBy.set(option.value);
                  themeSearch.setSortBy(option.value);
                }}
              />
            </View>
          ) : null}
        </View>
      ) : null}

      <ErrorBox message={error} />

      {isSearching() && results() === null ? (
        <View class="min-h-20 flex-row items-center justify-center gap-2">
          <Spinner size={14} />
          <Text class="text-sm text-muted-foreground">Searching themes...</Text>
        </View>
      ) : null}

      {results() ? (
        results()!.length === 0 ? (
          <View class="min-h-40 items-center justify-center rounded-2xl border border-dashed border-border" accessibilityLabel="No supported open-source themes found">
            <Text class="text-sm font-medium text-foreground">No supported open-source themes found</Text>
            <Text class="mt-1 text-xs text-muted-foreground">Try a broader search.</Text>
          </View>
        ) : (
          <View class="flex-row flex-wrap gap-2">
            <Each of={[...results()!]} key={(extension) => extension.id}>
              {(extension) => {
                const isInstalling = () => installingId() === extension().id;
                const action = () => (installedNow(extension()) ? "Update" : "Install");
                const progress = () => (installedNow(extension()) ? "Updating" : "Installing");
                return (
                  <View class="min-w-[280px] flex-1 gap-3 rounded-xl border border-border-70 p-3 hover:bg-accent-50 transition-colors duration-150 ease-in-out" style={{ backgroundColor: tokenAlpha("card", 0.6) }} role="group" accessibilityLabel={extension().name}>
                    <View class="min-w-0 flex-row gap-3">
                      <ExtensionIcon extension={extension()} />
                      <View class="min-w-0 flex-1">
                        <Text class="text-sm font-medium text-foreground truncate">{extension().name}</Text>
                        <Text class="text-xs text-muted-foreground truncate">{`${extension().publisher} · ${formatDownloads(extension().downloadCount)} downloads`}</Text>
                      </View>
                    </View>
                    <Text class="min-h-8 text-xs leading-4 text-muted-foreground line-clamp-2">{extension().description || "A community color theme for your editor."}</Text>
                    <View class="flex-row items-center justify-between gap-2">
                      <View class="min-w-0 flex-row items-center gap-2">
                        {extension().sourceUrl ? (
                          <View accessibilityLabel={`View source for ${extension().name}`} onPress={() => void openUrl(extension().sourceUrl!).catch(() => undefined)} class="size-5 items-center justify-center rounded-md hover:bg-accent">
                            <SettingsIcon name="external-link" size={14} />
                          </View>
                        ) : null}
                      </View>
                      <View
                        accessibilityLabel={`${isInstalling() ? progress() : action()} ${extension().name}`}
                        disabled={installingId() !== null}
                        onPress={() => void handleInstall(extension(), false)}
                        class="h-7 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
                      >
                        {isInstalling() ? <Spinner size={14} /> : <SettingsIcon name={installedNow(extension()) ? "rotate-ccw" : "download"} size={14} />}
                        <Text class="text-xs font-medium text-foreground">{isInstalling() ? `${progress()}...` : action()}</Text>
                      </View>
                    </View>
                  </View>
                );
              }}
            </Each>
          </View>
        )
      ) : null}

      {pendingUpdate() ? (
        <SettingsDialog
          open
          onClose={() => pendingUpdate.set(null)}
          title={`Update “${pendingUpdate()!.name}”?`}
          description="This replaces its installed variants, including any local edits. Variants no longer in the extension will be removed."
          testID="Update community theme"
          footer={
            <>
              <SettingsButton label="Cancel" onPress={() => pendingUpdate.set(null)} />
              <SettingsButton label="Update theme" tone="primary" onPress={() => { const extension = pendingUpdate(); pendingUpdate.set(null); if (extension) void handleInstall(extension, true); }} />
            </>
          }
        />
      ) : null}
    </View>
  );
}

interface ImportedFile { name: string; size: number; text: () => Promise<string> }

function ThemeImportBody(props: { session: AbortController; onClose: () => void; debounceMs?: number }) {
  const { signal: abortSignal } = props.session;
  const json = signal("");
  const fileName = signal<string | null>(null);
  const error = signal<string | null>(null);
  const isReading = signal(false);
  const conflicts = signal<CustomTheme[] | null>(null);
  // A newer read supersedes an older one still in flight.
  let importRequest = 0;
  const isCurrent = (id: number) => id === importRequest && !abortSignal.aborted;

  const readThemeFile = async (file: ImportedFile) => {
    const oversized = describeOversizedThemeFile(file.size);
    if (oversized) { error.set(oversized); return; }
    const id = ++importRequest;
    isReading.set(true);
    let text: string | null = null;
    try { text = await file.text(); } catch { text = null; }
    if (!isCurrent(id)) return;
    isReading.set(false);
    if (text === null) { error.set("Could not read that file. Paste the JSON below instead."); return; }
    json.set(text);
    fileName.set(file.name);
    error.set(null);
  };

  const installThemeBatch = async (files: ImportedFile[], id: number) => {
    const failures: string[] = [];
    const parsed: { theme: ThemeDefinition; sourceName: string }[] = [];
    for (const file of files) {
      const oversized = describeOversizedThemeFile(file.size);
      if (oversized) { failures.push(`${file.name}: too large`); continue; }
      try {
        parsed.push({ sourceName: file.name, theme: parseThemeImport(await file.text()) });
      } catch (cause) {
        failures.push(`${file.name}: ${cause instanceof Error ? cause.message : "not a theme file"}`);
      }
    }
    if (!isCurrent(id)) return;
    const installed: CustomTheme[] = [];
    const conflicting: CustomTheme[] = [];
    for (const theme of pairVsCodeThemes(resolveThemeLabelCollisions(parsed))) {
      if (customThemes().some((existing) => existing.id === theme.id)) { conflicting.push(theme); continue; }
      try {
        installCustomTheme(theme);
        installed.push(theme);
      } catch (cause) {
        failures.push(`${theme.label}: ${cause instanceof Error ? cause.message : "could not install"}`);
      }
    }
    if (installed.length > 0) announceImportedMany(installed, { updated: false });
    error.set(failures.length > 0 ? failures.join("; ") : null);
    if (conflicting.length > 0) conflicts.set(conflicting);
    else if (installed.length > 0 && failures.length === 0) props.onClose();
  };

  const readThemeBatch = (files: ImportedFile[]) => {
    const id = ++importRequest;
    isReading.set(true);
    return installThemeBatch(files, id).finally(() => { if (isCurrent(id)) isReading.set(false); });
  };
  const readThemeFiles = (files: ImportedFile[]) => {
    if (files.length === 0) return;
    if (files.length === 1) void readThemeFile(files[0]!);
    else void readThemeBatch(files);
  };
  const filesAtPaths = async (paths: string[]): Promise<ImportedFile[]> =>
    Promise.all(
      paths.map(async (path) => {
        let size = 0;
        try { size = Number((await stat(path)).size); } catch { size = 0; }
        return { name: path.split("/").pop() ?? path, size, text: async () => String(await readFile(path, "utf8")) };
      }),
    );
  const readPaths = async (paths: string[]) => {
    const files = await filesAtPaths(paths);
    if (abortSignal.aborted) return;
    readThemeFiles(files);
  };
  const chooseFiles = async () => {
    try {
      const paths = await pickFiles();
      if (paths.length > 0) await readPaths(paths);
    } catch {
      error.set("Could not read that file. Paste the JSON below instead.");
    }
  };

  const versionedCopy = (theme: CustomTheme, preferredName?: string | null): CustomTheme => {
    const copyOf = (name: string): CustomTheme =>
      parseThemeFile({
        version: THEME_FILE_VERSION, name: name.slice(0, 48), appearance: theme.appearance, colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}), ...(theme.managed ? { managed: true } : {}),
      });
    if (preferredName && preferredName.toLowerCase() !== theme.label.toLowerCase()) {
      const candidate = copyOf(preferredName);
      if (!customThemes().some((existing) => existing.id === candidate.id)) return candidate;
    }
    for (let copy = 1; copy < 100; copy += 1) {
      const candidate = copyOf(`${theme.label.slice(0, 48 - ` (${copy})`.length)} (${copy})`);
      if (customThemes().some((existing) => existing.id === candidate.id)) continue;
      return candidate;
    }
    throw new Error(`Too many copies of "${theme.label}".`);
  };

  const resolveConflicts = (mode: "update" | "copy") => {
    const pending = conflicts();
    if (!pending) return;
    const resolved: CustomTheme[] = [];
    const failures: string[] = [];
    const preferredName = pending.length === 1 && fileName() ? humanizeThemeName(fileName()!.replace(/\.[^.]+$/, "")) : null;
    for (const theme of pending) {
      try {
        if (mode === "update") {
          const existing = customThemes().find((candidate) => candidate.id === theme.id);
          const next = existing?.collection ? { ...theme, collection: existing.collection } : theme;
          updateCustomTheme(next);
          resolved.push(next);
        } else {
          const copy = versionedCopy(theme, preferredName);
          installCustomTheme(copy);
          resolved.push(copy);
        }
      } catch (cause) {
        failures.push(`${theme.label}: ${cause instanceof Error ? cause.message : "failed"}`);
      }
    }
    if (resolved.length > 0) announceImportedMany(resolved, { updated: mode === "update" });
    conflicts.set(null);
    if (failures.length > 0) error.set([error(), ...failures].filter(Boolean).join("; "));
    else if (!error()) props.onClose();
  };

  const handleSubmit = () => {
    const oversized = describeOversizedThemeFile(json().length);
    if (oversized) { error.set(oversized); return; }
    try {
      const theme = parseThemeImport(json());
      if (customThemes().some((existing) => existing.id === theme.id)) {
        error.set(null);
        conflicts.set([theme]);
        return;
      }
      installCustomTheme(theme);
      announceImported(theme);
      props.onClose();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : "That theme file is invalid.");
    }
  };

  return (
    <View class="gap-4">
      <ThemeSearchSection signal={abortSignal} debounceMs={props.debounceMs} onInstalled={(themes, context) => { announceImportedMany(themes, context); props.onClose(); }} />

      <View class="flex-row items-center gap-3">
        <View class="h-px flex-1 bg-border" />
        <Text class="text-2xs uppercase tracking-wider text-muted-foreground">or import a file</Text>
        <View class="h-px flex-1 bg-border" />
      </View>

      {conflicts() ? (
        <View class="gap-3">
          <View class="rounded-xl border border-border-70 bg-muted-50 p-3">
            <Text class="text-sm font-medium text-foreground">Already installed</Text>
            <Text class="mt-1 text-xs text-muted-foreground">{conflicts()!.map((theme) => theme.label).join(", ")}</Text>
          </View>
          <View class="flex-row flex-wrap items-center gap-2">
            <SettingsButton label="Update existing" tone="primary" onPress={() => resolveConflicts("update")} />
            <SettingsButton label="Keep both" onPress={() => resolveConflicts("copy")} />
            <SettingsButton label="Back" onPress={() => conflicts.set(null)} />
            <SettingsButton label="Cancel" onPress={props.onClose} />
          </View>
        </View>
      ) : (
        <View class="gap-4">
          <View class="flex-row flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-3 py-3" onFileDrop={(event) => void readPaths(event.uris.map((uri) => decodeURIComponent(uri.replace(/^file:\/\//, ""))))} accessibilityLabel="Theme file drop target">
            <View class="min-w-0 flex-1">
              <Text class="text-sm font-medium text-foreground">Theme file</Text>
              <Text class="text-xs text-muted-foreground truncate">{fileName() ?? "Drop R3 Code or VS Code .json files"}</Text>
            </View>
            <View
              accessibilityLabel="Choose files"
              disabled={isReading()}
              onPress={() => void chooseFiles()}
              class="h-8 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
            >
              <SettingsIcon name="download" size={14} />
              <Text class="text-sm font-medium text-foreground">{isReading() ? "Reading…" : "Choose files"}</Text>
            </View>
          </View>
          <View class="gap-2">
            <Text class="text-sm font-medium text-foreground">Theme JSON</Text>
            <DialogInput
              multiline
              value={json()}
              accessibilityLabel="Theme JSON"
              placeholder={'{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'}
              autoCapitalize="none"
              autoCorrect={false}
              onChange={(event) => json.set(event.value)}
              class="min-h-44 w-full rounded-xl border border-input bg-background p-3 font-mono text-xs text-foreground"
            />
          </View>
          <View class="flex-row justify-end gap-2">
            <SettingsButton label="Cancel" accessibilityLabel="Cancel add theme" onPress={props.onClose} />
            <SettingsButton label="Add theme" accessibilityLabel="Confirm add theme" tone="primary" disabled={json().trim().length === 0 || isReading()} onPress={handleSubmit} />
          </View>
        </View>
      )}

      <ErrorBox message={error} />
    </View>
  );
}

/** The dialog. Mount it while it is open; unmounting (or `onClose`) ends the session. */
export function ThemeImportDialog(props: { onClose: () => void; debounceMs?: number }) {
  const session = new AbortController();
  cleanup(() => session.abort());
  useOverlayOpen(() => true, "add theme");
  const close = () => {
    session.abort();
    props.onClose();
  };
  return (
    <SettingsDialog open onClose={close} title="Add a theme" width={768} testID="Add a theme">
      <ThemeImportBody session={session} onClose={close} debounceMs={props.debounceMs} />
    </SettingsDialog>
  );
}
