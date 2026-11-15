// The live inputs of openFolderInEditor: the open thread's machine, its server config and label.
import { openUrl } from "nsh";
import { openThread } from "../../store";
import { environmentConfigs, managedEnvironment } from "../../environments/connectionManager";
import { openInEditor } from "./gitRuntime";
import { Storage } from "nsh";
import { openFolderInEditor, resolveRemoteOpenState, type RemoteOpenState } from "./remoteOpen";

export function openThreadFolderInEditor(cwd: string, editor: string, request: (method: string, payload: unknown) => Promise<unknown>): Promise<void> {
  const environmentId = openThread()?.environmentId ?? null;
  return openFolderInEditor({
    cwd, editor, environmentId,
    environmentLabel: environmentId ? managedEnvironment(environmentId)?.label : undefined,
    config: environmentId ? environmentConfigs()[environmentId] : null,
    launchLocal: () => openInEditor(cwd, editor, request),
    openUrl: (url) => openUrl(url),
  });
}

export function threadRemoteOpenState(): RemoteOpenState {
  const environmentId = openThread()?.environmentId ?? null;
  return resolveRemoteOpenState(environmentId, environmentId ? environmentConfigs()[environmentId] : null);
}
export const threadEnvironmentLabel = (): string | null => { const id = openThread()?.environmentId; return id ? managedEnvironment(id)?.label ?? null : null; };

// useRemoteOpenHint: "Opens over SSH. Needs your key on <machine>" shows in the picker until the first remote open.
const HINT_KEY = "t3code:remote-open-hint-seen";
export const remoteOpenHintSeen = (): Promise<boolean> => Storage.getItem(HINT_KEY).then((value) => value === "true", () => false);
export function markRemoteOpenHintSeen() { void Storage.setItem(HINT_KEY, "true").catch(() => {}); }
