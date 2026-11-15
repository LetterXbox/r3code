// The shape every banner is built into before it is painted: plain data, so the show/hide rules and the copy are
// tested without an engine. BannerLane, ComposerBanners and ThreadNow paint these.
import type { BannerIconName } from "./BannerIcon";

export type BannerVariant = "default" | "error" | "info" | "success" | "warning";
/** Where a composer notice sits in the stack: the machine first, then what needs you (ComposerBannerStack's GROUPS). */
export type BannerGroup = "environment" | "attention";

export interface BannerAction {
  id: string;
  label: string;
  /** "button" is an outlined or ghost Button; "inline" the underlined InlineButton; "muted" the dimmer InlineButton. */
  tone?: "button" | "inline" | "muted";
  disabled?: boolean;
  /** The button's title tooltip. */
  title?: string;
  run: () => void;
}

export interface BannerItem {
  id: string;
  variant: BannerVariant;
  group?: BannerGroup;
  icon: BannerIconName;
  title: string;
  /** useAutoBalanceUpdateBanner: the title opens a popover listing these rows (label, then its detail). */
  titlePopover?: { accessibilityLabel: string; rows: { key: string; label: string; detail: string }[] };
  description?: string;
  actions: BannerAction[];
  /** A live elapsed-time readout shown before the actions (the stop and background-work rows). */
  elapsedSince?: string | number | null;
  dismissLabel?: string;
  onDismiss?: () => void;
}

/** The glass alert pinned under the header (ProviderStatusBanner, ThreadErrorBanner). */
export interface LaneAlert {
  id: string;
  variant: "warning" | "error";
  role: "alert" | "status";
  /** The ChatGPT usage-limit alert shows the OpenAI mark instead of the alert icon. */
  mark: "alert" | "info" | "openai";
  title?: string;
  /** What the alert says; `full` is shown after "Show full error" when the collapsed text differs or is long. */
  message: string;
  full?: string;
  actions: BannerAction[];
  dismissLabel: string;
  onDismiss: () => void;
}
