// AddProjectToMachineDialog / AddProjectToMachineDialogHost (apps/web/src/components/AddProjectToMachineDialog.tsx):
// "Add to another machine" clones a project onto another connected machine and relays the ignored files chosen.
import { MiddleTruncate } from "../components/MiddleTruncate";
import { effect, signal, Text, token, untracked, View } from "nsh";
import { allProjects, createThread, type Project } from "../store";
import { SettingsDialog, DialogField } from "../components/SettingsDialog";
import { SettingsButton } from "../components/SettingsLayout";
import { DialogInput as Input } from "../components/DialogInput";
import { Glyph } from "../components/sidebar/SidebarGlyph";
import { formatBytes } from "../components/thread/mediaLayout";
import { getAddProjectInitialQuery, getCloneDestinationPath, getCloneDirectoryPath } from "../components/palette/addProject/addProjectLogic";
import { record } from "../backend/client";
import {
  COPYABLE_FILE_MAX_BYTES, addProjectToMachine, cloneUrlForProtocol, cloneUrlProtocol, defaultSelection, projectSubdirectory,
  type CloneProtocol, type IgnoredFile,
} from "./addProjectToMachine";
import { connectedMachines, machineOfProject, type Machine } from "./machines";

interface Request { projectId: string; targetKey: string | null }
const request = signal<Request | null>(null);
const session = signal(0);

/** Opens the dialog that clones a project onto another connected machine. */
export function openAddProjectToMachine(next: Request) {
  if (!allProjects().some((project) => project.id === next.projectId)) return;
  request.set(next);
  session.update((n) => n + 1);
}
const close = () => request.set(null);
export const addProjectToMachineRequest = () => request();

/** The machines a project can be added to: every connected one but its own. */
export function addProjectTargets(project: Project | null): Machine[] {
  if (!project) return [];
  const own = machineOfProject(project)?.key ?? null;
  return connectedMachines().filter((machine) => machine.key !== own);
}

const repositoryUrl = (project: Project) => {
  const identity = record(project.repositoryIdentity);
  const origin = record(identity?.origin);
  const locator = record(identity?.locator);
  return typeof origin?.remoteUrl === "string" ? origin.remoteUrl : typeof locator?.remoteUrl === "string" ? locator.remoteUrl : "";
};

function waitForProject(id: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (allProjects().some((project) => project.id === id)) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  });
}

export function AddProjectToMachineDialogHost() {
  return () => {
    const current = request();
    session();
    return current ? <AddProjectToMachineDialog request={current} /> : null;
  };
}

function AddProjectToMachineDialog(props: { request: Request }) {
  const project = () => allProjects().find((item) => item.id === props.request.projectId) ?? null;
  // The request ends when its project goes away.
  effect(() => { if (!project()) untracked(close); });
  const targets = () => addProjectTargets(project());
  const targetKey = signal(props.request.targetKey);
  const target = () => targets().find((item) => item.key === targetKey()) ?? targets()[0] ?? null;
  const source = () => (project() ? machineOfProject(project()!) : null);
  const sourceUrl = () => (project() ? repositoryUrl(project()!) : "");
  const protocol = signal<CloneProtocol | null>(cloneUrlProtocol(untracked(sourceUrl)));
  const sshUrl = () => cloneUrlForProtocol(sourceUrl(), "ssh");
  const httpsUrl = () => cloneUrlForProtocol(sourceUrl(), "https");
  const remoteUrl = () => (protocol() === "ssh" ? sshUrl() : protocol() === "https" ? httpsUrl() : null) ?? sourceUrl();
  const defaultPath = () => {
    const settings = target()?.settings();
    const base = typeof settings?.addProjectBaseDirectory === "string" ? settings.addProjectBaseDirectory : null;
    return getCloneDestinationPath(getAddProjectInitialQuery(base), getCloneDirectoryPath(sourceUrl(), settings?.ghqCloneLayout === true));
  };
  const pathOverride = signal<string | null>(null);
  const destinationPath = () => pathOverride() ?? defaultPath();

  const canListFiles = () => source()?.capabilities()?.ignoredFileListing === true;
  const files = signal<IgnoredFile[]>([]);
  const filesState = signal<"loading" | "ready" | "error">("loading");
  const filesError = signal<string | null>(null);
  const truncated = signal(false);
  const selected = signal<Set<string> | null>(null);
  const selection = () => selected() ?? defaultSelection(files());
  effect(() => {
    const from = source();
    const cwd = project()?.path;
    if (!from || !cwd || !canListFiles()) return;
    untracked(() => {
      void from.request("projects.listIgnoredFiles", { cwd }).then((value) => {
        const result = record(value);
        const list = Array.isArray(result?.files) ? result!.files.map(record).flatMap((item) =>
          item && typeof item.path === "string" && typeof item.byteLength === "number" ? [{ path: item.path, byteLength: item.byteLength }] : []) : [];
        files.set(list);
        truncated.set(result?.truncated === true);
        filesState.set("ready");
      }).catch((error: unknown) => { filesError.set(error instanceof Error ? error.message : String(error)); filesState.set("error"); });
    });
  });
  const copyable = () => files().filter((file) => file.byteLength <= COPYABLE_FILE_MAX_BYTES);
  const selectedBytes = () => files().filter((file) => selection().has(file.path)).reduce((total, file) => total + file.byteLength, 0);
  const toggle = (path: string) => {
    const next = new Set(selection());
    if (next.has(path)) next.delete(path); else next.add(path);
    selected.set(next);
  };

  const submitting = signal(false);
  const error = signal<string | null>(null);
  const unavailable = () => project() === null || target() === null || (canListFiles() && filesState() === "loading");

  const submit = async () => {
    const from = project();
    const to = target();
    const origin = source();
    if (!from || !to || !origin || submitting()) return;
    if (destinationPath().trim().length === 0) { error.set("Choose a folder on the other machine."); return; }
    submitting.set(true);
    error.set(null);
    const projectId = crypto.randomUUID();
    try {
      const identity = record(from.repositoryIdentity);
      await addProjectToMachine({
        source: { request: origin.request, cwd: from.path ?? "" },
        subdirectory: projectSubdirectory(typeof identity?.rootPath === "string" ? identity.rootPath : undefined, from.path ?? ""),
        target: { request: to.request, subscribe: to.subscribe, label: to.label, key: to.key },
        projectId, title: from.name, remoteUrl: remoteUrl(), destinationPath: destinationPath().trim(),
        files: files().filter((file) => selection().has(file.path)).map((file) => file.path),
      });
      close();
      const id = to.scope(projectId);
      void waitForProject(id, 5000).then((found) => { if (found) createThread(id); });
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : "Could not start the clone.");
      submitting.set(false);
    }
  };

  const machineLine = (label: string, machine: "laptop" | "server", path: string) => (
    <View class="min-w-0 flex-1 gap-1">
      <View class="min-w-0 flex-row items-center gap-1.5">
        <Glyph name={machine} size={14} tint={token("foreground")} />
        <Text class="min-w-0 truncate text-sm font-medium text-foreground">{label}</Text>
      </View>
      <Text class="min-w-0 truncate font-mono text-xs text-muted-foreground">{path}</Text>
    </View>
  );

  return (
    <SettingsDialog
      open
      onClose={close}
      width={576}
      title="Add to another machine"
      description={`Clone ${(record(project()?.repositoryIdentity)?.displayName as string | undefined) ?? project()?.name ?? ""} and bring the local files git does not track.`}
      footer={<>
        <SettingsButton label="Cancel" onPress={close} />
        <SettingsButton tone="primary" label={submitting() ? "Starting…" : `Clone to ${target()?.label ?? "machine"}`} disabled={unavailable() || submitting()} onPress={() => void submit()} />
      </>}
    >
      <View class="flex-row items-center gap-3">
        {machineLine(source()?.label ?? "This machine", source()?.machine ?? "laptop", project()?.path ?? "")}
        <View class="w-28 items-center gap-0.5">
          <Text class="text-xs text-muted-foreground">git clone</Text>
          <Glyph name="arrow-right" size={14} tint={token("muted-foreground")} />
          <Text class="text-xs text-muted-foreground">{selection().size === 0 ? "no files" : `+ ${selection().size} ${selection().size === 1 ? "file" : "files"}`}</Text>
        </View>
        <View class="min-w-0 flex-1 gap-1">
          {targets().length > 1 ? (
            <View class="flex-row flex-wrap gap-1" accessibilityLabel="Machine to add the project to">
              <Each of={targets()} key={(item) => item.key}>
                {(item) => (
                  <View role="button" accessibilityLabel={item().label} onPress={() => targetKey.set(item().key)}
                    class={`h-7 flex-row items-center gap-1.5 rounded-md border border-input px-2 ${target()?.key === item().key ? "bg-accent" : "hover:bg-accent"}`}>
                    <Glyph name={item().machine} size={12} tint={token("foreground")} />
                    <Text class="text-sm text-foreground">{item().label}</Text>
                  </View>
                )}
              </Each>
            </View>
          ) : (
            <View class="min-w-0 flex-row items-center gap-1.5">
              {target() ? <Glyph name={target()!.machine} size={14} tint={token("foreground")} /> : null}
              <Text class="min-w-0 truncate text-sm font-medium text-foreground">{target()?.label ?? "No machine available"}</Text>
            </View>
          )}
          <MiddleTruncate value={destinationPath()} textClass="font-mono text-xs text-muted-foreground" />
        </View>
      </View>

      <DialogField label="Clone over">
        {sshUrl() && httpsUrl() ? (
          <View class="flex-row gap-1" accessibilityLabel="Clone protocol">
            {(["ssh", "https"] as const).map((value) => (
              <View role="button" accessibilityLabel={value === "ssh" ? "SSH" : "HTTPS"} onPress={() => protocol.set(value)}
                class={`h-7 items-center justify-center rounded-md border border-input px-2.5 ${protocol() === value ? "bg-accent" : "hover:bg-accent"}`}>
                <Text class="text-sm text-foreground">{value === "ssh" ? "SSH" : "HTTPS"}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <Text class="truncate font-mono text-xs text-muted-foreground">{remoteUrl()}</Text>
      </DialogField>

      <DialogField label={`Folder on ${target()?.label ?? "the other machine"}`}>
        <Input accessibilityLabel="Destination folder" value={destinationPath()} onChange={(event) => pathOverride.set(event.value)} class="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground" />
      </DialogField>

      {canListFiles() ? (
        <View class="gap-1.5">
          <View class="flex-row items-center gap-2">
            <Text class="flex-1 text-xs font-medium text-foreground">Copy ignored files</Text>
            {copyable().length > 0 ? (
              <>
                <Text class="text-xs text-muted-foreground">{`${selection().size} of ${files().length}${selectedBytes() > 0 ? ` · ${formatBytes(selectedBytes())}` : ""}`}</Text>
                <SettingsButton label={selection().size === copyable().length ? "None" : "All"}
                  onPress={() => selected.set(selection().size === copyable().length ? new Set() : new Set(copyable().map((file) => file.path)))} />
              </>
            ) : null}
          </View>
          {filesState() === "error" ? (
            <Text class="text-xs text-destructive-foreground">{filesError() ?? ""}</Text>
          ) : files().length === 0 ? (
            <Text class="text-xs text-muted-foreground">{filesState() === "ready" ? "No ignored files to copy." : "Finding ignored files…"}</Text>
          ) : (
            <View class="rounded-md border border-border">
              <Each of={files()} key={(file) => file.path}>
                {(file) => {
                  const tooLarge = () => file().byteLength > COPYABLE_FILE_MAX_BYTES;
                  return (
                    <View role="checkbox" accessibilityLabel={file().path} disabled={tooLarge()} onPress={() => { if (!tooLarge()) toggle(file().path); }}
                      class={`flex-row items-center gap-2 border-b border-border px-2.5 py-1.5 ${tooLarge() ? "opacity-64" : ""}`}>
                      <View class={`size-4 items-center justify-center rounded border border-input ${selection().has(file().path) ? "bg-primary" : ""}`}>
                        {selection().has(file().path) ? <Glyph name="check" size={10} tint={token("primary-foreground")} /> : null}
                      </View>
                      <Text class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{file().path}</Text>
                      <Text class="text-xs text-muted-foreground">{tooLarge() ? "Over 1 MB" : formatBytes(file().byteLength)}</Text>
                    </View>
                  );
                }}
              </Each>
            </View>
          )}
          {truncated() ? <Text class="text-xs text-muted-foreground">{`Showing the first ${files().length} files.`}</Text> : null}
          <Text class="text-xs text-muted-foreground">Files are copied after the clone finishes. Folders git ignores whole, like node_modules, are left out.</Text>
        </View>
      ) : null}

      {error() ? <Text class="text-sm text-destructive-foreground">{error()}</Text> : null}
    </SettingsDialog>
  );
}
