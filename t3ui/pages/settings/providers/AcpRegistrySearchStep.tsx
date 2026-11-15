// AcpRegistrySearchStep.tsx: search the ACP Registry, prepare the chosen agent, then the wizard moves on.
import { FadeScroll } from "../../../components/FadeScroll";
import { effect, Image, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { ProviderApi } from "./data";
import {
  ACP_REGISTRY_SEARCH_DEBOUNCE_MS, applyPrepareResult, FIRST_CLASS_REGISTRY_AGENT_IDS, isConfiguredAcpRegistryAgent, officialAcpIconUrl, readAcpAgents, type AcpAgent,
} from "./acp";
import type { InstanceConfig } from "./logic";
import { ButtonText, IconButton, PillButton, ProviderIconView, UiIcon } from "./ui";

function errorMessage(cause: unknown, fallback: string): string { return cause instanceof Error && cause.message.trim() ? cause.message : fallback; }

/** Search and prepare state, owned by the dialog because its layout and navigation read it. */
export function createAcpRegistrySearch(api: ProviderApi, enabled: () => boolean) {
  const query = signal("");
  const submitted = signal("");
  const refreshes = signal(0);
  const agents = signal<AcpAgent[] | null>(null);
  const searching = signal(false);
  const searchError = signal<string | null>(null);
  const preparingId = signal<string | null>(null);
  const prepareError = signal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  effect(() => {
    if (!enabled()) return;
    const text = submitted(); refreshes();
    const mine = ++generation;
    searching.set(true); searchError.set(null);
    void api.searchAcpRegistry(text).then((result) => { if (mine === generation) agents.set(readAcpAgents(result)); })
      .catch((cause) => { if (mine === generation) searchError.set(errorMessage(cause, "Could not search the ACP Registry.")); })
      .finally(() => { if (mine === generation) searching.set(false); });
    return () => { generation++; };
  });

  return {
    query, agents, searching, searchError, preparingId, prepareError,
    type(text: string) {
      prepareError.set(null); query.set(text);
      clearTimeout(timer);
      timer = setTimeout(() => submitted.set(text.trim()), ACP_REGISTRY_SEARCH_DEBOUNCE_MS);
    },
    submit() {
      clearTimeout(timer);
      prepareError.set(null);
      const trimmed = query().trim();
      query.set(trimmed);
      if (trimmed === submitted()) refreshes.update((n) => n + 1); else submitted.set(trimmed);
    },
    async prepare(agent: AcpAgent, onPrepared: (agent: AcpAgent) => void) {
      if (preparingId() !== null) return;
      prepareError.set(null); preparingId.set(agent.id);
      try { onPrepared(applyPrepareResult(agent, await api.prepareAcpRegistryAgent(agent.id))); }
      catch (cause) { prepareError.set(errorMessage(cause, "The ACP could not be prepared.")); }
      finally { preparingId.set(null); }
    },
  };
}
export type AcpRegistrySearch = ReturnType<typeof createAcpRegistrySearch>;

function AgentRow(props: { api: ProviderApi; agent: AcpAgent; alreadyAdded: boolean; canAdd: boolean; preparing: boolean; onAdd: () => void }) {
  const progress = () => props.agent.distribution === "binary" ? "Downloading" : "Preparing";
  const icon = () => officialAcpIconUrl(props.agent.icon);
  const about = () => props.agent.website || props.agent.repository;
  const verb = () => props.alreadyAdded ? "Already added" : props.preparing ? progress() : "Add";
  return <View testID={`ACP agent ${props.agent.id}`} class="min-w-0 flex-row items-center justify-between gap-3 py-2.5">
    <View class="min-w-0 flex-1 flex-row items-center gap-3">
      {icon() ? <Image src={icon() as string} style={{ width: 24, height: 24 }} /> : <ProviderIconView driver="acpRegistry" name={props.agent.name} size={24} />}
      <View class="min-w-0 flex-1">
        <Text class="min-w-0 text-sm font-medium text-foreground truncate">{props.agent.name}</Text>
        {props.agent.description ? <Text class="mt-0.5 text-xs text-muted-foreground truncate">{props.agent.description}</Text> : null}
      </View>
    </View>
    <View class="shrink-0 flex-row items-center gap-1.5">
      {about() ? <IconButton label={`About ${props.agent.name}`} icon="external-link" onPress={() => props.api.openExternal(about() as string)} /> : null}
      <PillButton label={`${verb()} ${props.agent.name}`} size="xs" variant={props.preparing ? "ghost" : "outline"} disabled={!props.canAdd || props.alreadyAdded} onPress={props.onAdd}>
        <ButtonText>{props.alreadyAdded ? "Added" : props.preparing ? progress() : "Add"}</ButtonText></PillButton>
    </View>
  </View>;
}

export function AcpRegistrySearchStep(props: {
  api: ProviderApi; registry: AcpRegistrySearch; providerInstances: Record<string, InstanceConfig>; canManage: boolean;
  onPrepared: (agent: AcpAgent) => void; onManualConfiguration: () => void; onLocalConfiguration: () => void;
}) {
  const registry = props.registry;
  const results = () => registry.agents()?.filter((agent) => !FIRST_CLASS_REGISTRY_AGENT_IDS.has(agent.id)) ?? null;
  const initial = () => registry.searching() && results() === null;
  const busy = () => registry.preparingId() !== null;
  return <View class="gap-3" testID="ACP registry search">
    <View class="flex-row flex-wrap items-center gap-2">
      <View class="min-w-40 flex-1 flex-row items-center gap-2 rounded-md border border-input bg-background px-2.5">
        <UiIcon name="search" size={14} />
        <Input accessibilityLabel="Search ACP Registry" disabled={busy()} value={registry.query()} placeholder="Search agents…" autoCapitalize="none" autoCorrect={false}
          onChange={(event) => registry.type(event.value)} onSubmit={() => registry.submit()} class="h-8 min-w-0 flex-1 text-sm text-foreground" />
      </View>
      <PillButton label="Enter manually" variant="ghost" disabled={busy()} onPress={props.onManualConfiguration}><ButtonText tone="muted">Enter manually</ButtonText></PillButton>
      <PillButton label="Local ACP command" disabled={busy()} onPress={props.onLocalConfiguration}><ButtonText>Local ACP command</ButtonText></PillButton>
    </View>
    {registry.searchError() || registry.prepareError() ? <View testID="ACP registry error" class="rounded-lg border border-destructive px-3 py-2"><Text class="text-sm text-destructive-foreground">{registry.prepareError() ?? registry.searchError()}</Text></View> : null}
    {initial() ? <View class="min-h-20 items-center justify-center"><Text class="text-sm text-muted-foreground">Searching the registry...</Text></View> : null}
    {results() !== null && results()?.length === 0 ? <View class="min-h-28 items-center justify-center rounded-2xl border border-dashed border-border px-4">
      <Text class="text-sm font-medium text-foreground">No compatible agents found</Text><Text class="mt-1 text-xs text-muted-foreground">Try a broader search.</Text></View> : null}
    {results() !== null && (results()?.length ?? 0) > 0 ? <FadeScroll class="max-h-64" contentClass="pr-2.5">
      <Each of={results() ?? []} key={(agent) => agent.id}>{(agent) => <AgentRow api={props.api} agent={agent()} alreadyAdded={isConfiguredAcpRegistryAgent(props.providerInstances as any, agent().id)}
        canAdd={props.canManage && !busy()} preparing={registry.preparingId() === agent().id} onAdd={() => void registry.prepare(agent(), props.onPrepared)} />}</Each>
    </FadeScroll> : null}
  </View>;
}
