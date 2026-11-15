// ProviderModelsSection.tsx and CustomModelEditor.tsx: the model list with picker visibility,
// favourites, ordering and custom models.
import { computed, signal, Text, View } from "nsh";
import { Input, Switch } from "nsh/base";
import {
  bulkHiddenModels, capabilityLabels, groupModels, groupOf, hasReasoning, validateCustomModel,
  type CustomModel, type ModelGroup, type ProviderModelView,
} from "./logic";
import { CustomModelEditor } from "./CustomModelEditor";
import { ButtonText, ErrorText, IconButton, PillButton, Tip, UiIcon } from "./ui";

const FILTER_THRESHOLD = 8;

export interface ModelsProps {
  instanceId: string;
  driver: string;
  models: ProviderModelView[];
  custom: CustomModel[];
  hidden: string[];
  favorites: string[];
  order: string[];
  supportsCustom: boolean;
  placeholder: string;
  canManageCustom: boolean;
  canWritePreferences: boolean;
  onCustomChange: (next: CustomModel[]) => void;
  onHiddenChange: (next: string[], affected: string[]) => void;
  onToggleFavorite: (slug: string, favorite: boolean) => void;
  onOrderChange: (next: string[]) => void;
  onFavoritesRemoved: (slugs: string[]) => void;
}

function ModelRow(props: {
  model: ProviderModelView; hidden: boolean; favorite: boolean; canUp: boolean; canDown: boolean; filtering: boolean; flagMissing: boolean;
  canWritePreferences: boolean; canManageCustom: boolean;
  onFavorite: () => void; onMove: (direction: -1 | 1) => void; onHidden: (hidden: boolean) => void; onEdit: () => void; onRemove: () => void;
}) {
  const labels = () => capabilityLabels(props.model, props.flagMissing);
  return <View testID={`model ${props.model.slug}`} class={`h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-accent-50 transition-colors duration-150 ease-in-out ${props.hidden ? "opacity-50" : ""}`}>
    <View class="w-6 items-center">
      <IconButton label={`${props.favorite ? "Remove" : "Add"} ${props.model.name} ${props.favorite ? "from" : "to"} favorites`} icon="star" size={12} tooltip={props.favorite ? "Remove from favorites" : "Add to favorites"}
        tone={props.favorite ? "warning" : "muted"} disabled={!props.canWritePreferences} onPress={props.onFavorite} />
    </View>
    <View class="min-w-0 flex-1 flex-row items-baseline gap-2">
      <Text class={props.hidden ? "truncate text-xs text-muted-foreground" : "truncate text-xs text-foreground"}>{props.model.name}</Text>
      {props.model.name !== props.model.slug ? <Text class="font-mono text-2xs text-muted-foreground truncate">{props.model.slug}</Text> : null}
      {props.model.isCustom ? <Text class="text-2xs text-muted-foreground">custom</Text> : null}
    </View>
    {labels().length > 0 ? <Text class="text-2xs text-muted-foreground">{labels().join(" · ")}</Text> : null}
    <View class="flex-row items-center justify-end gap-0.5">
      {!props.hidden && !props.filtering ? <>
        <IconButton label={`Move ${props.model.name} up`} tooltip="Move up" icon="arrow-up" size={12} disabled={!props.canWritePreferences || !props.canUp} onPress={() => props.onMove(-1)} />
        <IconButton label={`Move ${props.model.name} down`} tooltip="Move down" icon="arrow-down" size={12} disabled={!props.canWritePreferences || !props.canDown} onPress={() => props.onMove(1)} />
      </> : null}
      {props.model.isCustom ? <>
        <IconButton label={`Edit ${props.model.slug}`} tooltip="Edit name and options" icon="pencil" size={12} disabled={!props.canManageCustom} onPress={props.onEdit} />
        <IconButton label={`Remove ${props.model.slug}`} tooltip="Remove custom model" icon="x" size={12} disabled={!props.canManageCustom} onPress={props.onRemove} />
      </> : null}
    </View>
    <View tooltip={<Tip label={props.model.isCustom ? "Custom models are always shown in the picker" : props.hidden ? "Hidden from picker" : "Shown in picker"} />}>
    <Switch checked={!props.hidden} disabled={!props.canWritePreferences || props.model.isCustom}
      onChange={(event: { checked?: boolean }) => props.onHidden(!event.checked)}
      accessibilityLabel={`Show ${props.model.name} in the model picker`} testID={`Show ${props.model.name} ${props.hidden ? "off" : "on"}`}
      class="h-4 w-6.5 items-center" trackClass="h-4 w-6.5 justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out" thumbClass="size-3 rounded-full bg-background checked:translate-x-2.5 transition-transform duration-150 ease-in-out" />
    </View>
  </View>;
}

function GroupLabel(props: { label: string; first: boolean }) {
  return <Text class={`px-2 pb-1.5 text-2xs text-muted-foreground ${props.first ? "pt-1" : "pt-5"}`}>{props.label}</Text>;
}

export function ProviderModels(props: ModelsProps) {
  const input = signal("");
  const adding = signal(false);
  const filter = signal("");
  const error = signal("");
  const editing = signal<string | null>(null);

  const options = () => ({ favorites: new Set(props.favorites), hidden: new Set(props.hidden), order: props.order });
  const display = computed(() => groupModels(props.models, options()));
  const favoriteCount = () => display().filter((model) => groupOf(model, options()) === "favorite").length;
  const hiddenCount = () => display().filter((model) => groupOf(model, options()) === "hidden").length;
  const builtIn = () => props.models.filter((model) => !model.isCustom);
  const allBuiltInHidden = () => builtIn().length > 0 && builtIn().every((model) => props.hidden.includes(model.slug));
  const flagMissing = () => props.models.some(hasReasoning);
  const showFilter = () => props.models.length > FILTER_THRESHOLD;
  const normalizedFilter = () => filter().trim().toLowerCase();
  const filtering = () => showFilter() && normalizedFilter().length > 0;
  const visible = computed(() => filtering()
    ? display().filter((model) => model.name.toLowerCase().includes(normalizedFilter()) || model.slug.toLowerCase().includes(normalizedFilter()))
    : display());
  const rows = computed(() => visible().map((model, index) => {
    const group: ModelGroup = groupOf(model, options());
    const previous = visible()[index - 1];
    const full = display();
    const at = full.findIndex((entry) => entry.slug === model.slug);
    const before = full[at - 1];
    const after = full[at + 1];
    return {
      model, group, startsGroup: previous === undefined || groupOf(previous, options()) !== group, first: index === 0,
      canUp: !filtering() && before !== undefined && groupOf(before, options()) === group,
      canDown: !filtering() && after !== undefined && groupOf(after, options()) === group,
    };
  }));

  function add() {
    if (!props.canManageCustom || !props.supportsCustom) return;
    const problem = validateCustomModel(input(), props.models, props.custom);
    if (problem) { error.set(problem); return; }
    const slug = input().trim();
    filter.set("");
    props.onCustomChange([...props.custom, { slug, name: slug, capabilities: null }]);
    input.set(""); error.set(""); adding.set(false);
  }
  function cancelAdd() { input.set(""); error.set(""); adding.set(false); }
  function remove(slug: string) {
    if (!props.canManageCustom) return;
    if (editing() === slug) editing.set(null);
    props.onCustomChange(props.custom.filter((entry) => entry.slug !== slug));
    props.onOrderChange(props.order.filter((model) => model !== slug));
    if (props.favorites.includes(slug)) props.onFavoritesRemoved([slug]);
    error.set("");
  }
  function move(slug: string, direction: -1 | 1) {
    if (!props.canWritePreferences) return;
    const full = display();
    const index = full.findIndex((model) => model.slug === slug);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= full.length) return;
    if (groupOf(full[index], options()) !== groupOf(full[next], options())) return;
    const slugs = full.map((model) => model.slug);
    [slugs[index], slugs[next]] = [slugs[next], slugs[index]];
    props.onOrderChange(slugs);
  }
  function setHidden(slug: string, hidden: boolean) {
    if (!props.canWritePreferences || hidden === props.hidden.includes(slug)) return;
    props.onHiddenChange(hidden ? [...props.hidden, slug] : props.hidden.filter((model) => model !== slug), [slug]);
  }

  return <View class="gap-0">
    <View class="flex-row flex-wrap items-center justify-between gap-2">
      {showFilter() ? <Input accessibilityLabel="Filter models" value={filter()} placeholder="Filter models" autoCapitalize="none" onChange={(event) => filter.set(event.value)}
        class="h-8 w-56 rounded-md border border-input bg-background px-2.5 text-sm text-foreground" /> : <View />}
      <View class="flex-row items-center gap-2">
        {builtIn().length > 0 ? <PillButton label={allBuiltInHidden() ? "Enable all models" : "Disable all models"} size="xs" variant="ghost" disabled={!props.canWritePreferences}
          onPress={() => props.onHiddenChange(bulkHiddenModels(props.models, props.hidden), builtIn().map((model) => model.slug))}>
          <ButtonText tone="muted">{allBuiltInHidden() ? "Enable all" : "Disable all"}</ButtonText></PillButton> : null}
        <Text class="text-xs text-muted-foreground">{`${props.models.length} model${props.models.length === 1 ? "" : "s"}${favoriteCount() > 0 ? ` · ${favoriteCount()} favorite${favoriteCount() === 1 ? "" : "s"}` : ""}${hiddenCount() > 0 ? ` · ${hiddenCount()} hidden` : ""}`}</Text>
      </View>
      {props.supportsCustom && !adding() ? <View class="-mr-2 ml-auto"><PillButton label="Add custom model" size="xs" variant="ghost" disabled={!props.canManageCustom} onPress={() => adding.set(true)}>
        <UiIcon name="plus" size={12} /><ButtonText tone="muted">Add custom model</ButtonText></PillButton></View> : null}
    </View>
    <View class="mt-2 gap-0">
      {visible().length === 0 ? <Text class="px-2 py-2 text-xs text-muted-foreground">{filtering() ? "No models match." : "No models reported for this provider yet."}</Text> : null}
      <Each of={rows()} key={(row) => `${props.instanceId}:${row.model.slug}`}>{(row) => <View>
        {row().startsGroup && favoriteCount() > 0 && row().group === "favorite" ? <GroupLabel label="Favorites" first={row().first} /> : null}
        {row().startsGroup && favoriteCount() > 0 && row().group === "visible" ? <GroupLabel label="All" first={row().first} /> : null}
        {row().startsGroup && row().group === "hidden" ? <GroupLabel label="Hidden from picker" first={row().first} /> : null}
        <ModelRow model={row().model} hidden={row().group === "hidden"} favorite={row().group === "favorite"} canUp={row().canUp} canDown={row().canDown} filtering={filtering()}
          flagMissing={flagMissing()} canWritePreferences={props.canWritePreferences} canManageCustom={props.canManageCustom}
          onFavorite={() => props.onToggleFavorite(row().model.slug, row().group !== "favorite")} onMove={(direction) => move(row().model.slug, direction)}
          onHidden={(hidden) => setHidden(row().model.slug, hidden)} onEdit={() => editing.set(editing() === row().model.slug ? null : row().model.slug)} onRemove={() => remove(row().model.slug)} />
        {props.canManageCustom && row().model.isCustom && editing() === row().model.slug && props.custom.find((entry) => entry.slug === row().model.slug)
          ? <CustomModelEditor driver={props.driver} builtInModels={builtIn()} entry={props.custom.find((entry) => entry.slug === row().model.slug) as CustomModel}
            onSave={(next) => { props.onCustomChange(props.custom.map((entry) => entry.slug === next.slug ? next : entry)); editing.set(null); }} onCancel={() => editing.set(null)} /> : null}
      </View>}</Each>
    </View>
    {props.supportsCustom && props.canManageCustom && adding() ? <View class="mt-3 flex-row items-center gap-2">
      <Input accessibilityLabel="Custom model slug" autoFocus value={input()} placeholder={props.placeholder} autoCapitalize="none" autoCorrect={false}
        onChange={(event) => { input.set(event.value); if (error()) error.set(""); }} onSubmit={add}
        class="h-8 flex-1 rounded-md border border-input bg-background px-2.5 text-sm text-foreground" />
      <PillButton label="Add model" onPress={add}><ButtonText>Add</ButtonText></PillButton>
      <PillButton label="Cancel add model" variant="ghost" onPress={cancelAdd}><ButtonText tone="muted">Cancel</ButtonText></PillButton>
    </View> : null}
    {props.supportsCustom && error() ? <View class="mt-2"><ErrorText>{error()}</ErrorText></View> : null}
  </View>;
}
