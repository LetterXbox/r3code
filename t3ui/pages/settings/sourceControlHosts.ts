// The settings forms of the source control hosts that have `settings` but no `credentials` (the web's
// SourceControlHostSettings.tsx over each definition's settings schema): Bitbucket's three tokens and GitCafe's
// token. Titles and descriptions are the schema annotations of packages/source-control-*/src/shared/definition.ts.
type Dict = Record<string, unknown>;

export interface HostSettingsField { key: string; title: string; description: string; secret: boolean; placeholder?: string }
export interface HostSettingsDefinition { label: string; fields: HostSettingsField[] }

export const HOST_SETTINGS: Record<string, HostSettingsDefinition> = {
  bitbucket: {
    label: "Bitbucket",
    fields: [
      { key: "accessToken", title: "Access token", secret: true, description: "Scoped to one repository, project, or workspace. Create it in that item's Bitbucket settings." },
      { key: "email", title: "Atlassian account email", secret: false, placeholder: "you@example.com", description: "With an API token instead of an access token." },
      { key: "apiToken", title: "API token", secret: true, description: "Reaches every repository your Atlassian account can. Give it read and write access to repositories and pull requests, and read:user:bitbucket." },
    ],
  },
  gitcafe: {
    label: "GitCafe",
    fields: [
      { key: "token", title: "Token", secret: true, description: "A git.cafe token, used before CAFE_TOKEN and the cafe login, so GitCafe works without the CLI signed in." },
    ],
  },
};

/** `settings.sourceControlHosts[kind]`: every saved field (a secret arrives as a redaction marker). */
export function readHostSettings(settings: Dict | null, kind: string): Record<string, unknown> {
  const mine = (settings?.sourceControlHosts as Dict | undefined)?.[kind];
  return typeof mine === "object" && mine !== null ? { ...(mine as Dict) } : {};
}

/** A field is saved when it holds a non-empty string or a secret reference. */
export const hostFieldSaved = (value: unknown) => (typeof value === "string" ? value.length > 0 : value !== undefined && value !== null);

/** SourceControlHostSettings.save: the patch carries only changed fields, and "" clears one. */
export function hostSettingsPatch(kind: string, fields: Record<string, string>) {
  return { sourceControlHosts: { [kind]: fields } };
}

/** The Remove button clears every field at once. */
export function removeAllPatch(kind: string) {
  return hostSettingsPatch(kind, Object.fromEntries((HOST_SETTINGS[kind]?.fields ?? []).map((field) => [field.key, ""])));
}
