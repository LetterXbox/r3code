// PullRequestStackPopover.tsx: a list row's stack mark ("3/5"); opening it reads the stack (only then, so the list does
// not fetch one per row) and lists its layers, the open one marked, each opening that pull request.
import { signal, Text, View } from "nsh";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import { parseStack, type PullRequestStackData } from "./pullRequestDetail.logic";

export function PullRequestStackPopover(props: {
  reference: { projectId: string; host?: string; repository: string; number: number };
  membership: { number: number; position: number; size: number };
  request: (method: string, payload: unknown) => Promise<unknown>;
  onSelect: (number: number) => void;
}) {
  const open = signal(false);
  const anchor = createAnchor();
  const stack = signal<PullRequestStackData | null>(null);
  const status = signal<"loading" | "loaded" | "error">("loading");
  const error = signal("");
  async function load() {
    status.set("loading");
    try {
      stack.set(parseStack(await props.request("pullRequests.stack", props.reference)));
      status.set("loaded");
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
      status.set("error");
    }
  }
  const label = `Stack ${props.membership.number}, layer ${props.membership.position} of ${props.membership.size}`;
  return (
    <View>
      <View
        ref={anchor.ref}
        role="button"
        accessibilityLabel={label}
        tooltip={`View stack #${props.membership.number}, layer ${props.membership.position} of ${props.membership.size}`}
        onPress={() => { const next = !open(); open.set(next); if (next) void load(); }}
        class="shrink-0 flex-row items-center gap-1"
      >
        <PRIcon name="layers" size={12} />
        <Text class="text-xs text-muted-foreground">{`${props.membership.position}/${props.membership.size}`}</Text>
      </View>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="start" class="min-w-56 max-w-80">
          <View class="flex-col p-1">
            <Text class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{`Stack #${stack()?.number || props.membership.number}`}</Text>
            {stack() !== null ? [...stack()!.layers].reverse().map((layer) => (
              <View
                role="button"
                accessibilityLabel={`Open #${layer.number}`}
                accessibilityState={{ selected: layer.number === props.reference.number }}
                onPress={() => { open.set(false); props.onSelect(layer.number); }}
                class={`min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1 ${layer.number === props.reference.number ? "bg-accent" : "hover:bg-accent-50"}`}
              >
                <Text class="shrink-0 text-xs tabular-nums text-muted-foreground">{`#${layer.number}`}</Text>
                <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{layer.title || layer.headBranch}</Text>
              </View>
            )) : (
              <Text class="px-2 py-1.5 text-xs text-muted-foreground">{status() === "error" ? error() : status() === "loading" ? "Loading stack…" : "This pull request is no longer in a stack."}</Text>
            )}
          </View>
        </Popup>
      ) : null}
    </View>
  );
}
