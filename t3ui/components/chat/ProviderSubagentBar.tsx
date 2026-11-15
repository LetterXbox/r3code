// chat/ProviderSubagentBar.tsx: the row that replaces the composer on a provider-native subagent thread (it takes no
// messages): provider mark, model, effort, a live status, "Runs on its own", and Open parent.
import { effect, Image, signal, Text, token, View } from "nsh";
import { providerMetaFor, providerMetas } from "../composer/providerCatalog";
import { accentForeground, instanceInitials } from "../../pages/settings/providers/logic";
import { modelShortName } from "../composer/modelShortName";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import arrowUpLeft from "./icons/arrow-up-left.svg";
import { formatProviderSubagentStatus, type ProviderSubagentStatus } from "./providerSubagentLogic";

/** shouldShowInstanceBadge: an accent colour, or another instance of the same driver. */
export function subagentInstanceBadge(meta: { driver: string; accentColor: string | null } | null | undefined, metas: Iterable<{ driver: string }>): boolean {
  if (!meta) return false;
  if (meta.accentColor) return true;
  return [...metas].filter((other) => other.driver === meta.driver).length > 1;
}

export function ProviderSubagentBar(props: {
  instanceId: () => string;
  model: () => string;
  effort: () => string | null;
  status: () => ProviderSubagentStatus | null;
  onOpenParent: (() => void) | null;
  /** The reference's `actions` slot (NativeChildWorkDialog on an Antigravity subagent), before Open parent. */
  actions?: () => unknown;
}) {
  const now = signal(Date.now());
  const width = signal<number | null>(null);
  const compact = () => width() !== null && width()! <= 560;
  const live = () => { const status = props.status()?.status; return status === "pending" || status === "running" || status === "waiting"; };
  effect(() => {
    if (!live()) return;
    const timer = setInterval(() => now.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const meta = () => providerMetaFor(props.instanceId());
  const modelLabel = () => modelShortName(props.model(), meta()?.driver ?? null);
  return (
    <View class="min-h-12 flex-row items-center gap-3 rounded-2xl py-2 pl-5 pr-2" testID="Provider subagent bar" onLayout={(event) => { const next = event.bounds.size.width; if (next !== width()) width.set(next); }}>
      <View class={`min-w-0 flex-1 ${compact() ? "flex-col items-start gap-0.5" : "flex-row items-center gap-3"}`}>
        <View class="max-w-full min-w-0 flex-row items-center gap-2">
          {meta() ? (
            <View class="relative size-4 shrink-0">
              <ProviderIconView driver={meta()!.driver} instanceId={props.instanceId()} name={meta()!.displayName} accentColor={meta()!.accentColor} size={16} />
              {subagentInstanceBadge(meta(), providerMetas().values()) ? (
                // ProviderInstanceIcon's badge with the bar's badgeClassName (right/bottom -0.125rem, h-3 min-w-3 px-0.5 text-5xs).
                <View class="absolute h-3 min-w-3 items-center justify-center rounded-full border px-0.5" style={{ right: -2, bottom: -2, backgroundColor: meta()!.accentColor ?? String(token("card")), borderColor: String(token("card")) }} testID="Subagent instance badge">
                  <Text class="text-[8px] font-semibold" style={{ color: meta()!.accentColor ? accentForeground(meta()!.accentColor!) : String(token("muted-foreground")) }}>{instanceInitials(meta()!.displayName)}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
          <Text class="min-w-0 truncate text-sm font-medium text-foreground">{modelLabel()}</Text>
          {props.effort() === null ? null : <Text class="shrink-0 text-sm text-muted-foreground">{props.effort()}</Text>}
        </View>
        <Text class={`min-w-0 truncate ${compact() ? "text-xs" : "text-sm"} text-muted-foreground`} accessibilityLabel={`${modelLabel()} subagent: ${formatProviderSubagentStatus(props.status(), now())}`}>
          {formatProviderSubagentStatus(props.status(), now())}
        </Text>
      </View>
      {width() === null || width()! > 640 ? <Text class="shrink-0 text-sm text-muted-foreground">Runs on its own</Text> : null}
      {props.actions ? props.actions() as never : null}
      {props.onOpenParent ? (
        <View class="h-8 flex-row items-center justify-center gap-1.5 rounded-lg px-2.5 hover:bg-accent" role="button" accessibilityLabel="Open parent" onPress={props.onOpenParent}>
          <Image src={arrowUpLeft} style={{ width: 16, height: 16, tintColor: token("foreground") }} />
          {width() === null || width()! > 320 ? <Text class="text-sm font-medium text-foreground">Open parent</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
