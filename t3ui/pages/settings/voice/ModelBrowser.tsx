// SpeechModelBrowser and ModelCard (VoiceSettingsPanel.tsx): the language rail, the model search with its
// sort and filter menu, and one card per model with size, benchmark scores, the download / cancel / delete
// actions and the progress bar.
import { computed, signal, Scroll, Text, View } from "nsh";
import { Input, Menu, MenuItem, MenuSeparator } from "nsh/base";
import { trackOpenChange, useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { PillButton } from "../providers/ui";
import {
  benchmarkLines, browserIntro, browserView, cardModel, languageLabel, modelCardView, sortLabels,
  type EnvironmentSpeechModel, type EnvironmentSpeechStatus, type SpeechBenchmarkTier, type SpeechModelSort,
} from "./speech";
import type { VoiceCatalog } from "./voiceCatalog";
import { ModelBadge } from "./VoiceControls";
import { VoiceIcon } from "./VoiceIcon";

const SORTS: SpeechModelSort[] = ["recommended", "size", "accuracy", "speed"];
const MENU_ITEM_CLASS = "min-h-7 flex-row items-center justify-between gap-3 rounded-sm px-2 py-1 hover:bg-accent";

function Benchmarks(props: { model: EnvironmentSpeechModel; languages: readonly string[]; tier: SpeechBenchmarkTier; facts: readonly string[] }) {
  const lines = () => benchmarkLines(props.model, props.languages, props.tier);
  return (
    <View class="mt-1 flex-row flex-wrap gap-x-3 gap-y-1">
      <Each of={lines().scores} key={(score) => score.language}>
        {(score) => (
          <View class="flex-row">
            <Text class="text-xs text-muted-foreground">{`${languageLabel(score().language)}: `}</Text>
            {score().grade !== null ? (
              <>
                <Text class="text-xs font-medium text-foreground">{score().grade}</Text>
                <Text class="text-xs text-muted-foreground">{` (${score().errorPercent}% error)`}</Text>
              </>
            ) : <Text class="text-xs text-muted-foreground">not benchmarked</Text>}
          </View>
        )}
      </Each>
      <View class="flex-row">
        <Text class="text-xs text-muted-foreground">Speed: </Text>
        <Text class={lines().speed.endsWith("/ 30 s") ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>{lines().speed}</Text>
      </View>
      <Each of={props.facts} key={(fact) => fact}>{(fact) => <Text class="text-xs text-muted-foreground">{fact()}</Text>}</Each>
    </View>
  );
}

/** One model: name, badges, description, benchmark line, progress, and its actions. */
export function ModelCard(props: {
  model: EnvironmentSpeechModel;
  languages: readonly string[];
  tier: SpeechBenchmarkTier;
  catalog: VoiceCatalog;
  /** The active model's test control sits before the actions. */
  testControls?: any;
}) {
  const model = () => cardModel(props.model, props.catalog.requestedDownload());
  const view = () => modelCardView(model());
  const busy = () => props.catalog.controlsDisabled();
  return (
    <View class="flex-row flex-wrap items-start gap-3 px-4 py-2.5" testID={`Model ${props.model.id} (${view().action})`}>
      <View class="min-w-0 flex-1">
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Text class="text-sm font-medium leading-5 text-foreground">{model().name}</Text>
          <Each of={view().badges} key={(badge) => badge.kind}>
            {(badge) => <ModelBadge icon={badge().kind === "recommended" ? "star" : badge().kind === "streaming" ? "audio-lines" : "languages"} label={badge().label} tooltip={badge().tooltip} />}
          </Each>
        </View>
        <Text class="mt-0.5 text-xs leading-relaxed text-muted-foreground">{model().description}</Text>
        <Benchmarks model={model()} languages={props.languages} tier={props.tier} facts={view().facts} />
        {view().downloading ? (
          <View class="mt-2" accessibilityLabel={`${model().name} download progress`} testID={`${model().name} download progress ${Math.round(view().progress)}`}>
            <View class="h-1 overflow-hidden rounded-full bg-muted">
              <View class="h-full bg-primary" style={{ width: `${view().progress}%` }} />
            </View>
            <Text class="mt-1 text-2xs text-muted-foreground">{view().progressLabel ?? ""}</Text>
          </View>
        ) : null}
      </View>
      <View class="max-w-full flex-row flex-wrap items-center justify-end gap-1">
        {props.testControls ?? null}
        {view().action === "cancel" ? (
          <View
            accessibilityLabel={`Cancel ${model().name} download`} role="button" disabled={!props.catalog.canCancel()}
            onPress={() => { if (props.catalog.canCancel()) void props.catalog.cancel(props.model.id); }}
            class={`size-7 items-center justify-center rounded-md hover:bg-accent-50 ${props.catalog.canCancel() ? "" : "opacity-64"}`}
          >
            <VoiceIcon name="x" size={14} />
          </View>
        ) : view().action === "download" ? (
          <PillButton label="Download" size="xs" disabled={busy()} onPress={() => void props.catalog.download(props.model.id)}>
            <VoiceIcon name="download" size={14} /><Text class="text-sm text-foreground">Download</Text>
          </PillButton>
        ) : view().action === "selected" ? (
          <PillButton label="Selected" size="xs" disabled onPress={() => undefined}>
            <VoiceIcon name="check" size={14} /><Text class="text-sm text-foreground">Selected</Text>
          </PillButton>
        ) : (
          <PillButton label="Use model" size="xs" disabled={busy()} onPress={() => void props.catalog.select(props.model.id)}>
            <Text class="text-sm text-foreground">Use model</Text>
          </PillButton>
        )}
        {view().canDelete ? (
          <View
            accessibilityLabel={`Delete ${model().name}`} role="button" disabled={busy()}
            onPress={() => { if (!busy()) void props.catalog.remove(props.model.id); }}
            class={`size-7 items-center justify-center rounded-md hover:bg-accent-50 ${busy() ? "opacity-64" : ""}`}
          >
            <VoiceIcon name="trash-2" size={14} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function LanguageRow(props: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <View
      role="button" accessibilityLabel={props.label} accessibilityState={{ selected: props.selected }} testID={`Language ${props.label} (${props.selected ? "on" : "off"})`}
      onPress={props.onPress}
      class={`shrink-0 flex-row items-center justify-between gap-2 rounded-md px-2.5 py-1.5 hover:bg-muted-50 ${props.selected ? "bg-muted" : ""}`}
    >
      <Text class={`text-sm text-foreground ${props.selected ? "font-medium" : ""}`}>{props.label}</Text>
      {props.selected ? <VoiceIcon name="check" size={14} /> : null}
    </View>
  );
}

/** The browser, for a transcriber that reports `supported: true`; the unsupported notice is the caller's. */
export function ModelBrowser(props: {
  status: Extract<EnvironmentSpeechStatus, { supported: true }>;
  catalog: VoiceCatalog;
  preferred: readonly string[];
  /** The control beside the selected model's actions (the reference's "Test model"). */
  testControls?: () => any;
}) {
  const search = signal("");
  const sort = signal<SpeechModelSort>("recommended");
  const downloadedOnly = signal(false);
  const languageSearch = signal("");
  const selection = signal<string[] | null>(null);
  const menuOpen = signal(false);
  useOverlayOpen(() => menuOpen(), "model sort menu");
  const view = computed(() => browserView({
    models: props.catalog.models(), preferred: props.preferred, selection: selection(), languageSearch: languageSearch(), search: search(),
    sort: sort(), downloadedOnly: downloadedOnly(), benchmarkTier: props.status.benchmarkTier,
  }));
  const labels = computed(() => sortLabels(view().selectedLanguages[0] ?? "en"));
  const toggleLanguage = (code: string) => {
    const current = view().selectedLanguages;
    selection.set(current.includes(code) ? current.filter((language) => language !== code) : [...current, code]);
  };
  return (
    <View testID="Speech models">
      <View class="h-px bg-border-50" />
      <View class="border-b border-border-60 px-4 py-2">
        <Text class="text-xs text-muted-foreground">{browserIntro(props.status.benchmarkTier)}</Text>
      </View>
      <View class="flex-row">
        <View class="w-44 border-r border-border-60 bg-muted-10">
          <View class="gap-2 p-3">
            <Text class="text-sm font-medium text-foreground">Languages</Text>
            <Input
              value={languageSearch()} placeholder="Search languages" accessibilityLabel="Search languages"
              onChange={(e: { value: string }) => languageSearch.set(e.value)}
              class="h-7 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground"
            />
          </View>
          <Scroll class="h-72 px-2 pb-2" accessibilityLabel="Browse models by language">
            <View class="gap-1">
              <LanguageRow label="All languages" selected={view().selectedLanguages.length === 0} onPress={() => selection.set([])} />
              <Each of={view().visibleLanguages} key={(code) => code}>
                {(code) => <LanguageRow label={languageLabel(code())} selected={view().selectedLanguages.includes(code())} onPress={() => toggleLanguage(code())} />}
              </Each>
              {view().visibleLanguages.length === 0 ? <Text class="px-2 py-1 text-xs text-muted-foreground">No languages match.</Text> : null}
            </View>
          </Scroll>
        </View>
        <View class="min-w-0 flex-1">
          <View class="gap-2 p-3">
            <Text class="text-sm font-medium text-foreground">{view().heading}</Text>
            <View class="h-7 flex-row items-center rounded-lg border border-input bg-background">
              <Input
                value={search()} placeholder="Search models" accessibilityLabel="Search transcription models"
                onChange={(e: { value: string }) => search.set(e.value)}
                class="h-7 min-w-0 flex-1 px-2.5 text-sm text-foreground"
              />
              <Menu
                popupClass="min-w-48 rounded-lg border border-border bg-popover-84 p-1 shadow-lg"
                align="end"
                onOpenChange={trackOpenChange(menuOpen)}
                trigger={
                  <View
                    role="button" class="mr-0.5 h-6 flex-row items-center gap-1 rounded-md px-1.5 hover:bg-accent-50"
                    accessibilityLabel={`Sort and filter models: ${labels()[sort()]}${downloadedOnly() ? ", downloaded only" : ""}`}
                  >
                    <VoiceIcon name="sliders-horizontal" size={14} tone="muted-foreground" />
                    <Text class="text-xs text-muted-foreground">{labels()[sort()]}</Text>
                    {downloadedOnly() ? <Text class="text-xs text-muted-foreground">1</Text> : null}
                  </View>
                }
              >
                <View class="px-2 py-1.5"><Text class="text-xs font-medium text-muted-foreground">Sort by</Text></View>
                <Each of={SORTS} key={(value) => value}>
                  {(value) => (
                    <MenuItem role="menuitemradio" checked={sort() === value()} accessibilityLabel={labels()[value()]} class={MENU_ITEM_CLASS} onSelect={() => sort.set(value())}
                      indicator={<VoiceIcon name="check" size={14} />}>
                      <Text class="text-sm text-popover-foreground">{labels()[value()]}</Text>
                    </MenuItem>
                  )}
                </Each>
                <MenuSeparator class="my-1 h-px bg-border" />
                <MenuItem checked={downloadedOnly()} accessibilityLabel="Downloaded only" class={MENU_ITEM_CLASS} onSelect={() => downloadedOnly.set(!downloadedOnly())}
                  indicator={<VoiceIcon name="check" size={14} />}>
                  <Text class="text-sm text-popover-foreground">Downloaded only</Text>
                </MenuItem>
              </Menu>
            </View>
          </View>
          <Scroll class="h-72" accessibilityLabel="Transcription models">
            {view().noMatch ? <View class="px-4 py-2"><Text class="text-sm text-muted-foreground">No models match.</Text></View> : null}
            <Each of={view().rendered} key={(model) => model.id}>
              {(model, index) => (
                <View>
                  {index() > 0 ? <View class="h-px bg-border-60" /> : null}
                  <ModelCard model={model()} languages={view().selectedLanguages} tier={props.status.benchmarkTier} catalog={props.catalog}
                    testControls={model().active ? props.testControls?.() : undefined} />
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </View>
    </View>
  );
}
