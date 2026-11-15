// Ported from apps/web/src/components/chat/runtimeModeConfig.ts. Labels and
// descriptions are the web app's own; `icon` is the ComposerIcon name for the
// lucide mark it uses (Lock, PenLine, Sparkles, ShieldOff).
import type { RuntimeMode } from "../../store";
import type { BannerItem } from "../banners/bannerTypes";
import { managedRuntimeModeDenial } from "../../pages/settings/managedPolicyLocks";

export const runtimeModeConfig: Record<RuntimeMode, { label: string; description: string; icon: string }> = {
  "approval-required": { label: "Supervised", description: "Ask before commands and file changes.", icon: "lock" },
  "auto-accept-edits": { label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions.", icon: "pen-line" },
  auto: { label: "Auto", description: "Supported providers approve routine actions; others still ask.", icon: "sparkles" },
  "full-access": { label: "Full access", description: "Allow commands and edits without prompts.", icon: "shield-off" },
};

export const INTERACTION_LABELS = { default: "Default", plan: "Plan" } as const;

/** resolveRuntimeModeOptions: every mode the provider supports, those above the administrator's ceiling disabled with
 * why (managedRuntimeModeDenial, "<organization> limits threads to <mode>."). */
export function runtimeModeOptions(modes: readonly RuntimeMode[], policy: Record<string, unknown> | null): { mode: RuntimeMode; disabledReason?: string }[] {
  return modes.map((mode) => { const denied = managedRuntimeModeDenial(policy, mode); return denied === undefined ? { mode } : { mode, disabledReason: denied }; });
}

/**
 * ChatComposer's "managed-runtime-mode" notice: the thread's mode is above the ceiling, so a send would be refused. It
 * reads the denial and offers "Switch to <the broadest mode left>" (clampManagedRuntimeMode over the provider's modes).
 */
export function managedRuntimeModeItem(input: { policy: Record<string, unknown> | null; mode: RuntimeMode; modes: readonly RuntimeMode[]; onSwitch: (mode: RuntimeMode) => void }): BannerItem | null {
  const denied = managedRuntimeModeDenial(input.policy, input.mode);
  if (denied === undefined) return null;
  const fallback = [...input.modes].reverse().find((mode) => managedRuntimeModeDenial(input.policy, mode) === undefined);
  return {
    id: "managed-runtime-mode", variant: "warning", icon: "building", title: denied,
    actions: fallback === undefined ? [] : [{ id: "switch", label: `Switch to ${runtimeModeConfig[fallback].label}`, tone: "button", run: () => input.onSwitch(fallback) }],
  };
}
