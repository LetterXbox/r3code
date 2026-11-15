// PublishRepositoryDialog (GitActionsControl.tsx): a three-step wizard (Provider, Repository, Summary) that
// creates the repository on a host and pushes the branch (`sourceControl.publishRepository`). The provider
// cards come from `server.discoverSourceControl`: one that is not installed or signed in shows "Setup Required".
import { effect, openUrl, signal, Text, View } from "nsh";
import { Dialog, Tooltip } from "nsh/base";
import { DialogInput as Input } from "../DialogInput";
import { HIcon } from "./HeaderIcons";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";
import { DIALOG_MS } from "../motion/motionTokens";
import { WizardSteps } from "../../pages/settings/providers/ui";
import { changeRequestIconName } from "./gitLogic";
import type { Request } from "./gitRuntime";
import { DialogCloseButton } from "../DialogCloseButton";
import {
  canSubmitPublish, publishHostFor, publishProviderOption, publishProviderReadiness, publishRepository, publishRepositoryPrefill, publishSummaryCopy,
  readPublishDiscovery, resolvePublishProvider, sortPublishProviders, type PublishDiscoveredProvider, type PublishResult,
} from "./publishRepository";

export const PUBLISH_DIALOG_COPY = {
  title: "Publish repository",
  description: "Pick where to host it, then point us at a repo to push to.",
  steps: ["Provider", "Repository", "Summary"],
} as const;

const cardBase = "relative flex-row items-center gap-3 rounded-lg border px-3";
const cardClass = (selected: boolean) => `${cardBase} ${selected ? "border-primary bg-background" : "border-border bg-background hover:bg-accent-50"}`;
const buttonClass = "h-8 items-center justify-center rounded-lg px-3";

export function PublishRepositoryDialog(props: {
  open: () => boolean;
  cwd: () => string | null;
  request: Request;
  /** The connection may change source control. */
  canWrite?: () => boolean;
  onClose: () => void;
  /** Settings -> Source control, for a provider that needs setup. */
  onOpenSettings: () => void;
}) {
  useOverlayOpen(() => props.open(), "publish repository dialog", DIALOG_MS);
  const discovered = signal<PublishDiscoveredProvider[]>([]);
  const step = signal(0);
  const selected = signal<string | null>(null);
  const repositoryOverride = signal<string | null>(null);
  const visibility = signal<"private" | "public">("private");
  const remoteName = signal("origin");
  const protocol = signal<"ssh" | "https">("ssh");
  const advanced = signal(false);
  const error = signal<string | null>(null);
  const result = signal<PublishResult | null>(null);
  const pending = signal(false);

  // The discovery query runs while the dialog is open, as the web's does while its Git actions row is shown.
  effect(() => {
    if (!props.open()) return;
    let live = true;
    void props.request("server.discoverSourceControl", {}).then((value) => { if (live) discovered.set(readPublishDiscovery(value)); }).catch(() => { if (live) discovered.set([]); });
    return () => { live = false; };
  });

  const provider = () => resolvePublishProvider(selected(), discovered());
  const readiness = () => publishProviderReadiness(provider(), discovered());
  const providers = () => sortPublishProviders(discovered());
  const hasReadyProvider = () => providers().some((option) => publishProviderReadiness(option.kind, discovered()).ready);
  const repository = () => repositoryOverride() ?? publishRepositoryPrefill(provider(), discovered());
  const providerLabel = () => publishProviderOption(provider()).label;
  const canSubmit = () => canSubmitPublish({ allowed: props.canWrite?.() ?? true, ready: readiness().ready, pending: pending(), repository: repository() });

  const reset = () => {
    step.set(0); selected.set(null); repositoryOverride.set(null); visibility.set("private"); remoteName.set("origin"); protocol.set("ssh");
    advanced.set(false); error.set(null); result.set(null); pending.set(false);
  };
  const close = () => { props.onClose(); reset(); };

  function submit() {
    const cwd = props.cwd();
    if (!canSubmit() || !cwd) return;
    error.set(null);
    pending.set(true);
    void publishRepository(cwd, { provider: provider(), repository: repository(), visibility: visibility(), remoteName: remoteName(), protocol: protocol() }, props.request)
      .then((done) => { pending.set(false); result.set(done); step.set(2); })
      .catch((cause: unknown) => { pending.set(false); error.set(cause instanceof Error ? cause.message : "An error occurred."); });
  }

  const summaries = () => [providerLabel(), result()?.repository.nameWithOwner ?? null, null] as const;
  const stepNames = () => PUBLISH_DIALOG_COPY.steps.map((name, index) => (index < step() && summaries()[index] ? `${name}: ${summaries()[index]}` : name));

  const radio = (value: string, label: string, selectedValue: boolean, onSelect: () => void, body: any, disabled = false) => (
    <View role="radio" accessibilityLabel={label} accessibilityState={{ checked: selectedValue, disabled }} disabled={disabled} onPress={onSelect} class={cardClass(selectedValue)} testID={`Publish ${value}`}>{body}</View>
  );

  return (
    <Dialog
      open={props.open()}
      animation="fade"
      onOpenChange={({ open }) => { if (!open) close(); }}
      backdropStyle={dialogBackdropStyle()}
      style={[{ margin: "auto", width: 576, maxWidth: "92%" }, dialogPopupMotion(props.open)]}
    >
      <View class="relative overflow-hidden rounded-2xl border border-border bg-background" role="group" accessibilityLabel={PUBLISH_DIALOG_COPY.title} onPress={keepPressInDialog}>
        <DialogCloseButton onClose={close} />
        <View class="gap-4 px-6 pb-4 pt-6">
          <View class="gap-1.5">
            <Text class="text-lg font-semibold text-foreground">{PUBLISH_DIALOG_COPY.title}</Text>
            <Text class="text-sm text-muted-foreground">{PUBLISH_DIALOG_COPY.description}</Text>
          </View>
          <WizardSteps steps={stepNames()} current={step()} isDisabled={(index) => step() === 2 || index >= PUBLISH_DIALOG_COPY.steps.length - 1 || index > step()} onChange={(index) => step.set(index)} />
        </View>
        <View class="gap-4 bg-card-40 px-6 py-5">
          {step() === 0 ? (
            <View class="gap-2">
              <Text class="text-xs font-medium text-foreground">Provider</Text>
              <View class="flex-row flex-wrap gap-2" role="radiogroup" accessibilityLabel="Provider">
                <Each of={providers()} key={(option) => option.kind}>
                  {(option) => publishProviderReadiness(option().kind, discovered()).ready
                    ? <View class="w-[48%]">{radio(option().kind, option().label, provider() === option().kind, () => { selected.set(option().kind); repositoryOverride.set(null); }, <>
                      <HIcon name={changeRequestIconName(option().kind)} size={20} />
                      <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{option().label}</Text>
                    </>)}</View>
                    : <View class={`w-[48%] ${cardBase} border-border bg-background py-3 opacity-64`}>
                      <HIcon name={changeRequestIconName(option().kind)} size={20} />
                      <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{option().label}</Text>
                      <View
                        role="button"
                        accessibilityLabel="Setup Required"
                        onPress={() => { close(); props.onOpenSettings(); }}
                        tooltip={<Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{publishProviderReadiness(option().kind, discovered()).hint ?? "Open Settings -> Source control to configure this provider."}</Text></Tooltip>}
                        class="rounded-md border border-warning px-1.5 py-0.5"
                      >
                        <Text class="text-xs font-medium text-warning-foreground">Setup Required</Text>
                      </View>
                    </View>}
                </Each>
              </View>
            </View>
          ) : null}
          {step() === 1 ? (
            <View class="gap-5">
              <View class="gap-2">
                <Text class="text-xs font-medium text-foreground">Repository</Text>
                <View class="flex-row items-stretch overflow-hidden rounded-md border border-input bg-background">
                  <View class="flex-row items-center gap-1.5 border-r border-input bg-accent-50 px-2.5">
                    <HIcon name={changeRequestIconName(provider())} size={14} />
                    <Text class="font-mono text-xs text-muted-foreground">{`${publishHostFor(provider(), discovered())}/`}</Text>
                  </View>
                  <Input
                    accessibilityLabel="Repository"
                    value={repository()}
                    placeholder={publishProviderOption(provider()).pathPlaceholder}
                    disabled={pending()}
                    onChange={(event) => repositoryOverride.set(event.value)}
                    onSubmit={submit}
                    class="flex-1 bg-transparent px-3 py-2 font-mono text-sm text-foreground"
                  />
                </View>
              </View>
              <View class="gap-2">
                <Text class="text-xs font-medium text-foreground">Visibility</Text>
                <View class="flex-row gap-2" role="radiogroup" accessibilityLabel="Visibility">
                  {([["private", "Private", "Only invited people", "lock"], ["public", "Public", "Anyone on the web", "globe"]] as const).map(([value, label, description, icon]) => (
                    <View class="w-[48%]">{radio(value, label, visibility() === value, () => visibility.set(value), <>
                      <HIcon name={icon} size={16} />
                      <View class="min-w-0 flex-1">
                        <Text class="text-sm font-medium text-foreground">{label}</Text>
                        <Text class="text-xs text-muted-foreground">{description}</Text>
                      </View>
                    </>, pending())}</View>
                  ))}
                </View>
              </View>
              <View class="gap-3">
                <View role="button" accessibilityLabel="Advanced" accessibilityState={{ expanded: advanced() }} onPress={() => advanced.update((value) => !value)} class="flex-row items-center gap-1 self-start">
                  <View class={advanced() ? "" : "-rotate-90"}><HIcon name="chevron-down" size={14} /></View>
                  <Text class="text-xs font-medium text-muted-foreground">Advanced</Text>
                </View>
                {advanced() ? (
                  <View class="flex-row gap-3">
                    <View class="min-w-0 flex-1 gap-1.5">
                      <Text class="text-xs font-medium text-foreground">Remote</Text>
                      <Input accessibilityLabel="Remote" value={remoteName()} placeholder="origin" disabled={pending()} onChange={(event) => remoteName.set(event.value)} class="h-8 rounded-lg border border-input bg-background px-3 text-sm text-foreground" />
                    </View>
                    <View class="min-w-0 flex-1 gap-1.5">
                      <Text class="text-xs font-medium text-foreground">Protocol</Text>
                      <View class="flex-row gap-1" role="radiogroup" accessibilityLabel="Protocol">
                        {(["ssh", "https"] as const).map((value) => (
                          <View role="radio" accessibilityLabel={value === "ssh" ? "SSH" : "HTTPS"} accessibilityState={{ checked: protocol() === value }} disabled={pending()} onPress={() => protocol.set(value)}
                            class={`h-9 items-center justify-center rounded-lg border px-3 ${protocol() === value ? "border-primary bg-accent" : "border-input hover:bg-accent-50"}`}>
                            <Text class="text-sm text-foreground">{value === "ssh" ? "SSH" : "HTTPS"}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  </View>
                ) : null}
              </View>
              {pending() ? (
                <View role="alert" class="flex-row items-center gap-2 rounded-md border border-input bg-card-40 px-3 py-2">
                  <HIcon name="loader-circle" size={14} />
                  <Text class="text-xs text-muted-foreground">{`Publishing repository to ${providerLabel()}...`}</Text>
                </View>
              ) : null}
              {error() && !pending() ? (
                <View role="alert" class="rounded-md border border-destructive bg-card-40 px-3 py-2">
                  <Text class="text-xs font-medium text-destructive-foreground">Publish failed</Text>
                  <Text class="mt-0.5 text-xs text-destructive-foreground">{error()}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {step() === 2 ? (
            <View class="gap-4">
              {result() ? (
                <>
                  <View class="items-center gap-2 py-1">
                    <View class="size-8 items-center justify-center rounded-full bg-accent"><HIcon name="check" size={16} /></View>
                    <Text class="text-sm font-semibold text-foreground">{publishSummaryCopy(result()!, providerLabel()).title}</Text>
                    <Text class="max-w-xs text-center text-xs text-muted-foreground">{publishSummaryCopy(result()!, providerLabel()).body}</Text>
                  </View>
                  <View class="flex-row items-center gap-2 rounded-lg border border-input bg-card-40 px-3 py-2">
                    <HIcon name={changeRequestIconName(provider())} size={14} />
                    <Text class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{result()!.repository.nameWithOwner}</Text>
                  </View>
                  <View role="button" accessibilityLabel={`Open on ${providerLabel()}`} onPress={() => { void openUrl(result()!.repository.url).catch(() => {}); }} class="h-8 w-full items-center justify-center rounded-lg border border-input hover:bg-accent">
                    <Text class="text-sm text-foreground">{`Open on ${providerLabel()}`}</Text>
                  </View>
                </>
              ) : (
                <View class="rounded-md border border-input bg-background px-3 py-2"><Text class="text-xs text-muted-foreground">Publish result unavailable.</Text></View>
              )}
            </View>
          ) : null}
        </View>
        <View class="flex-row justify-end gap-2 px-6 py-4">
          {step() === 2 ? (
            <View role="button" accessibilityLabel="Done" onPress={close} class={`${buttonClass} bg-primary`}><Text class="text-sm font-medium text-primary-foreground">Done</Text></View>
          ) : (
            <>
              <View role="button" accessibilityLabel={step() === 0 ? "Cancel" : "Back"} disabled={pending()} onPress={() => { if (step() === 0) close(); else step.update((value) => Math.max(0, value - 1)); }} class={`${buttonClass} border border-input ${pending() ? "opacity-64" : "hover:bg-accent"}`}>
                <Text class="text-sm text-foreground">{step() === 0 ? "Cancel" : "Back"}</Text>
              </View>
              {step() < 1 ? (
                <View role="button" accessibilityLabel="Next" disabled={!hasReadyProvider() || !readiness().ready} onPress={() => step.update((value) => Math.min(1, value + 1))} class={`${buttonClass} bg-primary ${!hasReadyProvider() || !readiness().ready ? "opacity-64" : ""}`}>
                  <Text class="text-sm font-medium text-primary-foreground">Next</Text>
                </View>
              ) : (
                <View role="button" accessibilityLabel={pending() ? "Publishing..." : "Publish"} disabled={!canSubmit()} onPress={submit} class={`${buttonClass} bg-primary flex-row gap-2 ${canSubmit() ? "" : "opacity-64"}`}>
                  {pending() ? <HIcon name="loader-circle" size={14} /> : null}
                  <Text class="text-sm font-medium text-primary-foreground">{pending() ? "Publishing..." : "Publish"}</Text>
                </View>
              )}
            </>
          )}
        </View>
      </View>
    </Dialog>
  );
}
