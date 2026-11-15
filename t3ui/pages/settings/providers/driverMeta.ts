// The provider drivers' client definitions, ported from
// packages/client-runtime/src/providerClients.ts and each provider-*/src/{client,settings}.ts.
// Field titles, descriptions, placeholders and order are the web app's own.
import acpRegistry from "../provider-icons/acpRegistry.svg";
import antigravity from "../provider-icons/antigravity.png";
import claudeAgent from "../provider-icons/claudeAgent.svg";
import codex from "../provider-icons/codex.svg";
import cursor from "../provider-icons/cursor.svg";
import fx from "../provider-icons/fx.svg";
import grok from "../provider-icons/grok.svg";
import kiro from "../provider-icons/kiro.svg";
import muse from "../provider-icons/muse.svg";
import opencode from "../provider-icons/opencode.svg";
import pi from "../provider-icons/pi.svg";

export interface DriverField {
  key: string;
  control: "text" | "password" | "select";
  label: string;
  description?: string;
  placeholder?: string;
  clearWhenEmpty: "omit" | "persist";
  options?: { value: string; label: string }[];
  secret?: boolean;
}

export interface DriverEnvField {
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  sensitive?: boolean;
}

/** One colour per theme; `null` keeps the artwork's own colours. */
export interface DriverTint { light: string; dark: string }

export interface DriverMeta {
  driver: string;
  label: string;
  icon: typeof codex | null;
  tint: DriverTint | null;
  fields: DriverField[];
  envFields: DriverEnvField[];
  /** `false`: the driver has no unconfigured default slot (ACP Registry). */
  hasDefaultInstance: boolean;
  /** `false` lists it under Add provider's "Show more". */
  featured: boolean;
  badgeLabel?: string;
  /** What an unconfigured instance does: Codex and Claude start on, the rest off. */
  defaultEnabled: boolean;
  customModelPlaceholder: string;
  supportsCustomModels: boolean;
}

const binaryPath = (name: string, description: string): DriverField => ({
  key: "binaryPath", control: "text", label: "Binary path", description, placeholder: name, clearWhenEmpty: "omit",
});
const SECRET_HINT = "Stored separately on the host.";

export const ANTIGRAVITY_AUTH_METHODS = [
  { value: "oauth-personal", label: "Google account" },
  { value: "oauth-business", label: "Gemini Enterprise" },
  { value: "gemini-api-key", label: "Gemini API key" },
  { value: "agent-platform", label: "Agent Platform (Vertex AI)" },
];
export const IDLE_COMPACTION_OPTIONS = [
  { value: "default", label: "Use default" },
  { value: "onReturn", label: "When you return" },
  { value: "beforeCacheExpires", label: "Before the cache expires (beta)" },
  { value: "off", label: "Never" },
];

/** Driver order is the web registry's, which is also the list's row order. */
export const DRIVERS: DriverMeta[] = [
  {
    driver: "codex", label: "Codex", icon: codex, tint: { light: "#000000", dark: "#ffffff" },
    fields: [
      binaryPath("codex", "Path to the Codex binary used by this instance."),
      { key: "homePath", control: "text", label: "CODEX_HOME path", description: "Custom Codex home and config directory.", placeholder: "~/.codex", clearWhenEmpty: "omit" },
      { key: "shadowHomePath", control: "text", label: "Shadow home path", description: "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.", placeholder: "~/.codex-t3/personal", clearWhenEmpty: "omit" },
      { key: "launchArgs", control: "text", label: "Launch arguments", description: "Additional CLI arguments passed to codex app-server on session start.", clearWhenEmpty: "omit" },
    ],
    envFields: [], hasDefaultInstance: true, featured: true, defaultEnabled: true,
    customModelPlaceholder: "gpt-6.7-codex-ultra-preview", supportsCustomModels: true,
  },
  {
    driver: "claudeAgent", label: "Claude", icon: claudeAgent, tint: { light: "#d97757", dark: "#d97757" },
    fields: [
      binaryPath("claude", "Path to the Claude binary used by this instance."),
      { key: "homePath", control: "text", label: "CLAUDE_CONFIG_DIR path", description: "Custom Claude home and config directory. Keeps .claude.json and .claude separate.", placeholder: "~/.claude", clearWhenEmpty: "omit" },
      { key: "autoCompactWindow", control: "text", label: "Auto-compact after", description: "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default.", placeholder: "e.g. 300000", clearWhenEmpty: "omit" },
      { key: "idleCompaction", control: "select", label: "Compact idle threads", description: "When to compact an idle thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Overrides the default in Providers > Advanced.", clearWhenEmpty: "omit", options: IDLE_COMPACTION_OPTIONS },
      { key: "launchArgs", control: "text", label: "Launch arguments", description: "Additional CLI arguments passed on session start.", placeholder: "e.g. --chrome", clearWhenEmpty: "omit" },
    ],
    envFields: [], hasDefaultInstance: true, featured: true, defaultEnabled: true,
    customModelPlaceholder: "claude-sonnet-5", supportsCustomModels: true,
  },
  {
    driver: "cursor", label: "Cursor", icon: cursor, tint: { light: "#26251e", dark: "#edecec" },
    fields: [],
    envFields: [{ name: "CURSOR_API_KEY", label: "Cursor API key", description: "Optional. Overrides browser sign-in for this provider.", placeholder: "Paste API key", sensitive: true }],
    hasDefaultInstance: true, featured: true, defaultEnabled: false,
    customModelPlaceholder: "claude-sonnet-4-6", supportsCustomModels: true,
  },
  {
    driver: "grok", label: "Grok", icon: grok, tint: { light: "#0f0f0f", dark: "#f5f5f5" },
    fields: [binaryPath("grok", "Path to the Grok CLI binary.")],
    envFields: [], hasDefaultInstance: true, featured: true, defaultEnabled: false,
    customModelPlaceholder: "model-slug", supportsCustomModels: true,
  },
  {
    driver: "fx", label: "fx", icon: fx, tint: { light: "#0f0f0f", dark: "#f5f5f5" },
    fields: [binaryPath("fx", "Path to the fx binary. All fx instances on this machine share its fx login.")],
    envFields: [], hasDefaultInstance: true, featured: false, defaultEnabled: false,
    customModelPlaceholder: "model-slug", supportsCustomModels: true,
  },
  {
    driver: "opencode", label: "OpenCode", icon: opencode, tint: { light: "#211e1e", dark: "#f1ecec" },
    fields: [
      binaryPath("opencode", "Path to the OpenCode binary."),
      { key: "serverUrl", control: "text", label: "Server URL", description: "Leave blank to let R3 Code spawn the server when needed.", placeholder: "http://127.0.0.1:4096", clearWhenEmpty: "omit" },
      { key: "serverPassword", control: "password", label: "Server password", description: SECRET_HINT, placeholder: "Optional", clearWhenEmpty: "omit", secret: true },
    ],
    envFields: [], hasDefaultInstance: true, featured: true, defaultEnabled: false,
    customModelPlaceholder: "openai/gpt-5", supportsCustomModels: true,
  },
  {
    driver: "antigravity", label: "Antigravity", icon: antigravity, tint: null,
    fields: [
      { key: "authMethod", control: "select", label: "Sign-in method", description: "Google accounts use your subscription; API keys and Agent Platform bill usage.", clearWhenEmpty: "omit", options: ANTIGRAVITY_AUTH_METHODS },
      { key: "apiKey", control: "password", label: "API key", description: "Gemini or Vertex AI express key. Stored separately on the host.", placeholder: "Optional", clearWhenEmpty: "omit", secret: true },
      { key: "gcpProject", control: "text", label: "GCP project", description: "Required for Gemini Enterprise. Agent Platform uses it when no API key is set.", placeholder: "my-project-id", clearWhenEmpty: "omit" },
      { key: "gcpLocation", control: "text", label: "GCP location", description: "Region for Gemini Enterprise or Agent Platform.", placeholder: "us-central1", clearWhenEmpty: "omit" },
      { key: "binaryPath", control: "text", label: "Binary path", description: "Custom ACP executable. Leave empty to select automatically.", placeholder: "Automatic", clearWhenEmpty: "persist" },
    ],
    envFields: [], hasDefaultInstance: true, featured: true, defaultEnabled: false,
    customModelPlaceholder: "model-slug", supportsCustomModels: false,
  },
  {
    driver: "kiro", label: "Kiro", icon: kiro, tint: { light: "#9046ff", dark: "#9046ff" },
    fields: [binaryPath("kiro-cli", "Path to the Kiro CLI binary.")],
    envFields: [{ name: "KIRO_API_KEY", label: "Kiro API key", description: "Optional. Signs in without `kiro-cli login` (Kiro Pro and above).", placeholder: "Paste API key", sensitive: true }],
    hasDefaultInstance: true, featured: false, badgeLabel: "Early Access", defaultEnabled: false,
    customModelPlaceholder: "model-slug", supportsCustomModels: true,
  },
  {
    driver: "muse", label: "Muse Code", icon: muse, tint: { light: "#0081fb", dark: "#0081fb" },
    fields: [binaryPath("muse", "Path to the Muse Code binary on this environment. Sign in with muse login on that host.")],
    envFields: [], hasDefaultInstance: true, featured: true, defaultEnabled: false,
    customModelPlaceholder: "model-slug", supportsCustomModels: true,
  },
  {
    driver: "pi", label: "Pi", icon: pi, tint: { light: "#0f0f0f", dark: "#f5f5f5" },
    fields: [
      binaryPath("pi", "Path to the Pi coding agent binary."),
      { key: "launchArgs", control: "text", label: "Launch arguments", description: "Additional CLI arguments passed to pi --mode rpc on session start.", clearWhenEmpty: "omit" },
    ],
    envFields: [], hasDefaultInstance: true, featured: true, defaultEnabled: false,
    customModelPlaceholder: "anthropic/claude-sonnet-5", supportsCustomModels: true,
  },
  {
    driver: "acpRegistry", label: "ACP Registry", icon: acpRegistry, tint: { light: "#000000", dark: "#ffffff" },
    fields: [
      { key: "source", control: "select", label: "ACP source", clearWhenEmpty: "omit", options: [{ value: "registry", label: "ACP Registry" }, { value: "local", label: "Local command" }] },
      { key: "agentId", control: "text", label: "Registry agent ID", description: "Agent identifier from the official ACP Registry, for example 'devin'.", placeholder: "devin", clearWhenEmpty: "persist" },
      { key: "commandPath", control: "text", label: "Executable override", description: "Executable on this environment. For registry agents, this overrides the distribution executable while keeping its arguments and environment.", placeholder: "Registry default", clearWhenEmpty: "omit" },
      { key: "authMethodId", control: "text", label: "Authentication method", description: "Optional ACP authentication method ID. By default, the first agent-managed method is selected.", placeholder: "auto", clearWhenEmpty: "omit" },
    ],
    envFields: [], hasDefaultInstance: false, featured: false, defaultEnabled: true,
    customModelPlaceholder: "model-slug", supportsCustomModels: true,
  },
];

const BY_DRIVER = new Map(DRIVERS.map((meta) => [meta.driver, meta]));
export function driverMeta(driver: string): DriverMeta | undefined { return BY_DRIVER.get(driver); }
export function driverLabel(driver: string): string { return BY_DRIVER.get(driver)?.label ?? driver; }

/** The form fields a config shows; a local ACP command only has a source and an executable. */
export function deriveFields(meta: DriverMeta, config: unknown): DriverField[] {
  const record = config !== null && typeof config === "object" ? config as Record<string, unknown> : {};
  const localAcp = meta.driver === "acpRegistry" && record.source === "local";
  if (!localAcp) return meta.fields;
  return meta.fields.filter((field) => field.key === "source" || field.key === "commandPath").map((field) =>
    field.key === "commandPath" ? { ...field, label: "Executable", description: "Executable name or path on this environment.", placeholder: "e.g. dsh" } : field);
}
